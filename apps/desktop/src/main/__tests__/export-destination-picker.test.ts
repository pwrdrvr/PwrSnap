// Pins where File → Export Library…'s folder picker opens. Electron 43 made
// a dialog with no `defaultPath` open in Downloads every time, so the picker
// has to say where to start.

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn()
}));

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  app: {
    getPath: (name: string) => (name === "home" ? "/Users/test" : "")
  } as unknown as typeof import("electron").app,
  dialog: {
    showOpenDialog: mocks.showOpenDialog
  } as unknown as typeof import("electron").dialog
}));

const { createExportDestinationPicker } = await import("../export-destination-picker");

function defaultPathOfCall(index: number): unknown {
  return mocks.showOpenDialog.mock.calls[index]?.[0]?.defaultPath;
}

beforeEach(() => {
  mocks.showOpenDialog.mockReset();
});

describe("export destination picker", () => {
  test("starts in the home directory rather than Electron's Downloads default", async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(createExportDestinationPicker()()).resolves.toBeNull();

    expect(defaultPathOfCall(0)).toBe("/Users/test");
    expect(mocks.showOpenDialog.mock.calls[0]?.[0]?.properties).toEqual([
      "openDirectory",
      "createDirectory"
    ]);
  });

  test("reopens beside the last folder picked", async () => {
    const pick = createExportDestinationPicker();
    mocks.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: ["/Users/test/Backups/pwrsnap-oct"] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await expect(pick()).resolves.toBe("/Users/test/Backups/pwrsnap-oct");
    await pick();

    expect(defaultPathOfCall(1)).toBe("/Users/test/Backups");
  });

  test("keeps the last location when a pick is canceled", async () => {
    const pick = createExportDestinationPicker();
    mocks.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: ["/Volumes/Archive/exports/a"] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await pick();
    await pick();
    await pick();

    expect(defaultPathOfCall(2)).toBe("/Volumes/Archive/exports");
  });
});
