// Settings → Updates.
//
// Split out of General so the release feed has the same top-level home it
// has in PwrGit, and rebuilt around a FOUR-SLOT MATRIX instead of two
// stacked segmented controls.
//
// The two-control shape had a reporting bug baked into it: each control
// could only label itself with the slot the OTHER control was currently
// on, so a build sitting on Beta/Latest read "Beta — Unavailable" while
// Beta/Prerelease held a shipped alpha one click away. Showing all four
// published versions at once removes the class of confusion — every tile
// states its own resolved version, whether or not it is the selected one.
//
// The selection itself is two independent axes on the wire (`updates.train`
// + `updates.channel`); a tile click writes both in one patch. Main derives
// `updates.selectionSource: "user"` from that write, which is what pins the
// pair against the version-derived inference — see `parseUpdates` in
// main/settings/desktop-settings-service.ts.

import { useEffect, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  UPDATE_SLOTS,
  type AppUpdateCheckResult,
  type AppUpdateReleaseInfo,
  type AppUpdateReleaseVersions,
  type AppUpdateStatus,
  type UpdateChannel,
  type UpdateTrain
} from "@pwrsnap/shared";
import { Card } from "../components";
import { dispatch, subscribe } from "../../../lib/pwrsnap";
import { useSettingsContext } from "../SettingsContext";

const TRAIN_LABEL: Record<UpdateTrain, string> = {
  stable: "Stable",
  beta: "Beta"
};

const CHANNEL_LABEL: Record<UpdateChannel, string> = {
  latest: "Latest",
  prerelease: "Prerelease"
};

const SLOT_SUB: Record<`${UpdateTrain}:${UpdateChannel}`, string> = {
  "stable:latest": "Smoke-checked. The default for everyone.",
  "stable:prerelease": "Release candidates for the stable line.",
  "beta:latest": "Beta builds off main.",
  "beta:prerelease": "Newest alpha off main. May not install."
};

/** Tag comparison for the "Installed" chip. Release tags carry a leading
 *  `v`; `app:version` does not. */
function sameVersion(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.trim().replace(/^v/i, "") === b.trim().replace(/^v/i, "");
}

function updateResultText(result: AppUpdateCheckResult): string {
  if (result.status === "skipped") return result.reason;
  if (result.status === "error") return `Update check failed: ${result.message}`;
  if (result.status === "checking") return "Checking for updates...";
  if (result.status === "no-update") return `You're up to date (v${result.version}).`;
  if (result.status === "downloaded") {
    return result.downgrade === true
      ? `v${result.version} ready. Restart to switch.`
      : `Update ready: v${result.version}. Restart to install.`;
  }
  return result.downgrade === true
    ? `Switching to v${result.version}. Downloading in the background.`
    : `Update available: v${result.version}. Downloading in the background.`;
}

function updateStatusText(status: AppUpdateStatus): string | undefined {
  if (status.status === "checking") return "Checking for updates...";
  if (status.status === "available") {
    return status.downgrade === true
      ? `Switching to v${status.version}. Downloading in the background.`
      : `Update available: v${status.version}. Downloading in the background.`;
  }
  if (status.status === "downloading") {
    const percent = status.percent === undefined ? "" : ` (${status.percent}%)`;
    return status.downgrade === true
      ? `Downloading v${status.version}${percent}.`
      : `Downloading update v${status.version}${percent}.`;
  }
  if (status.status === "downloaded") {
    return status.downgrade === true
      ? `v${status.version} ready. Restart to switch.`
      : `Update ready: v${status.version}. Restart to install.`;
  }
  if (status.status === "install-failed") {
    return `Update to v${status.version} did not finish installing. Retry to download it again and restart.`;
  }
  if (status.status === "error") return `Update check failed: ${status.message}`;
  return undefined;
}

type SlotTileProps = {
  train: UpdateTrain;
  channel: UpdateChannel;
  release: AppUpdateReleaseInfo | undefined;
  /** Release read still in flight. Distinct from a slot that answered and
   *  has nothing — "Loading" and "Unavailable" are not the same claim. */
  loading: boolean;
  selected: boolean;
  installed: boolean;
  onSelect: () => void;
};

function SlotTile({
  train,
  channel,
  release,
  loading,
  selected,
  installed,
  onSelect
}: SlotTileProps): ReactElement {
  const version = release?.version;
  const label = `${TRAIN_LABEL[train]} ${CHANNEL_LABEL[channel]}`;
  const headline = version ?? (loading ? "Loading..." : "Unavailable");
  const sub =
    version !== undefined
      ? SLOT_SUB[`${train}:${channel}`]
      : loading
        ? "Reading published releases."
        : // An empty slot explains itself rather than leaving the reader to
          // guess whether the feed broke or simply has nothing yet.
          (release?.unavailableReason ?? "Nothing published here yet.");
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${label} — ${headline}`}
      className={"pss__slot" + (selected ? " is-selected" : "")}
      onClick={onSelect}
    >
      <span className={"pss__slot-ver" + (version === undefined ? " is-empty" : "")}>
        {headline}
      </span>
      <span className="pss__slot-sub">{sub}</span>
      {selected || installed ? (
        <span className="pss__slot-chips">
          {selected ? <span className="pss__slot-chip is-selected">Selected</span> : null}
          {installed ? <span className="pss__slot-chip is-installed">Installed</span> : null}
        </span>
      ) : null}
    </button>
  );
}

export function UpdatesPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const ready = settings !== null;
  // Held locally so a click paints immediately and a second click before
  // the settings broadcast lands cannot be composed from a stale render.
  const [pendingSelection, setPendingSelection] = useState<{
    channel: UpdateChannel;
    train: UpdateTrain;
  }>();
  const channel: UpdateChannel = pendingSelection?.channel ?? settings?.updates.channel ?? "latest";
  const train: UpdateTrain = pendingSelection?.train ?? settings?.updates.train ?? "stable";
  const pinned = settings?.updates.selectionSource === "user";

  const [appVersion, setAppVersion] = useState<string | undefined>();
  const [releaseVersions, setReleaseVersions] = useState<AppUpdateReleaseVersions | undefined>();
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({ status: "idle" });
  const [updateResult, setUpdateResult] = useState<AppUpdateCheckResult | undefined>();
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateRestarting, setUpdateRestarting] = useState(false);
  const [updateRestartError, setUpdateRestartError] = useState<string | undefined>();

  useEffect(() => {
    if (pendingSelection === undefined) return;
    if (
      settings?.updates.channel === pendingSelection.channel &&
      settings?.updates.train === pendingSelection.train
    ) {
      setPendingSelection(undefined);
    }
  }, [pendingSelection, settings?.updates.channel, settings?.updates.train]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [versions, version] = await Promise.all([
        dispatch("app:update:releases", {}),
        dispatch("app:version", {})
      ]);
      if (cancelled) return;
      if (versions.ok) setReleaseVersions(versions.value);
      if (version.ok) setAppVersion(version.value.version);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = subscribe(EVENT_CHANNELS.appUpdateStatus, (payload) => {
      receivedEvent = true;
      if (cancelled) return;
      const next = payload as AppUpdateStatus;
      setUpdateStatus(next);
      if (next.status === "downloaded" || next.status === "install-failed") {
        setUpdateRestartError(undefined);
        setUpdateRestarting(false);
      }
    });
    void (async () => {
      const result = await dispatch("app:update:status", {});
      if (cancelled || receivedEvent || !result.ok) return;
      setUpdateStatus(result.value);
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const selectSlot = (next: { train: UpdateTrain; channel: UpdateChannel }): void => {
    if (!ready) return;
    // Both keys always travel together. Main reads the presence of either
    // as "a person picked this" and pins the pair.
    setPendingSelection(next);
    void patch({ updates: next });
  };

  const updateAction =
    updateStatus.status === "downloaded"
      ? {
          version: updateStatus.version,
          label: updateStatus.downgrade === true ? "Restart to Switch" : "Restart to Update",
          busyLabel: "Restarting...",
          ariaLabel:
            updateStatus.downgrade === true
              ? `Restart to Switch (${updateStatus.version})`
              : `Restart to Update (${updateStatus.version})`
        }
      : updateStatus.status === "install-failed"
        ? {
            version: updateStatus.version,
            label: "Retry Update",
            busyLabel: "Retrying...",
            ariaLabel: `Retry Update (${updateStatus.version})`
          }
        : undefined;
  const liveUpdateStatus = updateStatusText(updateStatus);
  const visibleUpdateStatus =
    liveUpdateStatus ?? (updateResult !== undefined ? updateResultText(updateResult) : undefined);
  const visibleUpdateStatusIsError =
    liveUpdateStatus !== undefined
      ? updateStatus.status === "error"
      : updateResult?.status === "error";

  const checkForUpdates = async (): Promise<void> => {
    setUpdateChecking(true);
    setUpdateResult(undefined);
    try {
      const result = await dispatch("app:update:check", {});
      if (!result.ok) {
        setUpdateResult({ status: "error", message: result.error.message });
        return;
      }
      setUpdateResult(result.value);
      setUpdateStatus(result.value);
      // The check just revalidated main's release cache, so this read is
      // served from memory and costs no GitHub request. It clears any stale
      // Unavailable slot labels left by an earlier failed read.
      const versions = await dispatch("app:update:releases", {});
      if (versions.ok) {
        setReleaseVersions(versions.value);
      }
    } finally {
      setUpdateChecking(false);
    }
  };

  const restartToUpdate = async (): Promise<void> => {
    setUpdateRestarting(true);
    setUpdateRestartError(undefined);
    const result = await dispatch("app:update:install", {});
    if (!result.ok) {
      setUpdateRestartError(result.error.message);
      setUpdateRestarting(false);
      return;
    }
    if (result.value.status === "error") {
      setUpdateRestartError(result.value.message);
      setUpdateRestarting(false);
    }
  };

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">Updates</div>
          <h1 className="pss__main-title">Updates</h1>
          <p className="pss__main-sub">
            Which published build PwrSnap follows, and when it installs one.
          </p>
        </div>
      </div>

      <Card eyebrow="UPDATES" title="Release channel">
        <div className="pss__row">
          <div className="pss__row-l">
            <div className="pss__row-label">Follow this build</div>
            <div className="pss__row-sub">
              Two trains, two tracks. Stable is the smoke-checked 1.0 feed; Beta follows
              main. Latest is smoke-checked within its train; Prerelease is newer and may
              not install.
            </div>
            <div className="pss__row-tag">{`${train} · ${channel}`}</div>
          </div>
          <div className="pss__row-r">
            <div className="pss__slots" role="radiogroup" aria-label="Release channel">
              <div className="pss__slots-rowhdr" aria-hidden="true" />
              <div className="pss__slots-colhdr">{CHANNEL_LABEL.latest}</div>
              <div className="pss__slots-colhdr">{CHANNEL_LABEL.prerelease}</div>
              {(["stable", "beta"] as const).map((rowTrain) => (
                <SlotRow
                  key={rowTrain}
                  train={rowTrain}
                  releases={releaseVersions}
                  appVersion={appVersion}
                  selectedTrain={train}
                  selectedChannel={channel}
                  onSelect={selectSlot}
                />
              ))}
            </div>
            {/* The inference rule is only worth explaining while it is still
                live — once someone picks a slot, saying "we guessed" is noise. */}
            {!pinned ? (
              <span className="pss__update-note">
                Following the build you installed. Pick a slot to pin it.
              </span>
            ) : null}
          </div>
        </div>

        <div className="pss__row">
          <div className="pss__row-l">
            <div className="pss__row-label">Check now</div>
            <div className="pss__row-sub">
              PwrSnap also checks hourly. A build behind the one you are running only
              installs when you ask for it here.
            </div>
            {appVersion !== undefined ? (
              <div className="pss__row-tag">{`installed v${appVersion}`}</div>
            ) : null}
          </div>
          <div className="pss__row-r">
            <div className="pss__update-channel">
              <div className="pss__update-actions">
                <button
                  className="pss__top-btn"
                  type="button"
                  disabled={updateChecking}
                  onClick={() => {
                    void checkForUpdates();
                  }}
                >
                  {updateChecking ? "Checking..." : "Check for Updates"}
                </button>
                {updateAction !== undefined ? (
                  <button
                    className="pss__top-btn is-active"
                    type="button"
                    aria-label={updateAction.ariaLabel}
                    disabled={updateRestarting}
                    onClick={() => {
                      void restartToUpdate();
                    }}
                  >
                    {updateRestarting ? updateAction.busyLabel : updateAction.label}
                  </button>
                ) : null}
              </div>
              {visibleUpdateStatus !== undefined ? (
                <span
                  className={
                    "pss__update-note" +
                    (visibleUpdateStatusIsError ? " pss__update-note--error" : "")
                  }
                  role={visibleUpdateStatusIsError ? "alert" : undefined}
                >
                  {visibleUpdateStatus}
                </span>
              ) : null}
              {updateRestartError !== undefined ? (
                <span className="pss__update-note pss__update-note--error" role="alert">
                  {updateRestartError}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}

type SlotRowProps = {
  train: UpdateTrain;
  releases: AppUpdateReleaseVersions | undefined;
  appVersion: string | undefined;
  selectedTrain: UpdateTrain;
  selectedChannel: UpdateChannel;
  onSelect: (slot: { train: UpdateTrain; channel: UpdateChannel }) => void;
};

function SlotRow({
  train,
  releases,
  appVersion,
  selectedTrain,
  selectedChannel,
  onSelect
}: SlotRowProps): ReactElement {
  return (
    <>
      <div className="pss__slots-rowhdr">{TRAIN_LABEL[train]}</div>
      {UPDATE_SLOTS.filter((slot) => slot.train === train).map((slot) => {
        const release = releases?.[slot.train][slot.channel];
        return (
          <SlotTile
            key={`${slot.train}:${slot.channel}`}
            train={slot.train}
            channel={slot.channel}
            release={release}
            loading={releases === undefined}
            selected={slot.train === selectedTrain && slot.channel === selectedChannel}
            installed={sameVersion(release?.version, appVersion)}
            onSelect={() => {
              onSelect({ train: slot.train, channel: slot.channel });
            }}
          />
        );
      })}
    </>
  );
}
