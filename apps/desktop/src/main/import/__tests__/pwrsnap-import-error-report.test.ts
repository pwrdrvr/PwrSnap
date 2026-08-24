import { describe, expect, test } from "vitest";

import { safeImportFailureLog } from "../pwrsnap-import-error-report";
import { PwrsnapImportError } from "../pwrsnap-import-reader";

describe("safeImportFailureLog", () => {
  test("does not expose an external absolute path from an unexpected errno", () => {
    const macPath = "/Users/alice/Private/foreign.pwrsnap";
    const windowsPath = "C:\\Users\\Alice\\Private\\foreign.pwrsnap";
    for (const path of [macPath, windowsPath]) {
      const cause = Object.assign(new Error(`EIO while opening ${path}`), {
        code: "EIO",
        path
      });
      const fields = safeImportFailureLog(cause);
      expect(JSON.stringify(fields)).not.toContain(path);
      expect(fields.code).toBe("unexpected_import_failure");
    }
  });

  test("retains the sanitized typed import code and message", () => {
    const cause = new PwrsnapImportError(
      "corrupt",
      "document_schema_invalid",
      "The layer document is malformed."
    );
    expect(safeImportFailureLog(cause)).toEqual({
      code: "document_schema_invalid",
      message: "The layer document is malformed."
    });
  });
});
