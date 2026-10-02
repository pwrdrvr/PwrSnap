import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatgptPlanCard } from "../ChatgptPlanCard";
import type { ChatgptPlanStatus } from "@pwrsnap/shared";
vi.mock("../../SettingsContext", () => ({ useSettingsContext: () => ({ settings: { codex: {} } }) }));
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; root = undefined; });
async function render(status: ChatgptPlanStatus) {
  const calls: Array<{ name: string; req: unknown }> = [];
  Object.defineProperty(window, "pwrsnapApi", { configurable: true, value: { dispatch: async (name: string, req: Record<string, boolean>) => {
    calls.push({ name, req });
    if (name === "chatgptPlan:configure") status = { ...status,
      ...(req.backgroundConsent !== undefined ? { backgroundConsent: req.backgroundConsent } : {}),
      ...(req.welcomeSeen !== undefined ? { welcomeSeen: req.welcomeSeen } : {}) };
    return { ok: true, value: status };
  } } });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<ChatgptPlanCard />));
  return { container, calls };
}
const granted: ChatgptPlanStatus = { label: "Fixture account", connected: true, enabled: true, planGranted: true, welcomeSeen: false, backgroundConsent: false };
describe("ChatGPT plan Settings", () => {
  test("first grant welcomes once and acknowledgement persists; no automatic consent", async () => {
    const { container, calls } = await render(granted);
    expect(container.textContent).toContain("PwrSnap is free");
    expect(container.textContent).toContain("Continue with ChatGPT");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const checkbox = container.querySelector<HTMLButtonElement>('[aria-label="Allow automatic post-capture use"]')!;
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    const gotIt = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Got it")!;
    await act(async () => gotIt.click());
    expect(calls).toContainEqual({ name: "chatgptPlan:configure", req: { welcomeSeen: true } });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  test("returning grant has no welcome and links Manage usage and Learn more", async () => {
    const { container, calls } = await render({ ...granted, welcomeSeen: true });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("Using ChatGPT plan");
    const manage = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Manage usage")!;
    await act(async () => manage.click());
    expect(calls).toContainEqual({ name: "app:openExternal", req: { url: "https://chatgpt.com/settings/usage" } });
    const checkbox = container.querySelector<HTMLButtonElement>('[aria-label="Allow automatic post-capture use"]')!;
    await act(async () => checkbox.click());
    expect(calls).toContainEqual({ name: "chatgptPlan:configure", req: { backgroundConsent: true } });
  });
});
