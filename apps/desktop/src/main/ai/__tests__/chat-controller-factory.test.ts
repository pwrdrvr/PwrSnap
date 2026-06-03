import { describe, expect, test } from "vitest";
import type { AiSurfaceDefault } from "@pwrsnap/shared";
import { chatSurfaceDefaultsFromSettings } from "../chat-controller-factory";

describe("chatSurfaceDefaultsFromSettings", () => {
  test("an empty surface default yields no kit knobs (Codex / kit defaults)", () => {
    expect(chatSurfaceDefaultsFromSettings({})).toEqual({});
  });

  test("maps provider → modelProvider, model → model, reasoning → effort", () => {
    const surface: AiSurfaceDefault = {
      provider: "openai",
      model: "gpt-5.5",
      reasoning: "high"
    };
    expect(chatSurfaceDefaultsFromSettings(surface)).toEqual({
      model: "gpt-5.5",
      modelProvider: "openai",
      effort: "high"
    });
  });

  test("only carries the leaves the user pinned (partial surface default)", () => {
    expect(chatSurfaceDefaultsFromSettings({ reasoning: "low" })).toEqual({
      effort: "low"
    });
    expect(chatSurfaceDefaultsFromSettings({ model: "gpt-5.5" })).toEqual({
      model: "gpt-5.5"
    });
  });

  test("empty strings on provider / model are treated as unset", () => {
    expect(
      chatSurfaceDefaultsFromSettings({ provider: "", model: "" })
    ).toEqual({});
  });
});
