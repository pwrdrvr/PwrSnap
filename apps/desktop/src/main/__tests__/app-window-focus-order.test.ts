import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AppWindowFocusOrder, type ActivateWindowState } from "../app-window-focus-order";

/**
 * Model test for what a Dock click brings back. The model keeps every
 * window's state and the global time each was last focused; the rule it
 * states is the one users expect from any macOS app: the window you were
 * last in comes back, minimized ones only when nothing is on screen, and
 * the Library only when nothing you used is left.
 *
 * The pre-fix activate handler always raised the Library — the
 * `alwaysLibrary` oracle below — and this property fails against it on the
 * first sequence that focuses Settings after the Library.
 */

const WINDOWS = ["library", "settings", "sizzle", "logs", "doc"] as const;
type Win = (typeof WINDOWS)[number];

type Event =
  | { kind: "focus"; window: Win }
  | { kind: "minimize"; window: Win }
  | { kind: "hide"; window: Win }
  | { kind: "close"; window: Win }
  | { kind: "reopen"; window: Win };

const eventArb: fc.Arbitrary<Event> = fc.record({
  kind: fc.constantFrom("focus", "minimize", "hide", "close", "reopen"),
  window: fc.constantFrom(...WINDOWS)
}) as fc.Arbitrary<Event>;

type World = {
  state: Map<Win, ActivateWindowState>;
  lastFocusedAt: Map<Win, number>;
};

/** Reopening a closed singleton creates a NEW window object; a stale
 *  reference to the old one must never be raised. Model that with an
 *  identity that changes on every reopen. */
type Handle = { name: Win; generation: number };

function modelPick(world: World): Win | null {
  const focused = [...world.lastFocusedAt.entries()]
    .filter(([name]) => world.state.get(name) !== "gone")
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  const visible = focused.find((name) => world.state.get(name) === "visible");
  if (visible !== undefined) return visible;
  const minimized = focused.find((name) => world.state.get(name) === "minimized");
  if (minimized !== undefined) return minimized;
  return null;
}

function run(events: readonly Event[], pick: (order: AppWindowFocusOrder<Handle>, stateOf: (h: Handle) => ActivateWindowState) => Handle | null): void {
  const order = new AppWindowFocusOrder<Handle>();
  const world: World = { state: new Map(), lastFocusedAt: new Map() };
  const live = new Map<Win, Handle>();
  let generation = 0;
  for (const name of WINDOWS) {
    world.state.set(name, "visible");
    live.set(name, { name, generation: generation++ });
  }
  const stateOf = (h: Handle): ActivateWindowState =>
    live.get(h.name) === h ? (world.state.get(h.name) ?? "gone") : "gone";

  let clock = 0;
  for (const event of events) {
    const current = world.state.get(event.window);
    switch (event.kind) {
      case "focus":
        // A window can only take focus when it exists; focusing a
        // minimized/hidden one un-minimizes/shows it.
        if (current === "gone") break;
        world.state.set(event.window, "visible");
        world.lastFocusedAt.set(event.window, ++clock);
        order.noteFocused(live.get(event.window)!);
        break;
      case "minimize":
        if (current === "visible") world.state.set(event.window, "minimized");
        break;
      case "hide":
        if (current === "visible") world.state.set(event.window, "hidden");
        break;
      case "close":
        world.state.set(event.window, "gone");
        world.lastFocusedAt.delete(event.window);
        break;
      case "reopen":
        if (current !== "gone") break;
        world.state.set(event.window, "visible");
        live.set(event.window, { name: event.window, generation: generation++ });
        break;
    }

    const actual = pick(order, stateOf);
    const expected = modelPick(world);
    expect(actual === null ? null : actual.name).toEqual(expected);
    if (actual !== null) expect(stateOf(actual)).not.toBe("gone");
  }
}

describe("AppWindowFocusOrder — Dock click brings back the last window", () => {
  it("agrees with the model on every event sequence", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        run(events, (order, stateOf) => order.pickForActivate(stateOf));
      }),
      { numRuns: 500 }
    );
  });

  it("the pre-fix always-Library behavior fails the same property", () => {
    // Oracle for the old activate handler: whatever was focused, raise
    // the Library. Kept so the property's power is pinned, not assumed.
    const alwaysLibrary = (
      order: AppWindowFocusOrder<Handle>,
      stateOf: (h: Handle) => ActivateWindowState
    ): Handle | null => {
      const real = order.pickForActivate(stateOf);
      if (real === null) return null;
      const library = order.snapshot().find((h) => h.name === "library");
      return library ?? real;
    };
    expect(() =>
      fc.assert(
        fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
          run(events, alwaysLibrary);
        }),
        { numRuns: 500 }
      )
    ).toThrow();
  });

  it("Settings focused after the Library is what comes back", () => {
    const order = new AppWindowFocusOrder<string>();
    order.noteFocused("library");
    order.noteFocused("settings");
    expect(order.pickForActivate(() => "visible")).toBe("settings");
  });
});
