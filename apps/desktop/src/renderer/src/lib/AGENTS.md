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

## A menu shows a ring only for the keyboard

A right-click menu opens with focus on the menu itself (no outline), not on
its first row. From the keyboard it opens on the first row. The pointer
selects what it is over: moving onto a row focuses it with
`focusVisible: false`, so the arrow keys carry on from that row, and the ring
appears on the next key press. A submenu opened by hover leaves focus on its
row. ArrowRight, Enter or Space goes in.

Before this, a right-click put a ring on the first row ("Edit") while the
pointer was elsewhere, and hovering into a submenu moved the ring onto its
first row. Whether either ring showed was Chromium's `:focus-visible` guess
from the last input, so one click in the menu made them vanish. The last
input is tracked in `useMenuNavigation` (`lastInput`, `lastMenuInput()`), and
the hook decides. Chromium's heuristic no longer does.

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

## Hover tooltips: `data-tip`, not `title`

An icon-only control's tooltip is the only label a sighted user gets, and
the native `title` tooltip is too slow to be that. In Electron on macOS it
waits out the system delay and restarts it on every pointer move, so it
often took ~3s of holding still. `useFastTooltip` shows after 350ms, and
once one is up, the next control's shows at once (a 400ms warm window).

**One instance per window, mounted by `App`.** Its listeners are on
`document`, so every surface in that renderer is covered: the Library,
Settings, Sizzle, the tray popover, the float-over toast, the region
selector, and anything portaled to `<body>`. A control opts in with
`data-tip` (first line), `data-tip-keys` (key chip) and `data-tip-detail`
(further lines, `\n`-separated). Don't mount a second instance or give a
surface a root of its own. Two instances would answer every hover with a
tooltip of the same id, so a second one logs an error and stays inert.

Rules, each pinned by a test:

- **Never `data-tip` and `title` together, nor one inside the other.** The
  browser shows an ancestor's `title` too, so a fast tip inside a
  `title`-bearing row still gets the slow one ~3s later.
  `__tests__/fast-tooltip-contract.test.ts` reads the JSX for both. It
  cannot see a `title` passed through a prop or a spread, so a reviewer has
  to: `ClipLane`'s poster `<img title>` was one, inside a tipped button.
- **The tooltip is a description, never the name.** Every opted-in button,
  link or `role` element still needs `aria-label` or text; the same test
  checks. Several icon buttons had only `title` for a name, and got an
  `aria-label` when they moved. While a tip is up it is appended to the
  anchor's `aria-describedby`, and on hide only that token comes out.
  Restoring a snapshot instead would write back a value React changed in
  the meantime (an export card drops its progress id). It is skipped when
  the tip would only repeat the name.
- **It never takes a key.** Any keydown hides it and carries on. The
  listener is on `document` capture, because `useDismissable`'s Escape
  listener must stay the first window-capture listener (above). An Escape
  that listener claims never reaches document capture, so Escape's keyup
  hides it too. Only Escape's: a Tab's keyup lands after the focus move
  has shown the next control's tooltip.
- **It shows on keyboard focus only when `:focus-visible`**, so a click
  does not pop one up under the pointer. A tipped `<label>` shows when the
  checkbox inside it is focused.
- **It never covers the focused control's ring.** It sits `GAP_PX` (8)
  away, past the ring's 4px reach (root AGENTS.md, "Focus rings"). It is
  never clamped vertically: with no room on either side it takes the
  roomier side and runs off the edge, rather than sliding back over the
  ring.
- **An anchor that leaves the DOM takes its tooltip with it**, through the
  same `hide` the pointer uses. An earlier draft cleared only the rendered
  tip, so the hook still thought one was up and showed the next hover's at
  once.
- **It follows its anchor on scroll rather than hiding.** A control that
  takes keyboard focus inside a scroller is scrolled into view just after,
  so hiding on scroll would hide every such tooltip as soon as it showed.

### Where `title` stays

The in-page tooltip cannot leave its window, and the native one can,
because the OS draws it in a window of its own. So the native one stays
where the window is barely bigger than the control:

- **the recording HUD** (`RecordingController`, and `SourceChip` at
  `dense` density). It is a window sized to its own pill, and an in-page
  tooltip would cover its own buttons mid-take. The dense chip's `title` now carries the
  source name the chip no longer draws.
- **the float-over dock and recent rail** (`FloatOverDock`). The dock rests
  as an 18px sliver, sized exactly to what it draws.

`title` also stays wherever the visible text already says what the control
does and the tooltip only adds to it. That covers truncated text whose full
value is the title (paths, model ids, thread and layer names), status lines,
and labelled buttons with a longer explanation ("Test", "Regenerate",
"Split into scenes"). Switch to `data-tip` when a sighted user cannot tell
what the control does without the tooltip.

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
