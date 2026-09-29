// Command-bus registration for the `float-over:*` commands. The
// renderer's float-over countdown calls `float-over:dismiss` when it
// auto-dismisses, and `float-over:tuck` when it runs out while
// enrichment is still going; the dock's tabs, the rail beside the
// toast and the overflow menu open snaps through `float-over:open`.

import { err, ok, type FloatOverOverflowItem } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import {
  dismissFloatOver,
  floatOverCapabilities,
  openFloatOverCapture,
  popFloatOverOverflowMenu,
  tuckFloatOver
} from "../float-over";

/** A menu is not a list view: past this many rows it stops being usable
 *  long before it stops being renderable. */
const OVERFLOW_MENU_MAX_ITEMS = 50;
const OVERFLOW_LABEL_MAX_CHARS = 120;
const CAPTURE_ID_MAX_CHARS = 200;

function isCaptureId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= CAPTURE_ID_MAX_CHARS;
}

function invalid(message: string) {
  return err({ kind: "validation" as const, code: "invalid_request", message });
}

function parseOverflowItems(value: unknown): FloatOverOverflowItem[] | null {
  if (!Array.isArray(value) || value.length > OVERFLOW_MENU_MAX_ITEMS) return null;
  const items: FloatOverOverflowItem[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const { captureId, label } = entry as { captureId?: unknown; label?: unknown };
    if (!isCaptureId(captureId) || typeof label !== "string") return null;
    items.push({ captureId, label: label.slice(0, OVERFLOW_LABEL_MAX_CHARS) });
  }
  return items;
}

export function registerFloatOverHandlers(): void {
  bus.register("float-over:dismiss", async () => {
    dismissFloatOver();
    return ok(undefined);
  });

  bus.register("float-over:capabilities", async () => ok(floatOverCapabilities()));

  bus.register("float-over:tuck", async (req) =>
    ok(tuckFloatOver({ markOnly: (req as { markOnly?: unknown } | null)?.markOnly === true }))
  );

  bus.register("float-over:open", async (req) => {
    if (!isCaptureId((req as { captureId?: unknown } | null)?.captureId)) {
      return invalid("float-over:open needs a captureId");
    }
    openFloatOverCapture(req.captureId);
    return ok(undefined);
  });

  bus.register("float-over:overflowMenu", async (req) => {
    const items = parseOverflowItems((req as { items?: unknown } | null)?.items);
    if (items === null) return invalid("float-over:overflowMenu needs a list of snaps");
    const canClearFinished = (req as { canClearFinished?: unknown }).canClearFinished === true;
    return ok({ choice: await popFloatOverOverflowMenu(items, canClearFinished) });
  });
}
