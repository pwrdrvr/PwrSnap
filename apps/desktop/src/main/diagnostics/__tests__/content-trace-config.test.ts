import { describe, expect, test } from "vitest";
import {
  CONTENT_TRACE_DEFAULT_CATEGORIES,
  resolveContentTraceConfig
} from "../content-trace-config";

describe("resolveContentTraceConfig", () => {
  test("is disabled unless PWRSNAP_TRACE is set", () => {
    expect(resolveContentTraceConfig({ env: {} })).toEqual({ enabled: false });
    expect(resolveContentTraceConfig({ env: { PWRSNAP_TRACE: "0" } })).toEqual({
      enabled: false
    });
  });

  test("arms with the GPU/compositor category set by default", () => {
    const config = resolveContentTraceConfig({
      env: { PWRSNAP_TRACE: "1" },
      outputRoot: "/out"
    });
    expect(config).toMatchObject({
      enabled: true,
      outputRoot: "/out",
      categories: [...CONTENT_TRACE_DEFAULT_CATEGORIES],
      durationMs: 15_000,
      autoStartDelayMs: 0
    });
  });

  test("keeps the disabled-by-default frame category, which must be opted into explicitly", () => {
    expect(CONTENT_TRACE_DEFAULT_CATEGORIES).toContain(
      "disabled-by-default-devtools.timeline.frame"
    );
  });

  test("PWRSNAP_TRACE_CATEGORIES replaces the default set", () => {
    const config = resolveContentTraceConfig({
      env: { PWRSNAP_TRACE: "1", PWRSNAP_TRACE_CATEGORIES: " viz , gpu ,, " }
    });
    expect(config).toMatchObject({ enabled: true, categories: ["viz", "gpu"] });
  });

  test("an all-blank category override falls back to the defaults", () => {
    const config = resolveContentTraceConfig({
      env: { PWRSNAP_TRACE: "1", PWRSNAP_TRACE_CATEGORIES: " , ," }
    });
    expect(config).toMatchObject({ categories: [...CONTENT_TRACE_DEFAULT_CATEGORIES] });
  });

  test("duration is clamped to a sane recording window", () => {
    const tooShort = resolveContentTraceConfig({
      env: { PWRSNAP_TRACE: "1", PWRSNAP_TRACE_DURATION_MS: "10" }
    });
    const tooLong = resolveContentTraceConfig({
      env: { PWRSNAP_TRACE: "1", PWRSNAP_TRACE_DURATION_MS: "999999" }
    });
    expect(tooShort).toMatchObject({ durationMs: 1_000 });
    expect(tooLong).toMatchObject({ durationMs: 120_000 });
  });

  test("autostart delay is opt-in", () => {
    const config = resolveContentTraceConfig({
      env: { PWRSNAP_TRACE: "1", PWRSNAP_TRACE_AUTOSTART_DELAY_MS: "20000" }
    });
    expect(config).toMatchObject({ autoStartDelayMs: 20_000 });
  });
});
