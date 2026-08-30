import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type Mock
} from "vitest";
import { bus } from "../../command-bus";
import { HotkeyRecorderSuspension } from "../../hotkeys/hotkey-recorder-suspension";
import { defaultSettings } from "../../settings/desktop-settings-service";
import { registerHotkeyRecorderSuspensionHandlers } from "../hotkey-recorder-handlers";

let suspension: HotkeyRecorderSuspension;
let isLiveSettingsOwner: Mock<
  (windowId: number, documentId: string) => boolean
>;

const DOCUMENT_A = "documentepoch0001";
const DOCUMENT_B = "documentepoch0002";
const DOCUMENT_C = "documentepoch0003";

function ipcContext(sourceWindowId: number, sourceDocumentId = DOCUMENT_A) {
  return { principal: "ipc" as const, sourceWindowId, sourceDocumentId };
}

beforeEach(() => {
  isLiveSettingsOwner = vi.fn(() => true);
  suspension = new HotkeyRecorderSuspension({
    timeoutMs: 10_000,
    logger: { info: vi.fn(), warn: vi.fn() }
  });
  registerHotkeyRecorderSuspensionHandlers(
    suspension,
    {
      registrationManager: null,
      withSerializedSettings: async (operation) => operation(defaultSettings())
    },
    isLiveSettingsOwner
  );
});

afterEach(async () => {
  await suspension.dispose();
  bus.unregister("settings:beginHotkeyRecording");
  bus.unregister("settings:endHotkeyRecording");
});

describe("hotkey recorder suspension commands", () => {
  test("binds renderer begin/end to the exact source window and session", async () => {
    const begun = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "settings_row_a", generation: 1 },
      ipcContext(41)
    );
    expect(begun).toEqual({
      ok: true,
      value: expect.objectContaining({ sessionId: "settings_row_a" })
    });
    expect(suspension.isSuspended()).toBe(true);

    const wrongWindow = await bus.dispatch(
      "settings:endHotkeyRecording",
      { sessionId: "settings_row_a", generation: 1 },
      ipcContext(77, DOCUMENT_B)
    );
    expect(wrongWindow).toEqual({ ok: true, value: { ended: false } });
    expect(suspension.isSuspended()).toBe(true);

    const ended = await bus.dispatch(
      "settings:endHotkeyRecording",
      { sessionId: "settings_row_a", generation: 1 },
      ipcContext(41)
    );
    expect(ended).toEqual({ ok: true, value: { ended: true } });
    expect(suspension.isSuspended()).toBe(false);
  });

  test("new begin supersedes old while stale renderer end remains harmless", async () => {
    await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "settings_row_a", generation: 1 },
      ipcContext(41)
    );
    await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "settings_row_b", generation: 2 },
      ipcContext(41)
    );
    const stale = await bus.dispatch(
      "settings:endHotkeyRecording",
      { sessionId: "settings_row_a", generation: 1 },
      ipcContext(41)
    );

    expect(stale).toEqual({ ok: true, value: { ended: false } });
    expect(suspension.snapshot()?.sessionId).toBe("settings_row_b");
  });

  test("bridge-only abnormal cleanup releases only its owner", async () => {
    await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "crashed_settings", generation: 1 },
      ipcContext(52, DOCUMENT_C)
    );
    const denied = await bus.dispatch(
      "settings:endHotkeyRecording",
      { ownerWindowId: 52, ownerDocumentId: DOCUMENT_C, reason: "renderer-gone" },
      ipcContext(52, DOCUMENT_C)
    );
    expect(denied).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "hotkey_recorder_owner_cleanup_main_only" })
    });
    expect(suspension.isSuspended()).toBe(true);

    const cleaned = await bus.dispatch(
      "settings:endHotkeyRecording",
      { ownerWindowId: 52, ownerDocumentId: DOCUMENT_C, reason: "renderer-gone" },
      { principal: "bridge" }
    );
    expect(cleaned).toEqual({ ok: true, value: { ended: true } });
    expect(suspension.isSuspended()).toBe(false);
  });

  test("cleanup fences a document before its delayed first begin arrives", async () => {
    const cleaned = await bus.dispatch(
      "settings:endHotkeyRecording",
      { ownerWindowId: 41, ownerDocumentId: DOCUMENT_A, reason: "navigation" },
      { principal: "bridge" }
    );
    const delayed = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "delayed_first_begin", generation: 1 },
      ipcContext(41)
    );

    expect(cleaned).toEqual({ ok: true, value: { ended: false } });
    expect(delayed).toEqual({
      ok: true,
      value: expect.objectContaining({ accepted: false })
    });
    expect(suspension.isSuspended()).toBe(false);

    const newDocument = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "new_document_row", generation: 1 },
      ipcContext(41, DOCUMENT_B)
    );
    expect(newDocument).toEqual({
      ok: true,
      value: expect.objectContaining({ accepted: true })
    });
  });

  test("cleanup rejects a delayed heartbeat from the released document", async () => {
    await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "heartbeat_session", generation: 1 },
      ipcContext(41)
    );
    await bus.dispatch(
      "settings:endHotkeyRecording",
      { ownerWindowId: 41, ownerDocumentId: DOCUMENT_A, reason: "window-closed" },
      { principal: "bridge" }
    );

    const delayedHeartbeat = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "heartbeat_session", generation: 1 },
      ipcContext(41)
    );

    expect(delayedHeartbeat).toEqual({
      ok: true,
      value: expect.objectContaining({ accepted: false })
    });
    expect(suspension.isSuspended()).toBe(false);
  });

  test("rejects non-renderer begin and malformed session ids", async () => {
    const internal = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "valid_session", generation: 1 },
      { principal: "bridge" }
    );
    expect(internal).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "hotkey_recorder_renderer_only" })
    });

    const malformed = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "bad", generation: 1 },
      ipcContext(41)
    );
    expect(malformed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid_hotkey_recorder_session" })
    });
  });

  test("rejects a live PwrSnap renderer that is not the Settings document", async () => {
    isLiveSettingsOwner.mockReturnValue(false);

    const result = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "library_spoofed_recorder", generation: 1 },
      ipcContext(88, DOCUMENT_B)
    );

    expect(isLiveSettingsOwner).toHaveBeenCalledWith(88, DOCUMENT_B);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "hotkey_recorder_settings_window_only"
      })
    });
    expect(suspension.isSuspended()).toBe(false);
  });

  test("accepts Settings ownership attested by the split library process", async () => {
    isLiveSettingsOwner.mockReturnValue(false);

    const result = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "split_settings_recorder", generation: 1 },
      {
        ...ipcContext(88, DOCUMENT_B),
        sourceSettingsHotkeyRecorderOwner: true
      }
    );

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ accepted: true, ownerWindowId: 88 })
    });
    expect(isLiveSettingsOwner).not.toHaveBeenCalled();
    expect(suspension.isSuspended()).toBe(true);
  });

  test("rejects a delayed lower-generation begin without replacing the current row", async () => {
    const current = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "settings_row_b", generation: 2 },
      ipcContext(41)
    );
    const delayed = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "settings_row_a", generation: 1 },
      ipcContext(41)
    );

    expect(current).toEqual({
      ok: true,
      value: expect.objectContaining({ accepted: true, generation: 2 })
    });
    expect(delayed).toEqual({
      ok: true,
      value: expect.objectContaining({ accepted: false, generation: 1 })
    });
    expect(suspension.snapshot()).toMatchObject({
      sessionId: "settings_row_b",
      generation: 2,
      ownerWindowId: 41
    });
  });

  test("requires a valid generation for begin and renderer end", async () => {
    const invalidBegin = await bus.dispatch(
      "settings:beginHotkeyRecording",
      { sessionId: "valid_session", generation: 0 },
      ipcContext(41)
    );
    expect(invalidBegin).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid_hotkey_recorder_generation" })
    });

    const invalidEnd = await bus.dispatch(
      "settings:endHotkeyRecording",
      { sessionId: "valid_session", generation: 0 },
      ipcContext(41)
    );
    expect(invalidEnd).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "invalid_hotkey_recorder_generation" })
    });
  });
});
