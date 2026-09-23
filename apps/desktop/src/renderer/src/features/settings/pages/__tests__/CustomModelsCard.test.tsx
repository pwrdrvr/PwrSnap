import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { CustomModel } from "@pwrsnap/shared";
import { baseSettings } from "../../__tests__/settings-fixture";
import { CustomModelsCard } from "../CustomModelsCard";
const mock = vi.hoisted(() => ({ settings: {} as typeof baseSettings, dispatch: vi.fn(), patch: vi.fn() }));
vi.mock("../../SettingsContext", () => ({ useSettingsContext: () => ({ settings: mock.settings, patch: mock.patch }) }));
vi.mock("../../../../lib/pwrsnap", () => ({ dispatch: mock.dispatch }));
let root: Root | undefined; let host: HTMLDivElement;
beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); mock.dispatch.mockReset(); mock.patch.mockReset(); });
const fixture: CustomModel = { id: "12345678-1234-4234-8234-123456789001", displayName: "Fixture API", modelId: "fixture/model", baseUrl: "http://127.0.0.1:18080/v1", protocol: "openai-chat", auth: { type: "api-key", credentialId: "12345678-1234-4234-8234-123456789002" }, capabilities: { vision: true, streaming: true }, maxOutputTokens: 512 };
async function mount(): Promise<void> {
  mock.settings = { ...baseSettings, ai: { ...baseSettings.ai, customModels: [fixture] } };
  mock.dispatch.mockImplementation(async (command: string) => command === "customModels:status" ? { ok: true, value: { configured: false, sharedBy: 1 } } : { ok: true, value: undefined });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(createElement(CustomModelsCard)));
}
function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === text); if (!found) throw new Error(`Missing ${text}`); return found;
}
async function click(text: string): Promise<void> { await act(async () => button(text).click()); }
test("saved model editor writes a key once, clears the input, and selects the actual custom provider", async () => {
  await mount(); await click("Fixture API");
  const key = host.querySelector<HTMLInputElement>('input[type="password"]'); expect(key).not.toBeNull(); if (!key) return;
  key.value = "synthetic-ui-fixture-key"; await click("Save API key");
  expect(mock.dispatch).toHaveBeenCalledWith("customModels:setKey", { id: fixture.id, value: "synthetic-ui-fixture-key" });
  expect(key.value).toBe(""); expect(JSON.stringify(mock.settings)).not.toContain("synthetic-ui-fixture-key");
  await click("Use for Library chat"); expect(mock.patch).toHaveBeenCalledWith({ ai: { defaults: { libraryChat: { provider: `custom:${fixture.id}`, model: fixture.modelId, reasoning: "" } } } });
  expect(host.textContent).toContain("Legacy text-only /completions is not supported");
});
test("new models start with independent identities and unknown vision disabled", async () => {
  await mount(); await click("Add custom model");
  const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'); expect(checkboxes[0]?.checked).toBe(false);
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')).toBeNull();
  expect(button("Test connection (text only)").disabled).toBe(true);
  expect(button("Use for enrichment").disabled).toBe(true);
});
