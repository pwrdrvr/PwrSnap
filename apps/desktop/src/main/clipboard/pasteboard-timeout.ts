/** A stalled native pasteboard call must not be retried synchronously in Electron. */
export class PasteboardTimeoutError extends Error {
  constructor(cause?: unknown) {
    super("The macOS clipboard did not respond. Please try copying again.", { cause });
    this.name = "PasteboardTimeoutError";
  }
}
