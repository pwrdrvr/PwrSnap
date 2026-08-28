import { describe, expect, test } from "vitest";

import type { BundleLayerNode } from "@pwrsnap/shared";

import {
  validateInstalledPwrsnapLayerGraph,
  validatePwrsnapLayerGraph
} from "../pwrsnap-import-reader";

const CREATED_AT = "2026-08-27T12:00:00.000Z";
const ROOT_ID = "graphroot0000001";
const SOURCE_ID = "graphsource00001";
const SOURCE_SHA = "0".repeat(64);

function common(id: string, parentId: string | null) {
  return {
    id,
    parent_id: parentId,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal" as const,
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    z_index: 0,
    source: "user" as const,
    ai_run_id: null,
    applied_at: CREATED_AT,
    rejected_at: null,
    superseded_by: null,
    created_at: CREATED_AT
  };
}

function root(): BundleLayerNode {
  return {
    ...common(ROOT_ID, null),
    kind: "group",
    collapsed: false
  };
}

function source(): BundleLayerNode {
  return {
    ...common(SOURCE_ID, ROOT_ID),
    kind: "raster",
    source_ref: { kind: "embedded", sha256: SOURCE_SHA },
    natural_width_px: 64,
    natural_height_px: 48,
    original_transform: [1, 0, 0, 1, 0, 0]
  };
}

function group(id: string, parentId: string | null): BundleLayerNode {
  return {
    ...common(id, parentId),
    kind: "group",
    collapsed: false
  };
}

function historical(id: string, supersededBy: string | null): BundleLayerNode {
  return {
    ...common(id, ROOT_ID),
    kind: "vector",
    shape: {
      kind: "shape",
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      color: "#ff8a1f"
    },
    superseded_by: supersededBy,
    ...(supersededBy === null ? {} : { rejected_at: CREATED_AT })
  };
}

function historyId(index: number): string {
  return `graphhist${String(index).padStart(7, "0")}`;
}

function expectGraphError(
  validate: (layers: readonly BundleLayerNode[]) => void,
  layers: readonly BundleLayerNode[],
  code: string
): void {
  try {
    validate(layers);
  } catch (cause) {
    expect(cause).toMatchObject({ kind: "corrupt", code });
    return;
  }
  throw new Error(`expected graph validation to fail with ${code}`);
}

function graphErrorCode(
  validate: (layers: readonly BundleLayerNode[]) => void,
  layers: readonly BundleLayerNode[]
): string | null {
  try {
    validate(layers);
    return null;
  } catch (cause) {
    return typeof cause === "object" && cause !== null && "code" in cause
      ? String(cause.code)
      : "unexpected_error";
  }
}

/** Exact replacement-chain behavior from before suffix memoization. */
function legacyReplacementErrorCode(
  layers: readonly BundleLayerNode[]
): string | null {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  for (const layer of layers) {
    if (layer.superseded_by !== null) {
      if (layer.superseded_by === layer.id || !byId.has(layer.superseded_by)) {
        return "layer_superseded_invalid";
      }
    }
    const seen = new Set<string>([layer.id]);
    let replacement = layer.superseded_by;
    while (replacement !== null) {
      if (seen.has(replacement)) return "layer_superseded_cycle";
      seen.add(replacement);
      replacement = byId.get(replacement)?.superseded_by ?? null;
    }
  }
  return null;
}

function deterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const validators = [
  ["external import", validatePwrsnapLayerGraph],
  ["installed repack", validateInstalledPwrsnapLayerGraph]
] as const;

describe.each(validators)("%s graph characterization", (_name, validate) => {
  test("accepts a valid replacement chain regardless of document order", () => {
    const firstId = "graphhistory0001";
    const secondId = "graphhistory0002";
    const thirdId = "graphhistory0003";
    const layers = [
      source(),
      historical(thirdId, null),
      root(),
      historical(firstId, secondId),
      historical(secondId, thirdId)
    ];

    expect(() => validate(layers)).not.toThrow();
  });

  test.each([
    ["self replacement", "graphhistory0001", "graphhistory0001", "layer_superseded_invalid"],
    ["missing replacement", "graphhistory0001", "graphmissing0001", "layer_superseded_invalid"]
  ])("rejects %s with a stable code", (_case, id, supersededBy, code) => {
    expectGraphError(validate, [root(), source(), historical(id, supersededBy)], code);
  });

  test("rejects a replacement cycle from every document entry order", () => {
    const first = historical("graphhistory0001", "graphhistory0002");
    const second = historical("graphhistory0002", "graphhistory0003");
    const third = historical("graphhistory0003", "graphhistory0001");

    for (const cycle of [
      [first, second, third],
      [second, third, first],
      [third, first, second]
    ]) {
      expectGraphError(
        validate,
        [root(), source(), ...cycle],
        "layer_superseded_cycle"
      );
    }
  });

  test("accepts converging replacement chains", () => {
    const terminal = historical(historyId(3), null);
    const shared = historical(historyId(2), terminal.id);
    const left = historical(historyId(0), shared.id);
    const right = historical(historyId(1), shared.id);

    expect(() => validate([root(), source(), right, terminal, left, shared])).not.toThrow();
  });

  test("rejects a tail that enters a replacement cycle", () => {
    const tail = historical(historyId(0), historyId(1));
    const first = historical(historyId(1), historyId(2));
    const second = historical(historyId(2), historyId(1));

    expectGraphError(
      validate,
      [root(), source(), tail, first, second],
      "layer_superseded_cycle"
    );
  });

  test("accepts the schema maximum of 4,096 layers in one replacement chain", () => {
    const historyCount = 4_094; // root + source + history = schema max
    const history = Array.from({ length: historyCount }, (_, index) =>
      historical(
        historyId(index),
        index + 1 < historyCount ? historyId(index + 1) : null
      )
    );

    expect(() => validate([root(), source(), ...history])).not.toThrow();
  });

  test("accepts rejected history beneath rejected ancestry", () => {
    const rejectedParent = {
      ...group("graphgroup000001", ROOT_ID),
      rejected_at: CREATED_AT
    };
    const rejectedChild = {
      ...historical("graphhistory0001", null),
      parent_id: rejectedParent.id,
      rejected_at: CREATED_AT
    };

    expect(() => validate([root(), source(), rejectedParent, rejectedChild])).not.toThrow();
  });

  test("applies raster allocation limits to live content but not rejected history", () => {
    const oversizedTransform: [number, number, number, number, number, number] = [
      1_000,
      0,
      0,
      1_000,
      0,
      0
    ];
    expectGraphError(
      validate,
      [root(), { ...source(), transform: oversizedTransform }],
      "raster_transform_limit"
    );

    const rejectedRaster = {
      ...source(),
      id: "graphhistory0001",
      name: "Rejected oversized raster",
      transform: oversizedTransform,
      rejected_at: CREATED_AT
    };
    expect(() => validate([root(), source(), rejectedRaster])).not.toThrow();
  });

  test("rejects a live layer beneath non-live ancestry", () => {
    const rejectedParent = {
      ...group("graphgroup000001", ROOT_ID),
      rejected_at: CREATED_AT
    };
    const liveChild = {
      ...historical("graphhistory0001", null),
      parent_id: rejectedParent.id
    };

    expectGraphError(
      validate,
      [root(), source(), rejectedParent, liveChild],
      "live_layer_disconnected"
    );
  });

  test("rejects duplicate IDs before following graph edges", () => {
    expectGraphError(
      validate,
      [root(), source(), { ...source(), name: "duplicate" }],
      "layer_id_duplicate"
    );
  });

  test("distinguishes missing parents from parent cycles", () => {
    const missingParent = {
      ...historical("graphhistory0001", null),
      parent_id: "graphmissing0001"
    };
    expectGraphError(
      validate,
      [root(), source(), missingParent],
      "layer_parent_invalid"
    );

    const first = {
      ...group("graphgroup000001", "graphgroup000002"),
      applied_at: null
    };
    const second = {
      ...group("graphgroup000002", "graphgroup000001"),
      applied_at: null
    };
    expectGraphError(
      validate,
      [root(), source(), first, second],
      "layer_parent_cycle"
    );
  });

  test("accepts depth 32 and rejects depth 33", () => {
    const chain = Array.from({ length: 33 }, (_, index) => {
      const id = `graphgrp${String(index + 1).padStart(8, "0")}`;
      const parentId =
        index === 0
          ? ROOT_ID
          : `graphgrp${String(index).padStart(8, "0")}`;
      return group(id, parentId);
    });

    expect(() => validate([root(), source(), ...chain.slice(0, 32)])).not.toThrow();
    expectGraphError(
      validate,
      [root(), source(), ...chain],
      "layer_depth_limit"
    );
  });

  test("matches legacy replacement outcomes across deterministic mixed graphs", () => {
    const random = deterministicRandom(0x504);
    for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
      const count = 1 + Math.floor(random() * 12);
      const ids = Array.from({ length: count }, (_, index) => historyId(index));
      const history = ids.map((id) => {
        const choice = random();
        const supersededBy =
          choice < 0.25
            ? null
            : choice < 0.4
              ? id
              : choice < 0.85
                ? ids[Math.floor(random() * ids.length)]!
                : "graphmissing0001";
        return historical(id, supersededBy);
      });
      for (let index = history.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [history[index], history[swapIndex]] = [history[swapIndex]!, history[index]!];
      }
      const layers = [root(), source(), ...history];
      const expected = legacyReplacementErrorCode(layers);
      expect(
        graphErrorCode(validate, layers),
        `case ${caseIndex}: ${history.map((layer) => `${layer.id}->${layer.superseded_by}`).join(",")}`
      ).toBe(expected);
    }
  });
});
