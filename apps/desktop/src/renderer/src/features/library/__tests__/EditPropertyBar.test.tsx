import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultEditorToolBag } from "@pwrsnap/shared";
import { EditPropertyBar } from "../EditPropertyBar";

const arrow = defaultEditorToolBag().slots[0];
if (arrow == null || arrow.tool !== "arrow") throw new Error("default slot 1 is not an arrow");

describe("EditPropertyBar markup order", () => {
  it("puts the buttons before the fields, so the float can sit at the end of row one", () => {
    // library.css floats `.psl__et-props-actions` right. A float cannot
    // rise above the line it follows, so after the fields it landed on a
    // row of its own under them.
    const html = renderToStaticMarkup(
      <EditPropertyBar
        target={{
          kind: "tool",
          tool: "arrow",
          label: "Arrow",
          style: arrow.style,
          armedSlot: 0,
          armedSlotModified: true
        }}
        onFieldChange={() => undefined}
        firstEmptySlot={8}
        onSaveToSlot={() => undefined}
        shortcutPlatform="darwin"
      />
    );
    const actions = html.indexOf('class="psl__et-props-actions"');
    const body = html.indexOf('class="psl__et-props-body"');
    expect(actions).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(actions);
  });
});
