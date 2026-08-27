import { describe, expect, test, vi } from "vitest";
import type { DesktopCapturerSource, WebFrameMain } from "electron";
import {
  createSelectorDisplayMediaBroker,
  selectExactDisplaySource,
  selectorDisplayMediaStrategy
} from "../selector-display-media";

function source(id: string, displayId: string): DesktopCapturerSource {
  return {
    id,
    name: id,
    display_id: displayId,
    appIcon: null,
    thumbnail: { isEmpty: () => true }
  } as unknown as DesktopCapturerSource;
}

describe("selector display-media strategy", () => {
  test.each([
    ["win32", "renderer-display-media"],
    ["darwin", "renderer-display-media"],
    ["linux", "legacy-file"]
  ] as const)("uses %s strategy", (platform, expected) => {
    expect(selectorDisplayMediaStrategy(platform)).toBe(expected);
  });

  test("matches the exact Electron display id without relying on ordering", () => {
    const wanted = source("screen:2:0", "22");
    expect(selectExactDisplaySource([source("screen:1:0", "11"), wanted], 22, 2)).toBe(wanted);
    expect(selectExactDisplaySource([source("screen:1:0", ""), wanted], 99, 2)).toBeNull();
  });

  test("accepts an id-less source only when one source and one display exist", () => {
    const only = source("screen:0:0", "");
    expect(selectExactDisplaySource([only], 7, 1)).toBe(only);
    expect(selectExactDisplaySource([only], 7, 2)).toBeNull();
  });
});

describe("selector display-media broker", () => {
  test("authorizes one video-only request from the exact active selector frame", async () => {
    const chosen = source("screen:9:0", "9");
    const getSources = vi.fn(async () => [chosen]);
    const broker = createSelectorDisplayMediaBroker({ getSources });
    let handler: ((request: never, callback: (streams: unknown) => void) => void) | null = null;
    const session = {
      setDisplayMediaRequestHandler: vi.fn((next) => {
        handler = next;
      })
    } as never;
    const frameValue = {
      url: "file:///app/index.html#stage=region&displayId=9"
    };
    const frame = frameValue as WebFrameMain;
    broker.install(session);
    expect(
      broker.arm(session, {
        invocationId: 41,
        displayId: 9,
        displayCount: 1,
        frame,
        frameUrl: frameValue.url,
        isStillActive: () => true
      })
    ).toBe(true);

    const callback = vi.fn();
    handler!(
      {
        frame,
        securityOrigin: "file://",
        videoRequested: true,
        audioRequested: false,
        userGesture: false
      } as never,
      callback
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(getSources).toHaveBeenCalledWith({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    });
    expect(callback).toHaveBeenCalledWith({
      video: { id: chosen.id, name: chosen.name }
    });

    const second = vi.fn();
    handler!(
      {
        frame,
        securityOrigin: "file://",
        videoRequested: true,
        audioRequested: false,
        userGesture: false
      } as never,
      second
    );
    expect(second).toHaveBeenCalledWith({});
  });

  test.each([
    { videoRequested: true, audioRequested: true, label: "audio" },
    { videoRequested: false, audioRequested: false, label: "no video" }
  ])("denies $label and consumes the grant", ({ videoRequested, audioRequested }) => {
    const broker = createSelectorDisplayMediaBroker({
      getSources: vi.fn(async () => [])
    });
    let handler: ((request: never, callback: (streams: unknown) => void) => void) | null = null;
    const session = {
      setDisplayMediaRequestHandler: vi.fn((next) => {
        handler = next;
      })
    } as never;
    const frameValue = {
      url: "http://localhost:5173/#stage=region&displayId=1"
    };
    const frame = frameValue as WebFrameMain;
    broker.install(session);
    broker.arm(session, {
      invocationId: 1,
      displayId: 1,
      displayCount: 1,
      frame,
      frameUrl: frameValue.url,
      isStillActive: () => true
    });
    const callback = vi.fn();
    handler!(
      {
        frame,
        securityOrigin: "http://localhost:5173",
        videoRequested,
        audioRequested,
        userGesture: false
      } as never,
      callback
    );
    expect(callback).toHaveBeenCalledWith({});
  });

  test("denies another frame before source enumeration", () => {
    const getSources = vi.fn(async () => [source("screen:1:0", "1")]);
    const broker = createSelectorDisplayMediaBroker({ getSources });
    let handler: ((request: never, callback: (streams: unknown) => void) => void) | null = null;
    const session = {
      setDisplayMediaRequestHandler: vi.fn((next) => {
        handler = next;
      })
    } as never;
    const activeFrameValue = { url: "file:///app/index.html#stage=region&displayId=1" };
    const activeFrame = activeFrameValue as WebFrameMain;
    broker.install(session);
    broker.arm(session, {
      invocationId: 9,
      displayId: 1,
      displayCount: 1,
      frame: activeFrame,
      frameUrl: activeFrameValue.url,
      isStillActive: () => true
    });

    const callback = vi.fn();
    handler!(
      {
        frame: { url: activeFrameValue.url },
        securityOrigin: "file://",
        videoRequested: true,
        audioRequested: false,
        userGesture: false
      } as never,
      callback
    );
    expect(callback).toHaveBeenCalledWith({});
    expect(getSources).not.toHaveBeenCalled();
  });

  test("fails closed when no enumerated source matches the target display", async () => {
    const getSources = vi.fn(async () => [source("screen:2:0", "2")]);
    const broker = createSelectorDisplayMediaBroker({ getSources });
    let handler: ((request: never, callback: (streams: unknown) => void) => void) | null = null;
    const session = {
      setDisplayMediaRequestHandler: vi.fn((next) => {
        handler = next;
      })
    } as never;
    const frameValue = { url: "file:///app/index.html#stage=region&displayId=1" };
    const frame = frameValue as WebFrameMain;
    broker.install(session);
    broker.arm(session, {
      invocationId: 10,
      displayId: 1,
      displayCount: 2,
      frame,
      frameUrl: frameValue.url,
      isStillActive: () => true
    });

    const callback = vi.fn();
    handler!(
      {
        frame,
        securityOrigin: "file://",
        videoRequested: true,
        audioRequested: false,
        userGesture: false
      } as never,
      callback
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}));
  });
});
