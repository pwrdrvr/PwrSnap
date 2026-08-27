import { PwrsnapImportError } from "./pwrsnap-import-reader";

export type SafeImportFailureLog = {
  code: string;
  message: string;
};

/** Build path-free fields safe for logs fed by an external file-open event. */
export function safeImportFailureLog(cause: unknown): SafeImportFailureLog {
  if (cause instanceof PwrsnapImportError) {
    return { code: cause.code, message: cause.message };
  }
  return {
    code: "unexpected_import_failure",
    message: "PwrSnap bundle import failed unexpectedly."
  };
}
