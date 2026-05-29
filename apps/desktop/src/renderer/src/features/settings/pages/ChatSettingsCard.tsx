// Settings → AI → Chat card. Surfaces the three Library-chat
// preferences from `Settings.ai.chat`:
//   • a first-launch disclosure banner (storage location + iCloud +
//     Spotlight + FileVault), dismissible (persists the flag)
//   • a free-form User Guidance textarea (≤ 8 KB; save on blur)
//   • a repeating Sensitive-data Patterns editor (name + regex; live
//     compile validation; commit on blur)
//
// All writes go through `patch({ ai: { chat: { … } } })` — the same
// Settings substrate as every other field. The bus validator enforces
// caps + the secret-shape sniff; a rejected patch surfaces an inline
// error and we re-sync local draft state from the broadcast.
//
// Plan: docs/plans/2026-05-28-001-feat-library-chat-editor-interface-plan.md
// (§Storage layout banner copy, §F3 Phase 3, §F4 H3 secret sniff).

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { SensitiveDataPattern } from "@pwrsnap/shared";
import { Card, Row } from "../components";
import { useSettingsContext } from "../SettingsContext";

const USER_GUIDANCE_MAX = 8192;

export function ChatSettingsCard(): ReactElement | null {
  const { settings, patch } = useSettingsContext();
  if (settings === null) return null;
  return <ChatSettingsCardBody key="chat-settings" patch={patch} chat={settings.ai.chat} />;
}

type PatchFn = ReturnType<typeof useSettingsContext>["patch"];

function ChatSettingsCardBody({
  chat,
  patch
}: {
  chat: import("@pwrsnap/shared").ChatSettings;
  patch: PatchFn;
}): ReactElement {
  return (
    <Card eyebrow="PROVIDER" title="Library Chat">
      {!chat.firstLaunchBannerDismissed ? (
        <DisclosureBanner
          onDismiss={() => {
            void patch({ ai: { chat: { firstLaunchBannerDismissed: true } } });
          }}
        />
      ) : null}

      <Row
        label="User Guidance"
        sub="Free-form instructions injected into every chat with the agent. Tell it your conventions once — redaction style, preferred colors, domain terms — instead of repeating them each turn."
        tag="per-user"
      >
        <UserGuidanceEditor
          value={chat.userGuidance}
          onCommit={(next) => patch({ ai: { chat: { userGuidance: next } } })}
        />
      </Row>

      <Row
        label="Sensitive-data patterns"
        sub="Shape-only regexes the agent uses to find and redact secrets. NEVER paste a real secret — only the shape (e.g. 123-45-6789 for an SSN, sk-XXXXXXXX for an API key). Stored in plain text and included in Settings export."
        tag="per-user"
      >
        <PatternsEditor
          patterns={chat.sensitiveDataPatterns}
          onCommit={(next) => patch({ ai: { chat: { sensitiveDataPatterns: next } } })}
        />
      </Row>
    </Card>
  );
}

function DisclosureBanner({ onDismiss }: { onDismiss: () => void }): ReactElement {
  return (
    <div className="pss__chat-banner" role="note">
      <div className="pss__chat-banner-body">
        <b>Where your chats live.</b> Chat transcripts and PNG snapshots of
        your captures are saved as plain text under{" "}
        <code>~/Documents/PwrSnap/Chats/</code> so you can find and share
        them. If you have iCloud Drive “Desktop &amp; Documents” enabled,
        these files sync to iCloud. Spotlight indexing is disabled for this
        folder. Turn on FileVault for at-rest encryption.
      </div>
      <button type="button" className="pss__key-btn" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}

function UserGuidanceEditor({
  value,
  onCommit
}: {
  value: string;
  onCommit: (next: string) => Promise<unknown>;
}): ReactElement {
  const [draft, setDraft] = useState<string>(value);
  const [error, setError] = useState<string | null>(null);
  // Re-sync when the upstream value changes (broadcast from another
  // window, or a rejected patch reverting). Skip while focused so we
  // don't clobber mid-edit.
  const focusedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const over = draft.length > USER_GUIDANCE_MAX;

  return (
    <div className="pss__chat-guidance">
      <textarea
        className="pss__textarea"
        value={draft}
        rows={6}
        placeholder={
          'Examples:\n• Always redact account numbers with blackout, not blur.\n• When drawing arrows, prefer the accent color unless I say otherwise.\n• Any number shaped like ACME-12345 is an internal ticket id — link our tracker if you mention it.'
        }
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focusedRef.current = false;
          if (draft === value) return;
          if (over) {
            setError(`Too long — ${draft.length}/${USER_GUIDANCE_MAX} characters.`);
            return;
          }
          setError(null);
          void onCommit(draft).catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : "Couldn’t save guidance.");
            setDraft(value);
          });
        }}
      />
      <div className="pss__chat-counter">
        <span className={over ? "is-over" : undefined}>
          {draft.length}/{USER_GUIDANCE_MAX}
        </span>
        {error !== null ? <span className="pss__chat-err">{error}</span> : null}
      </div>
    </div>
  );
}

function compileError(pattern: string): string | null {
  if (pattern.length === 0) return null;
  try {
    new RegExp(pattern);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "Invalid regex";
  }
}

function PatternsEditor({
  patterns,
  onCommit
}: {
  patterns: readonly SensitiveDataPattern[];
  onCommit: (next: SensitiveDataPattern[]) => Promise<unknown>;
}): ReactElement {
  const [rows, setRows] = useState<SensitiveDataPattern[]>(() => [...patterns]);
  const [error, setError] = useState<string | null>(null);
  const focusedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!focusedRef.current) setRows([...patterns]);
  }, [patterns]);

  const commit = (next: SensitiveDataPattern[]): void => {
    setRows(next);
    // Validate locally before sending (the bus validator is the
    // authoritative gate, but this gives instant feedback).
    const names = new Set<string>();
    for (const row of next) {
      if (row.name.trim().length === 0 || row.pattern.trim().length === 0) return; // wait for completion
      if (names.has(row.name)) {
        setError(`Duplicate pattern name: ${row.name}`);
        return;
      }
      names.add(row.name);
      if (compileError(row.pattern) !== null) return; // don't commit an uncompilable row
    }
    setError(null);
    void onCommit(next.map((r) => ({ name: r.name.trim(), pattern: r.pattern.trim() }))).catch(
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Couldn’t save patterns.");
        setRows([...patterns]);
      }
    );
  };

  return (
    <div className="pss__chat-patterns">
      {rows.map((row, i) => {
        const regexErr = compileError(row.pattern);
        return (
          <div className="pss__chat-pattern-row" key={i}>
            <input
              className="pss__input"
              value={row.name}
              placeholder="Name (e.g. SSN)"
              aria-label="Pattern name"
              onFocus={() => {
                focusedRef.current = true;
              }}
              onChange={(e) => {
                const next = rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r));
                setRows(next);
              }}
              onBlur={() => {
                focusedRef.current = false;
                commit(rows);
              }}
            />
            <input
              className={"pss__input" + (regexErr !== null ? " is-error" : "")}
              value={row.pattern}
              placeholder="Shape regex (e.g. \\d{3}-\\d{2}-\\d{4})"
              aria-label="Pattern regex"
              spellCheck={false}
              onFocus={() => {
                focusedRef.current = true;
              }}
              onChange={(e) => {
                const next = rows.map((r, j) => (j === i ? { ...r, pattern: e.target.value } : r));
                setRows(next);
              }}
              onBlur={() => {
                focusedRef.current = false;
                commit(rows);
              }}
            />
            <button
              type="button"
              className="pss__key-btn is-danger"
              aria-label={`Remove pattern ${row.name}`}
              onClick={() => commit(rows.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="pss__key-btn"
        disabled={rows.length >= 32}
        onClick={() => setRows([...rows, { name: "", pattern: "" }])}
      >
        + Add pattern
      </button>
      {error !== null ? <div className="pss__chat-err">{error}</div> : null}
    </div>
  );
}
