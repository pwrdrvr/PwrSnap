import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { useFieldEditor, type FieldOrigin } from "../useFieldEditor";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

type Snapshot = {
  value: string;
  origin: FieldOrigin;
};

type ProbeProps = {
  readonly captureId: string;
  readonly accepted: string;
  readonly suggested: string;
  readonly onSnapshot: (snapshot: Snapshot) => void;
  readonly externalSetter?: (handle: {
    setValue: (next: string) => void;
    commit: (value: string, origin: FieldOrigin) => void;
  }) => void;
};

// Tiny consumer of useFieldEditor that surfaces value+origin to the
// caller. Keeping the probe component minimal lets the tests assert on
// the hook's contract directly instead of routing through a renderer
// fixture.
function Probe(props: ProbeProps): null {
  const [value, origin, setValue, commit] = useFieldEditor({
    captureId: props.captureId,
    accepted: props.accepted,
    suggested: props.suggested
  });
  useEffect(() => {
    props.onSnapshot({ value, origin });
  }, [value, origin, props]);
  useEffect(() => {
    props.externalSetter?.({ setValue, commit });
  }, [setValue, commit, props]);
  return null;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  container = null;
  root = null;
});

async function mount(initial: Omit<ProbeProps, "onSnapshot" | "externalSetter">): Promise<{
  snapshots: Snapshot[];
  setters: { setValue: (next: string) => void; commit: (value: string, origin: FieldOrigin) => void };
  rerender: (next: Omit<ProbeProps, "onSnapshot" | "externalSetter">) => Promise<void>;
}> {
  const snapshots: Snapshot[] = [];
  let captured: { setValue: (next: string) => void; commit: (value: string, origin: FieldOrigin) => void } | null = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  const render = async (props: Omit<ProbeProps, "onSnapshot" | "externalSetter">): Promise<void> => {
    await act(async () => {
      root?.render(
        createElement(Probe, {
          ...props,
          onSnapshot: (snap) => snapshots.push(snap),
          externalSetter: (handle) => {
            captured = handle;
          }
        })
      );
    });
  };

  await render(initial);
  if (captured === null) {
    throw new Error("useFieldEditor did not surface its setters");
  }
  return {
    snapshots,
    setters: captured,
    rerender: render
  };
}

describe("useFieldEditor", () => {
  test("initial state prefers accepted, falls back to suggested, otherwise empty", async () => {
    const acceptedFirst = await mount({
      captureId: "cap_1",
      accepted: "user copy",
      suggested: "codex copy"
    });
    expect(acceptedFirst.snapshots[0]).toEqual({ value: "user copy", origin: "accepted" });

    const suggestedFirst = await mount({
      captureId: "cap_2",
      accepted: "",
      suggested: "codex draft"
    });
    expect(suggestedFirst.snapshots[0]).toEqual({ value: "codex draft", origin: "suggested" });

    const empty = await mount({
      captureId: "cap_3",
      accepted: "",
      suggested: ""
    });
    expect(empty.snapshots[0]).toEqual({ value: "", origin: "empty" });
  });

  test("user typing flips origin to manual and does not re-fire the sync effect", async () => {
    const probe = await mount({
      captureId: "cap_1",
      accepted: "",
      suggested: "codex draft"
    });
    const before = probe.snapshots.length;
    await act(async () => {
      probe.setters.setValue("user typed");
    });
    const after = probe.snapshots[probe.snapshots.length - 1];
    expect(after).toEqual({ value: "user typed", origin: "manual" });
    expect(probe.snapshots.length).toBeGreaterThan(before);
  });

  test("new suggestion arrival overrides empty/suggested but NOT manual edits", async () => {
    const probe = await mount({
      captureId: "cap_1",
      accepted: "",
      suggested: "first draft"
    });
    await act(async () => {
      probe.setters.setValue("user copy");
    });
    expect(probe.snapshots[probe.snapshots.length - 1]).toEqual({
      value: "user copy",
      origin: "manual"
    });

    // Server sends a fresh suggestion — must not clobber the manual edit.
    await probe.rerender({ captureId: "cap_1", accepted: "", suggested: "second draft" });
    expect(probe.snapshots[probe.snapshots.length - 1]).toEqual({
      value: "user copy",
      origin: "manual"
    });
  });

  test("captureId change resets value and origin from the new capture's fields", async () => {
    const probe = await mount({
      captureId: "cap_1",
      accepted: "",
      suggested: "first draft"
    });
    await act(async () => {
      probe.setters.setValue("user copy");
    });
    expect(probe.snapshots[probe.snapshots.length - 1].origin).toBe("manual");

    await probe.rerender({
      captureId: "cap_2",
      accepted: "different snap accepted",
      suggested: ""
    });
    expect(probe.snapshots[probe.snapshots.length - 1]).toEqual({
      value: "different snap accepted",
      origin: "accepted"
    });
  });

  test("accepted-then-suggested transition (stale parent state lands first, fresh data sync) — Reel-mode regression", async () => {
    // Reproduces the "filename leaks from previous capture" bug: the
    // parent dispatches `codex:enrichment` for the new captureId
    // asynchronously, so the captureId-reset effect snapshots the
    // previous capture's accepted value. Then the fresh data arrives
    // for the new capture, which has only a suggested value (no
    // accepted yet). The sync effect must transition from a
    // stale-accepted state to the fresh suggested.
    const probe = await mount({
      captureId: "cap_a",
      accepted: "cap-a-filename",
      suggested: "cap-a-filename"
    });
    expect(probe.snapshots[probe.snapshots.length - 1]).toEqual({
      value: "cap-a-filename",
      origin: "accepted"
    });

    // Navigation: captureId flips first, parent still has cap_a's
    // enrichment in state.
    await probe.rerender({
      captureId: "cap_b",
      accepted: "cap-a-filename",
      suggested: "cap-a-filename"
    });
    // Then the fetch resolves with cap_b's enrichment — empty accepted,
    // fresh suggestion.
    await probe.rerender({
      captureId: "cap_b",
      accepted: "",
      suggested: "cap-b-filename"
    });
    expect(probe.snapshots[probe.snapshots.length - 1]).toEqual({
      value: "cap-b-filename",
      origin: "suggested"
    });
  });

  test("accepted-then-empty transition resets to empty (no leak when new capture lacks the field)", async () => {
    const probe = await mount({
      captureId: "cap_a",
      accepted: "cap-a-filename",
      suggested: ""
    });
    expect(probe.snapshots[probe.snapshots.length - 1].origin).toBe("accepted");

    // Navigate to a capture where both accepted and suggested are
    // empty — e.g., a freshly-imported capture with no Codex run.
    await probe.rerender({
      captureId: "cap_b",
      accepted: "cap-a-filename",
      suggested: ""
    });
    await probe.rerender({ captureId: "cap_b", accepted: "", suggested: "" });
    expect(probe.snapshots[probe.snapshots.length - 1]).toEqual({
      value: "",
      origin: "empty"
    });
  });

  test("commit() flips to accepted optimistically before the server roundtrip", async () => {
    const probe = await mount({
      captureId: "cap_1",
      accepted: "",
      suggested: "codex draft"
    });
    await act(async () => {
      probe.setters.commit("codex draft", "accepted");
    });
    expect(probe.snapshots[probe.snapshots.length - 1]).toEqual({
      value: "codex draft",
      origin: "accepted"
    });
  });
});
