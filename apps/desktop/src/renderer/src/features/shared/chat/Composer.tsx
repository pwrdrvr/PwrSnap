// Composer — the message-input row at the bottom of the Library chat
// panel. PURE PRESENTATIONAL: props in, callbacks out. No bus / IPC
// wiring — the parent's `onSubmit` decides what to do with the text +
// attachments. (Library Chat Editor plan §F10.)
//
// Behavior:
//
//   • Multiline <textarea> that auto-grows to its content, capped at
//     ~40vh then scrolls. ⏎ submits; ⇧⏎ inserts a newline; ⌘⏎ (⌃⏎ on
//     non-mac) also submits. Empty / whitespace-only input never
//     submits.
//
//   • Double-submit guard (plan §F10 T11): a `submitInFlight` ref +
//     a two-state machine ("idle" | "sending"). A second ⏎ while a
//     submit is in flight is a no-op and does NOT clear the textarea —
//     the user's draft survives a slow / failed send. The textarea is
//     cleared and the machine returns to "idle" in a `.finally()` so
//     it recovers on BOTH the resolve and reject branches.
//
//   • Keyboard-chord shadowing (plan §F10 T7): the Library window
//     installs window-level keydown handlers (the activity bar's ⌘\ /
//     ⌘N / Escape — see RightActivityBar.tsx's header comment). When
//     the textarea is focused AND has non-empty content, we
//     stopPropagation() on those chords so the window handlers don't
//     fire mid-typing. When the textarea is EMPTY we let Escape
//     propagate so the activity bar can still close a hover-pop. The
//     listener is installed on the textarea node, held in a ref, and
//     disposed on unmount — never a loose window listener.
//
//   • Paste / drop image attachments (plan §F10 T9): paste a clipboard
//     image or drop image files onto the dropzone to attach them. On
//     drop we stopPropagation() + preventDefault() in the CAPTURE phase
//     and gate by `closest('.ps-composer-dropzone')` so the Library
//     window's GLOBAL drop handler doesn't ALSO import the dropped image
//     as a new capture. Each attachment carries an objectURL preview +
//     the underlying File so the parent can upload / inline it. We revoke
//     the objectURL when the chip is removed or the component unmounts.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from "react";
import { isPrimaryAccel } from "../keyboard";
import "./Composer.css";

/** A single attachment descriptor. `previewUrl` is an objectURL the
 *  composer owns (created + revoked here). `file` is the underlying
 *  blob the parent's `onSubmit` decides what to do with — upload it,
 *  read it as base64, inline it, etc. The composer never touches the
 *  bytes; it only produces the descriptor + preview. */
export interface ComposerAttachment {
  readonly id: string;
  readonly name: string;
  readonly previewUrl: string;
  /** The underlying file the parent should act on. Kept on the
   *  descriptor (rather than base64) so the parent can stream it
   *  without the composer holding a large data: string in memory. */
  readonly file: File;
}

export interface ComposerProps {
  /** Called when the user submits. Returns a promise; while pending
   *  the composer is in the SENDING state and further submits are
   *  no-ops. Resolve OR reject both return the composer to idle and
   *  clear the textarea + attachments. */
  readonly onSubmit: (
    text: string,
    attachments: readonly ComposerAttachment[]
  ) => Promise<void>;
  /** Disabled (e.g. no Codex configured). Disables the textarea AND
   *  the send button. */
  readonly disabled?: boolean;
  readonly placeholder?: string;
  /** Test-id prefix. Defaults to "composer". */
  readonly testIdPrefix?: string;
}

type SendState = "idle" | "sending";

/** Cap the auto-grow at ~40vh, then the textarea scrolls. Read once
 *  per measure so a resized window stays correct. */
function maxTextareaHeightPx(): number {
  if (typeof window === "undefined") return 320;
  return Math.round(window.innerHeight * 0.4);
}

let attachmentSeq = 0;
function nextAttachmentId(): string {
  attachmentSeq += 1;
  return `cmp-att-${attachmentSeq}-${Date.now().toString(36)}`;
}

export function Composer(props: ComposerProps): ReactElement {
  const {
    onSubmit,
    disabled = false,
    placeholder = "Message Codex…",
    testIdPrefix = "composer"
  } = props;

  const [text, setText] = useState<string>("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [sendState, setSendState] = useState<SendState>("idle");

  // Double-submit guard. The ref is the authority for the keydown /
  // click handlers (it's synchronous — a second ⏎ in the same tick
  // sees `true` before React re-renders the state). `sendState` is the
  // render-time mirror used for disabled styling.
  const submitInFlight = useRef<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dropzoneRef = useRef<HTMLDivElement | null>(null);

  // Live mirrors so the ref-held keydown listener reads the latest
  // text / disabled without re-installing the listener on every
  // keystroke (re-installing would race a keydown landing between
  // teardown and re-add).
  const textRef = useRef<string>(text);
  textRef.current = text;
  const disabledRef = useRef<boolean>(disabled);
  disabledRef.current = disabled;

  // Track objectURLs so we revoke them on unmount even if the chip was
  // never explicitly removed (e.g. submit cleared them, or the window
  // closed mid-compose).
  const liveUrls = useRef<Set<string>>(new Set());

  const errId = useId();

  // ---- auto-grow ---------------------------------------------------
  // Measure on every text change: reset to auto, read scrollHeight,
  // clamp to the 40vh ceiling. useLayoutEffect so the resize happens
  // before paint (no flash of the wrong height).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    const max = maxTextareaHeightPx();
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  // ---- chord shadowing (ref-held listener, disposed on unmount) ----
  // Installed on the textarea node so it only fires for keystrokes
  // that originate in the composer. We stopPropagation() on the
  // activity-bar chords (⌘N / ⌘F / Escape) when the textarea has
  // content, so the window-level handlers don't steal them mid-typing.
  // Escape on an EMPTY textarea is allowed to propagate so the
  // activity bar can still close its hover-pop.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    const handler = (event: KeyboardEvent): void => {
      const hasText = textRef.current.trim().length > 0;
      if (event.key === "Escape") {
        // Empty → let it bubble (activity bar closes hover-pop).
        // Non-empty → shadow so a half-typed draft isn't lost to a
        // window-level Escape handler.
        if (hasText) event.stopPropagation();
        return;
      }
      // ⌘N (new) / ⌘F (find) — shadow only while the user has a
      // draft in flight so the window chords don't fire mid-typing.
      if (isPrimaryAccel(event) && (event.key === "n" || event.key === "f")) {
        if (hasText) event.stopPropagation();
      }
    };
    el.addEventListener("keydown", handler);
    return () => {
      el.removeEventListener("keydown", handler);
    };
  }, []);

  // ---- attachment lifecycle ---------------------------------------
  const addFiles = useCallback((files: readonly File[]): void => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const created = images.map((file): ComposerAttachment => {
      const previewUrl = URL.createObjectURL(file);
      liveUrls.current.add(previewUrl);
      return {
        id: nextAttachmentId(),
        name: file.name === "" ? "pasted-image" : file.name,
        previewUrl,
        file
      };
    });
    setAttachments((prev) => [...prev, ...created]);
  }, []);

  const removeAttachment = useCallback((id: string): void => {
    setAttachments((prev) => {
      const hit = prev.find((a) => a.id === id);
      if (hit !== undefined) {
        URL.revokeObjectURL(hit.previewUrl);
        liveUrls.current.delete(hit.previewUrl);
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Revoke any still-live objectURLs on unmount.
  useEffect(() => {
    const urls = liveUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  // ---- submit ------------------------------------------------------
  const canSubmit =
    !disabled && sendState === "idle" && text.trim().length > 0;

  const doSubmit = useCallback((): void => {
    // Synchronous guard: a second ⏎ in the same tick reads the ref,
    // not the (not-yet-committed) state.
    if (submitInFlight.current) return;
    if (disabledRef.current) return;
    const trimmed = textRef.current.trim();
    if (trimmed.length === 0) return;

    submitInFlight.current = true;
    setSendState("sending");

    // Snapshot what we're sending so the .finally() can clear only on
    // success terms while the draft survives if onSubmit rejects.
    const sending = textRef.current;
    const sendingAttachments = attachments;

    void Promise.resolve(onSubmit(sending, sendingAttachments))
      .then(() => {
        // Success: clear the draft + attachments, revoke previews.
        for (const a of sendingAttachments) {
          URL.revokeObjectURL(a.previewUrl);
          liveUrls.current.delete(a.previewUrl);
        }
        setText("");
        setAttachments((prev) =>
          prev.filter((a) => !sendingAttachments.some((s) => s.id === a.id))
        );
      })
      .catch(() => {
        // Failure: keep the draft so the user can retry. We
        // deliberately do NOT clear here.
      })
      .finally(() => {
        submitInFlight.current = false;
        setSendState("idle");
      });
  }, [attachments, onSubmit]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key !== "Enter") return;
      // ⇧⏎ → newline (let the textarea handle it).
      if (event.shiftKey) return;
      // ⏎ or ⌘⏎ / ⌃⏎ → submit. (IME composition mid-flight should not
      // submit — `isComposing` guards CJK input.)
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      // A no-op while sending must NOT clear the textarea — doSubmit's
      // ref guard handles that (it returns early), and we preventDefault
      // above only to stop the newline, not to mutate the value.
      doSubmit();
    },
    [doSubmit]
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>): void => {
      setText(event.target.value);
    },
    []
  );

  // ---- paste -------------------------------------------------------
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>): void => {
      const items = event.clipboardData?.items;
      if (items === undefined) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file !== null) files.push(file);
        }
      }
      if (files.length === 0) return;
      // Pasting an image attaches it; we preventDefault so a stray
      // filename / binary blob doesn't also land in the textarea.
      event.preventDefault();
      addFiles(files);
    },
    [addFiles]
  );

  // ---- drop --------------------------------------------------------
  // Capture phase + stopPropagation + closest() gate so the Library
  // window's GLOBAL drop handler doesn't ALSO import the image as a
  // capture. The handler bails (without stopping propagation) if the
  // drop didn't land on the dropzone subtree, so non-image drops
  // elsewhere are unaffected.
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement | null;
      const inZone =
        target?.closest(".ps-composer-dropzone") ===
          event.currentTarget &&
        event.currentTarget === dropzoneRef.current;
      const dropped = event.dataTransfer?.files;
      const files =
        dropped === undefined
          ? []
          : Array.from(dropped).filter((f) => f.type.startsWith("image/"));
      if (!inZone || files.length === 0) return;
      // Claim the drop: stop the Library window's global importer.
      event.stopPropagation();
      event.preventDefault();
      addFiles(files);
    },
    [addFiles]
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      // Signal we accept the drop so the OS shows the copy cursor and
      // (combined with the capture-phase drop handler) the global
      // importer doesn't claim it.
      if (event.dataTransfer === null) return;
      const hasFiles = Array.from(event.dataTransfer.items ?? []).some(
        (i) => i.kind === "file"
      );
      if (!hasFiles) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    []
  );

  const isSending = sendState === "sending";

  return (
    <div
      ref={dropzoneRef}
      className="ps-composer ps-composer-dropzone"
      data-testid={`${testIdPrefix}-root`}
      data-state={sendState}
      // Capture phase: claim image drops before the window's global
      // handler sees them.
      onDropCapture={handleDrop}
      onDragOver={handleDragOver}
    >
      {attachments.length > 0 && (
        <div
          className="ps-composer__chips"
          data-testid={`${testIdPrefix}-chips`}
        >
          {attachments.map((att) => (
            <span key={att.id} className="ps-composer__chip" title={att.name}>
              <img
                className="ps-composer__chip-thumb"
                src={att.previewUrl}
                alt=""
                aria-hidden="true"
              />
              <span className="ps-composer__chip-name">{att.name}</span>
              <button
                type="button"
                className="ps-composer__chip-remove"
                aria-label={`Remove ${att.name}`}
                data-testid={`${testIdPrefix}-chip-remove-${att.id}`}
                onClick={() => removeAttachment(att.id)}
              >
                <RemoveGlyph />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="ps-composer__row">
        <textarea
          ref={textareaRef}
          className="ps-composer__input"
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="Message"
          aria-describedby={errId}
          aria-disabled={disabled}
          data-testid={`${testIdPrefix}-input`}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        <button
          type="button"
          className="ps-composer__send"
          disabled={!canSubmit}
          aria-label="Send"
          title="Send"
          data-testid={`${testIdPrefix}-send`}
          onClick={doSubmit}
        >
          {isSending ? <SpinnerGlyph /> : <SendGlyph />}
        </button>
      </div>
    </div>
  );
}

function SendGlyph(): ReactElement {
  // Paper-plane.
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M1.5 8 14 2 9 14l-2.4-4.2L1.5 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SpinnerGlyph(): ReactElement {
  return (
    <svg
      className="ps-composer__spinner"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeOpacity="0.25"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RemoveGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path
        d="M3 3 9 9M9 3 3 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
