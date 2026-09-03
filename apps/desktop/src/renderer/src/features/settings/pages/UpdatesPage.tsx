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

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from "react";
import {
  EVENT_CHANNELS,
  UPDATE_CHANNELS,
  UPDATE_TRAINS,
  type AppUpdateCheckResult,
  type AppUpdateReleaseInfo,
  type AppUpdateReleaseVersions,
  type AppUpdateStatus,
  type UpdateChannel,
  type UpdateTrain
} from "@pwrsnap/shared";
import { Card, Row } from "../components";
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

/** The four published slots in render order — trains as rows, tracks as
 *  columns — derived from the shared axis lists so the headers, the tiles
 *  and the arrow-key walk can never disagree about the grid's shape. */
const SLOT_ORDER: readonly { train: UpdateTrain; channel: UpdateChannel }[] =
  UPDATE_TRAINS.flatMap((train) => UPDATE_CHANNELS.map((channel) => ({ train, channel })));

const COLUMNS = UPDATE_CHANNELS.length;

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
  /** Roving tabindex: exactly one tile is in the tab order, per the
   *  radiogroup contract. See `SLOT_ORDER` for what the arrows walk. */
  tabbable: boolean;
  onSelect: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  registerRef: (el: HTMLButtonElement | null) => void;
};

function SlotTile({
  train,
  channel,
  release,
  loading,
  selected,
  installed,
  tabbable,
  onSelect,
  onKeyDown,
  registerRef
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
      ref={registerRef}
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${label} — ${headline}`}
      tabIndex={tabbable ? 0 : -1}
      className={"pss__slot" + (selected ? " is-selected" : "")}
      onClick={onSelect}
      onKeyDown={onKeyDown}
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
  // A click that has not round-tripped yet has still pinned the pair, so
  // the "pick a slot" hint must not linger and tell the user to redo it.
  const pinned = settings?.updates.selectionSource === "user" || pendingSelection !== undefined;

  const [appVersion, setAppVersion] = useState<string | undefined>();
  const [releaseVersions, setReleaseVersions] = useState<AppUpdateReleaseVersions | undefined>();
  // "Loading" is only true until the read ANSWERS. A dispatch that fails
  // (agent restarting, bridge dropped the call) still settles, and the
  // tiles must fall through to Unavailable rather than claim a read is
  // still in flight for the rest of the window's life.
  const [releasesSettled, setReleasesSettled] = useState(false);
  const [releasesError, setReleasesError] = useState<string | undefined>();
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
      setReleasesSettled(true);
      if (versions.ok) {
        setReleaseVersions(versions.value);
        setReleasesError(undefined);
      } else {
        setReleasesError(versions.error.message);
      }
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

  const selectSlot = useCallback(
    (next: { train: UpdateTrain; channel: UpdateChannel }): void => {
      if (!ready) return;
      // Both keys always travel together. Main reads the presence of either
      // as "a person picked this" and pins the pair.
      setPendingSelection(next);
      void patch({ updates: next });
    },
    [ready, patch]
  );

  // Roving tabindex + arrow keys, the radiogroup contract. Focus moves and
  // selection does NOT follow it: picking a slot rewrites which build the
  // app installs, so a stray arrow press should not change the feed. The
  // user commits with Space/Enter (the button's own activation) or a click.
  const slotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = Math.max(
    0,
    SLOT_ORDER.findIndex((slot) => slot.train === train && slot.channel === channel)
  );
  const onSlotKeyDown = useCallback(
    (index: number) =>
      (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
        const delta =
          event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowLeft"
              ? -1
              : event.key === "ArrowDown"
                ? COLUMNS
                : event.key === "ArrowUp"
                  ? -COLUMNS
                  : 0;
        if (delta === 0) return;
        event.preventDefault();
        const count = SLOT_ORDER.length;
        const next = (index + delta + count) % count;
        slotRefs.current[next]?.focus();
      },
    []
  );

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
      setReleasesSettled(true);
      if (versions.ok) {
        setReleaseVersions(versions.value);
        setReleasesError(undefined);
      } else {
        setReleasesError(versions.error.message);
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
        <Row
          label="Follow this build"
          sub="Two trains, two tracks. Stable is the smoke-checked 1.0 feed; Beta follows main. Latest is smoke-checked within its train; Prerelease is newer and may not install."
          tag={`${train} · ${channel}`}
        >
          <div className="pss__slots" role="radiogroup" aria-label="Release channel">
            {/* Header cells are decoration: every tile's aria-label already
                spells out "Stable Latest", so exposing the headers inside the
                radiogroup would only interleave duplicate text with the
                options. */}
            <div className="pss__slots-rowhdr" aria-hidden="true" />
            {UPDATE_CHANNELS.map((headerChannel) => (
              <div key={headerChannel} className="pss__slots-colhdr" aria-hidden="true">
                {CHANNEL_LABEL[headerChannel]}
              </div>
            ))}
            {UPDATE_TRAINS.map((rowTrain) => (
              <Fragment key={rowTrain}>
                <div className="pss__slots-rowhdr" aria-hidden="true">
                  {TRAIN_LABEL[rowTrain]}
                </div>
                {UPDATE_CHANNELS.map((slotChannel) => {
                  const index = SLOT_ORDER.findIndex(
                    (slot) => slot.train === rowTrain && slot.channel === slotChannel
                  );
                  const release = releaseVersions?.[rowTrain]?.[slotChannel];
                  return (
                    <SlotTile
                      key={slotChannel}
                      train={rowTrain}
                      channel={slotChannel}
                      release={release}
                      loading={!releasesSettled}
                      selected={index === selectedIndex}
                      installed={sameVersion(release?.version, appVersion)}
                      tabbable={index === selectedIndex}
                      onSelect={() => {
                        selectSlot({ train: rowTrain, channel: slotChannel });
                      }}
                      onKeyDown={onSlotKeyDown(index)}
                      registerRef={(el) => {
                        slotRefs.current[index] = el;
                      }}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
          {/* The inference rule is only worth explaining while it is still
              live — once someone picks a slot, saying "we guessed" is noise. */}
          {!pinned ? (
            <span className="pss__update-note">
              Following the build you installed. Pick a slot to pin it.
            </span>
          ) : null}
          {releasesError !== undefined ? (
            <span className="pss__update-note pss__update-note--error" role="alert">
              Could not read published releases: {releasesError}
            </span>
          ) : null}
        </Row>

        <Row
          label="Check now"
          sub="PwrSnap also checks hourly. A build behind the one you are running only installs when you ask for it here."
          {...(appVersion !== undefined ? { tag: `installed v${appVersion}` } : {})}
        >
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
        </Row>
      </Card>
    </>
  );
}
