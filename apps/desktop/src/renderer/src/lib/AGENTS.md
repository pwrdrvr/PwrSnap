# renderer/lib — AGENTS.md

Shared renderer primitives. The repo-wide rules are in the root
[AGENTS.md](../../../../../../AGENTS.md). **Before adding or changing a
dialog, popover, menu, keyboard handler or tooltip, or one of the focus hooks,
read
[docs/agents/renderer-focus-hooks.md](../../../../../../docs/agents/renderer-focus-hooks.md).**
It holds the full rules, the measurements behind them, and the test recipe.

- **Click-opened overlays go through the focus hooks.** `useModal` /
  `useDismissable` / `useFocusTrap` / `useMenuNavigation` / `useFocusReturn`;
  never hand-roll a keydown effect for Escape or Tab. `useMenuNavigation` is
  not optional on a `role="menu"`.
- **A menu shows a ring only for the keyboard.**
- **Escape: one owner, and the key goes no further.** One module-level
  window-capture listener, installed at load and never removed; never add a
  second overlay Escape listener. Dismiss runs before focus moves.
- **Tab: one trap owner, by the same rule.**
- **`dismissOnFocusLeave` listens for `focusin`, not a deferred `focusout`.**
- **Hover tooltips: `data-tip`, not `title`.** One `useFastTooltip` per
  window, mounted by `App`; never `data-tip` and `title` together or nested;
  the tooltip describes, the `aria-label` names. *Where `title` stays*: the
  recording HUD, the float-over dock, and text that already says what the
  control does.
- **Testing.** jsdom has no focus navigation or layout; then check in real
  headless Chromium. Headed E2E belongs in the lab VM.
