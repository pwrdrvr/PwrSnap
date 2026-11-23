import { useEffect, useRef, type ReactElement } from "react";
import {
  acceleratorToAccessibleText,
  acceleratorToDisplayKeys,
  shortcutPlatformDisplayName,
  type HotkeyRegistrationStatus,
  type ShortcutPlatform
} from "@pwrsnap/shared";
import { Kbd } from "./Kbd";

const TAGS = {
  failed: "Not saved",
  unsupported: "Can’t use",
  duplicate: "In PwrSnap",
  inactive: "Not active"
} as const;

type RecoveryProps = {
  kind: keyof typeof TAGS;
  title: string;
  detail: string;
  action: string;
  platform: ShortcutPlatform;
  saved: string | undefined;
  status: HotkeyRegistrationStatus | undefined;
  focusAttempt: string | undefined;
  focusNextAlternative: boolean;
  alternatives: readonly string[];
  rejected: ReadonlySet<string>;
  trying: string | undefined;
  disabled: boolean;
  retrying: boolean;
  conflict: { label: string; show: () => void } | undefined;
  onTry: (accelerator: string) => void;
  onRetry: (() => void) | undefined;
  onRecord: () => void;
  onDismiss: (() => void) | undefined;
};

function Keys({ value, platform }: { value: string; platform: ShortcutPlatform }): ReactElement {
  return (
    <span className="pss__hk-inline" aria-hidden="true">
      {acceleratorToDisplayKeys(value, platform).map((key, index) => (
        <Kbd key={`${key}-${index}`}>{key}</Kbd>
      ))}
    </span>
  );
}

function SavedStatus({ status }: { status: HotkeyRegistrationStatus | undefined }): ReactElement {
  if (status?.state === "active") return <span className="pss__hk-status is-active">Active</span>;
  if (status?.state === "inactive") return <span className="pss__hk-status is-inactive">Not active</span>;
  return <span className="pss__hk-status is-checking">Checking</span>;
}

export function HotkeyRecovery(props: RecoveryProps): ReactElement {
  const title = useRef<HTMLHeadingElement>(null);
  const suggestions = useRef<HTMLUListElement>(null);
  const record = useRef<HTMLButtonElement>(null);
  const focusedAttempt = useRef<string | undefined>(undefined);
  const { focusAttempt, focusNextAlternative, disabled, kind, platform, saved, status } = props;
  useEffect(() => {
    if (focusAttempt === undefined || disabled || focusAttempt === focusedAttempt.current) return;
    focusedAttempt.current = focusAttempt;
    const next = focusNextAlternative
      ? suggestions.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? record.current
      : title.current;
    next?.focus();
  }, [focusAttempt, focusNextAlternative, disabled]);

  const hasAvailableSuggestion = props.alternatives.some((chord) => !props.rejected.has(chord));

  return (
    <div className={`pss__hk-recovery is-${kind === "unsupported" ? "failed" : kind}`}>
      <div className="pss__hk-recovery-copy" role="alert">
        <div className="pss__hk-recovery-hdr">
          <span className="pss__hk-recovery-tag">{TAGS[kind]}</span>
          <h3 ref={title} tabIndex={-1} className="pss__hk-recovery-title">{props.title}</h3>
        </div>
        <p className="pss__hk-recovery-body">{props.detail}</p>
      </div>
      {saved !== undefined ? (
        <div className="pss__hk-kept">
          {saved === "" ? "Still not set. Nothing was saved." : (
            <>
              <span aria-label={`Still saved. ${acceleratorToAccessibleText(saved, platform)}`}>
                Still saved
              </span>
              <Keys value={saved} platform={platform} />
              <SavedStatus status={status} />
            </>
          )}
        </div>
      ) : null}
      <div className="pss__hk-suggest">
        {hasAvailableSuggestion ? (
          <div className="pss__hk-suggest-hd">
            <span className="pss__hk-suggest-k">Try instead</span>
            <span className="pss__hk-suggest-note">
              Suggestions, not checked yet. PwrSnap saves one if {shortcutPlatformDisplayName(platform)} accepts it.
            </span>
          </div>
        ) : (
          <p className="pss__hk-recovery-body">No more suggestions for this row. Record a combination of your own.</p>
        )}
        {props.alternatives.length > 0 ? (
          <ul ref={suggestions} className="pss__hk-suggest-list">
            {props.alternatives.map((accelerator) => {
              const rejected = props.rejected.has(accelerator);
              const trying = props.trying === accelerator;
              const verb = rejected ? "Not accepted" : trying ? "Trying…" : "Try";
              return (
              <li key={accelerator}>
                <button
                  type="button"
                  className={`pss__hk-suggest-btn${rejected ? " is-rejected" : trying ? " is-trying" : ""}`}
                  aria-label={`${verb} ${acceleratorToAccessibleText(accelerator, platform)} for ${props.action}`}
                  aria-busy={trying}
                  disabled={disabled || rejected}
                  onClick={() => props.onTry(accelerator)}
                >
                  <Keys value={accelerator} platform={platform} />
                  <span className="verb">{verb}</span>
                </button>
              </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <div className="pss__hk-recovery-actions">
        {props.onRetry ? (
          <button
            type="button"
            className="pss__hk-act is-primary"
            aria-label={`Retry ${props.action} hotkey`}
            disabled={props.disabled}
            onClick={props.onRetry}
          >
            {props.retrying ? "Retrying…" : "Retry"}
          </button>
        ) : null}
        {props.conflict ? (
          <button type="button" className="pss__hk-act" disabled={props.disabled} onClick={props.conflict.show}>
            Show {props.conflict.label}
          </button>
        ) : null}
        <button ref={record} type="button" className="pss__hk-act" disabled={props.disabled} onClick={props.onRecord}>
          Record another…
        </button>
        {props.onDismiss ? (
          <button type="button" className="pss__hk-act is-ghost" disabled={props.disabled} onClick={props.onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
