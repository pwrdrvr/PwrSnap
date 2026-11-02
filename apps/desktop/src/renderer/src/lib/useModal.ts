// The whole keyboard contract for a modal dialog, in one call.
//
// Put the returned ref on the dialog element and give that element
// `role="dialog"`, `aria-modal="true"` and `tabIndex={-1}`. Then:
//
// - Escape closes, and only the overlay the user is in answers it, so a menu
//   or confirm open over the dialog does not take the dialog down with it
//   (`useDismissable`).
// - Tab stays inside, which is what makes it a modal rather than a panel that
//   happens to sit on top (`useFocusTrap`, SC 2.4.3).
// - Focus moves in on open and back to whatever opened it on close.
//
// Dismissal here means "the user asked to leave". A dialog mid-flight (a reset
// being written, an approval being submitted) passes an `onClose` that
// refuses, exactly as its backdrop click already does — this hook does not
// decide that.

import { useRef, type RefObject } from "react";
import { useDismissable } from "./useDismissable";
import { useFocusTrap } from "./useFocusTrap";

export function useModal<T extends HTMLElement = HTMLDivElement>({
  open = true,
  onClose,
  initialFocusRef,
  returnFocusRef
}: {
  /** For a dialog that stays mounted while closed. Defaults to true — most
   *  dialogs here mount only while open. */
  open?: boolean;
  onClose: () => void;
  /** Where focus lands on open. Defaults to the first tabbable control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Where focus goes on close. Defaults to whatever held it at open. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}): RefObject<T | null> {
  const surfaceRef = useRef<T>(null);
  useDismissable({ open, onDismiss: onClose, surfaceRef });
  useFocusTrap({
    open,
    containerRef: surfaceRef,
    ...(initialFocusRef === undefined ? {} : { initialFocusRef }),
    ...(returnFocusRef === undefined ? {} : { returnFocusRef })
  });
  return surfaceRef;
}
