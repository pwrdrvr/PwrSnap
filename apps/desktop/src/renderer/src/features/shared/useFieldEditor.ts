import { useCallback, useEffect, useRef, useState } from "react";

// useFieldEditor — local-state mirror of an `accepted` / `suggested`
// pair, with an origin tag so the UI can style suggested-but-not-yet-
// accepted text differently from text the user already owns.
//
// Used by both the Library sidebar (DetailRail) and the float-over
// toast (FloatOver) so the provenance state machine stays consistent
// across surfaces — `accepted` is text the user has committed to,
// `suggested` is Codex's draft sitting in the input, `manual` is text
// the user is actively typing, `empty` is a blank field.
//
// The effects are split deliberately into two:
//
//   1) `captureId` change → full reset. The previous capture's
//      `accepted` / `suggested` / `origin` / typed value all go away.
//      Without a reset branch, navigating to a different snap with
//      Detail tab still mounted would leave the inputs showing the
//      old capture's content.
//
//   2) `accepted` / `suggested` change → sync server-side updates into
//      the local view. Reads `origin` through a ref so this effect
//      doesn't fire just because the user typed (which is what put us
//      in the `manual` state). Without the ref, every keystroke could
//      retrigger the effect and risk clobbering the typed value with
//      a stale suggestion.

export type FieldOrigin = "accepted" | "manual" | "suggested" | "empty";

export type UseFieldEditorInput = {
  /** Identity of the capture this field belongs to. When it changes,
   *  the editor performs a full reset so the previous capture's typed
   *  value doesn't leak into the new one. */
  readonly captureId: string;
  /** Server-side accepted value. If non-empty, takes precedence over
   *  `suggested` for the initial display. */
  readonly accepted: string;
  /** Codex's draft suggestion. Shown only when `accepted` is empty
   *  and the user hasn't started typing (origin !== "manual"). */
  readonly suggested: string;
};

export type UseFieldEditorResult = readonly [
  value: string,
  origin: FieldOrigin,
  setValue: (next: string) => void,
  /**
   * Optimistic-accept setter. Sets value + origin together; used when
   * the user clicks an explicit "Use draft" / "Save" button so the
   * input flips to the accepted style immediately, before the server
   * round-trip lands. The subsequent sync effect (when the server
   * echoes the new `accepted`) is a no-op because origin is already
   * `"accepted"` and the values match.
   */
  commit: (value: string, origin: FieldOrigin) => void
];

function originFromInput(accepted: string, suggested: string): FieldOrigin {
  if (accepted.length > 0) return "accepted";
  if (suggested.length > 0) return "suggested";
  return "empty";
}

export function useFieldEditor(input: UseFieldEditorInput): UseFieldEditorResult {
  const initial = input.accepted.length > 0 ? input.accepted : input.suggested;
  const [value, setValue] = useState<string>(initial);
  const [origin, setOrigin] = useState<FieldOrigin>(
    originFromInput(input.accepted, input.suggested)
  );

  // Ref-tracked counterparts of `origin` and the previously-previewed
  // suggestion. Reading state through refs inside the sync effect lets
  // us scope the dependency array to `[accepted, suggested]` — the
  // effect fires when the SERVER value changes, not when the user
  // types.
  const originRef = useRef<FieldOrigin>(origin);
  const previewedSuggestionRef = useRef<string>(input.suggested);

  // Full-reset effect: fires only when the capture changes. Re-deriving
  // origin from the new capture's accepted/suggested keeps the rule
  // "accepted beats suggested beats empty" in one place.
  useEffect(() => {
    const reset = input.accepted.length > 0 ? input.accepted : input.suggested;
    const resetOrigin = originFromInput(input.accepted, input.suggested);
    setValue(reset);
    setOrigin(resetOrigin);
    originRef.current = resetOrigin;
    previewedSuggestionRef.current = input.suggested;
    // We intentionally read `accepted` / `suggested` here only at the
    // moment the capture changes; the sync effect below handles their
    // subsequent updates within the same capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.captureId]);

  // Sync effect: fires when the server-side `accepted` or `suggested`
  // changes within the same capture. Reads `origin` via ref so user
  // typing doesn't retrigger it.
  useEffect(() => {
    const currentOrigin = originRef.current;
    if (input.accepted.length > 0 && currentOrigin !== "manual") {
      setValue(input.accepted);
      setOrigin("accepted");
      originRef.current = "accepted";
      previewedSuggestionRef.current = input.suggested;
      return;
    }
    if (input.accepted.length === 0 && input.suggested.length === 0) {
      if (currentOrigin === "suggested") {
        setValue("");
        setOrigin("empty");
        originRef.current = "empty";
      }
      previewedSuggestionRef.current = "";
      return;
    }
    if (
      input.accepted.length === 0 &&
      input.suggested.length > 0 &&
      previewedSuggestionRef.current !== input.suggested &&
      (currentOrigin === "suggested" || currentOrigin === "empty")
    ) {
      setValue(input.suggested);
      setOrigin("suggested");
      originRef.current = "suggested";
      previewedSuggestionRef.current = input.suggested;
    }
  }, [input.accepted, input.suggested]);

  const handleEdit = useCallback((next: string): void => {
    setValue(next);
    const nextOrigin: FieldOrigin = next.trim().length === 0 ? "empty" : "manual";
    setOrigin(nextOrigin);
    originRef.current = nextOrigin;
  }, []);

  const commit = useCallback((next: string, nextOrigin: FieldOrigin): void => {
    setValue(next);
    setOrigin(nextOrigin);
    originRef.current = nextOrigin;
  }, []);

  return [value, origin, handleEdit, commit];
}
