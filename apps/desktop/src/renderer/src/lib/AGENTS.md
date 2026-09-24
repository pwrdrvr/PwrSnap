# renderer/lib — AGENTS.md

Shared renderer primitives. The repo-wide rules are in the root
[AGENTS.md](../../../../../../AGENTS.md).

## Click-opened overlays go through the focus hooks

Every dialog, confirm popover and menu gets its keyboard behaviour from the
hooks here. Don't hand-roll a keydown effect for Escape or Tab. Before these
existed, each overlay had its own listener on a target and phase its author
picked. Measured in headless Chromium across nine surfaces, the result was:

- eight let Tab walk out behind them while they were still open;
- six dropped focus to `<body>` on Escape;
- `AiConsentDialog` and the Sizzle capture picker ignored Escape entirely;
- one Escape in the storage popover also collapsed the inspector rail.

| Surface | Hooks | Markup |
|---|---|---|
| Modal dialog | `useModal` (= `useDismissable` + `useFocusTrap`) | `role="dialog" aria-modal="true" tabIndex={-1}` |
| `role="menu"` | `useDismissable` + `useMenuNavigation`, plus `closeWhenFocusLeaves` on the root's `onBlur` for focus that leaves without Tab | items keep `tabIndex={-1}` in JSX; the hook roves the one `0` |
| Non-modal popover right after its trigger in the DOM (zoom, storage, the phrase and cart pickers) | `useDismissable({ triggerRef, dismissOnFocusLeave: true })`, plus `useFocusReturn` when closing can strand focus (a row that closes it, a surface that hides rather than unmounts) — the storage popover has neither, so it goes without | trigger has `aria-expanded` |
| Portalled, light-dismiss popover (`ToolStylePopover`) | `useFocusTrap` + `useDismissable` | treat it as modal: focus cannot follow the DOM back to its caret |

**While focus is in a menu, the menu owns the plain keys.** Its listener is
on window capture, installed when the module loads, so it runs ahead of the
editor's capture-phase nudge and tool letters and the Library grid's arrows
and Enter, and it stops every unmodified key but Escape and Tab. Before
that, the arrows in the editor's layer menu nudged the right-clicked layer
and never moved the menu.

`useMenuNavigation` is not optional on a `role="menu"`. The role promises
arrow keys, Home/End and typeahead, and a screen-reader user who hears "menu"
will try them. A popover that holds a text field or step buttons is not a
menu, and can't honour that promise. `ZoomMenu` was `role="menu"` and is a
`role="dialog"` now.

## Escape: one owner, and the key goes no further

`useDismissable` has **one** module-level listener. For each keypress it
picks the registered overlay that holds focus: the deepest one, with its
trigger counting as holding. If focus is on `<body>`, null or detached, it
picks the newest. If focus is in something unregistered, nobody claims the
key.

**A claimed Escape is stopped** (`stopImmediatePropagation`), not just
default-prevented. PwrSnap's app-level Escape handlers don't check
`defaultPrevented`:

- the Library view's keydown (leave Focus, collapse the rail);
- the editor's selection clear (window **capture**);
- `RightActivityBar`;
- the Sizzle inspector.

Stopping the event works without editing each of them. It only works
because this listener is the **first** window-capture keydown listener. So:

- It is installed when the module is evaluated and is never removed. Adding
  and removing it as overlays open would put it behind the editor's.
- Don't add a second overlay Escape listener anywhere. It would either run
  behind this one and never see the key, or run ahead of it and close
  something that isn't the owner.
- A new app-level Escape handler needs no `defaultPrevented` check. It will
  simply never see a key an overlay claimed.

**Dismiss runs before focus moves.** The handler calls `onDismiss`, then
parks focus on the trigger only if focus is still inside the overlay.
Moving focus first blurs the focused field while the overlay is still live.
A field that commits on blur then commits the edit Escape was meant to throw
away, which is what the zoom field did. Because blur runs before React
re-renders, a caller that discards state on Escape needs a ref the blur
handler can read (`ZoomMenu`'s `discardRef`).

### A native `<dialog>` closes itself only if the key is unclaimed

If you call `preventDefault` on Escape's keydown, Chromium does not run the
`<dialog>` close. Since `useModal` claims the key, `onClose` has to call
`dialog.close()` itself. Two more rules for a dialog opened with
`showModal()`:

- Track `open` in state set right after `showModal()`.
- Pass `returnFocusRef` explicitly. `showModal()` has already moved focus
  inside by the time React renders, so the render-time opener capture finds
  nothing. The custom-colour dialog in `ToolStylePopover` is the worked
  example.

## Tab: one trap owner, by the same rule

`useFocusTrap` resolves one owner per keypress: the trap holding focus,
deepest first, otherwise the newest. Stacked traps (a `ChatApprovalModal`
over an open `DeleteConfirm`) would otherwise fight over every Tab. Four
details are load-bearing, and each is pinned in
`__tests__/useFocusTrap.test.tsx`:

- **Scrollers are Tab stops with no tabindex.** Chromium makes an
  overflowing scroller with nothing focusable inside it a stop on its own,
  and its `tabIndex` still reads -1. `.pss__modal-body` and the approval
  modal's `<pre>` are both this. The trap checks layout to find the real
  ends of the cycle. Initial focus skips scrollers.
- **Focus on the dialog container itself** (a click on blank space,
  `tabIndex={-1}`). Tab goes to the first control and Shift+Tab to the
  last. Without this, Shift+Tab walked backwards out of the dialog.
- **A menu portalled out of a trapped dialog must still close on Tab.** The
  trap claims the key and moves focus only after `useMenuNavigation` has
  closed the menu.
- **The opener is captured during render, not in an effect.** React applies
  `autoFocus` while committing, before passive effects run. By the time an
  effect looked, the dialog's own field held focus and was recorded as the
  opener. `useFocusReturn` owns this, and `useMenuNavigation` and
  `useFocusTrap` both call it.

The trap only handles Tab. Focus moved some other way (a click where there
is no scrim, a programmatic `focus()`) is the component's to answer:
`AiConsentDialog` and `ChatApprovalModal` pull it back, and `DeleteConfirm`
closes. Either of the first and last can be open when an agent approval
arrives, so both ignore focus landing in an `aria-modal`. Otherwise the
confirm would close under the approval, and two containments would pull
focus back and forth.

## `dismissOnFocusLeave` listens for `focusin`, not a deferred `focusout`

Three versions were tried, and only the third works:

- **Close on `focusout`.** At that point `activeElement` is `<body>`, so
  unmounting there let `useFocusReturn` pull focus back to the trigger. Tab
  past the zoom popover landed on the zoom button.
- **Close from a `setTimeout(0)` that re-checks `activeElement`.** This lost
  a race. Chromium runs queued input ahead of timers, so on fast Tabs the
  re-check fired four keypresses late, found focus back on the trigger and
  kept the popover open. In one run out of three, the popover stayed open
  for all 60 Tabs of a walk.
- **Close on a document `focusin`.** It fires once focus has landed, so it
  needs no timer and can't close mid-move. When focus goes nowhere (a click
  on padding, the window blurring), no `focusin` fires, so those don't close
  the popover.

Use `dismissOnFocusLeave` only for a popover that sits right after its
trigger in the DOM. A modal traps focus instead.

## Testing

jsdom has no sequential focus navigation, so a dispatched Tab moves nothing
on its own. Assert what the trap did: that it called `preventDefault` and
where it moved focus. For a step the browser should take, assert that the
event was left alone. jsdom does no layout either, so a scroller test
supplies `scrollHeight`/`clientHeight` and spies on `.focus()`, because
jsdom won't focus an element with no tabindex. `__tests__/useFocusTrap.test.tsx`
has examples of each.

Then check the result in real Chromium with real key presses. Mount the
component in a scratch Vite page between two buttons, and drive it from
headless Playwright: Tab and Shift+Tab about 60 times, Escape, and Shift+Tab
from the container. Delete the scratch page afterwards. Headed desktop E2E
belongs in the lab VM, not on the operator's machine (see the root
AGENTS.md).
