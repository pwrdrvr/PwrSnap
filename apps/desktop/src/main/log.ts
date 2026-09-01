import electronLog from "electron-log/main.js";
import { appendAppLogEntry } from "./app-logs";
import { parseProcessRoleFlag } from "./process-role";

let initialized = false;
let stdioErrorHandlersInstalled = false;
let debugCollectionEnabled = false;

export const MAIN_LOG_FILE_LEVEL = "info";
export const MAIN_LOG_FILE_MAX_SIZE_BYTES = 1024 * 1024;
// electron-log defaults to synchronous file writes. That makes every info
// mark on latency-sensitive main-process paths (notably the capture hotkey)
// block Electron's UI thread on the log file. Keep the durable transport, but
// enqueue its writes so diagnostics remain an observer rather than part of
// the measured critical path.
export const MAIN_LOG_FILE_SYNC = false;
const MAX_COMPACT_STRING_LENGTH = 320;
const MAX_COMPACT_FIELDS = 24;
const MAX_COMPACT_DEPTH = 2;

type ElectronLogHook = (typeof electronLog.hooks)[number];
type ElectronLogMessage = Parameters<ElectronLogHook>[0];
type StdioError = Error & { code?: unknown };

function isClosedStdioError(error: unknown): error is StdioError {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as StdioError).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function disableConsoleTransport(): void {
  electronLog.transports.console.level = false;
}

function rethrowUnexpectedStdioError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function handleStdioError(error: unknown): void {
  if (isClosedStdioError(error)) {
    disableConsoleTransport();
    return;
  }
  rethrowUnexpectedStdioError(error);
}

function installStdioErrorHandlers(): void {
  if (stdioErrorHandlersInstalled) return;
  stdioErrorHandlersInstalled = true;
  process.stdout.on("error", handleStdioError);
  process.stderr.on("error", handleStdioError);
}

function guardConsoleTransport(): void {
  const transport = electronLog.transports.console;
  const writeFn = transport.writeFn;
  transport.writeFn = (options) => {
    if (transport.level === false) return;
    try {
      writeFn(options);
    } catch (error) {
      if (isClosedStdioError(error)) {
        disableConsoleTransport();
        return;
      }
      throw error;
    }
  };
}

export function initializeMainLogger(): void {
  if (initialized) return;
  initialized = true;

  // Agent and library are separate Electron processes sharing one logs
  // directory. Keep their durable files separate so rotation cannot race.
  const roleFlag = parseProcessRoleFlag(process.argv);
  if (roleFlag === "library") electronLog.transports.file.fileName = "library.log";
  const consoleTag = roleFlag === "library" ? "lib " : "";

  installStdioErrorHandlers();
  guardConsoleTransport();
  electronLog.transports.file.level = debugCollectionEnabled ? "debug" : MAIN_LOG_FILE_LEVEL;
  electronLog.transports.file.maxSize = MAIN_LOG_FILE_MAX_SIZE_BYTES;
  electronLog.transports.file.sync = MAIN_LOG_FILE_SYNC;
  electronLog.initialize();
  electronLog.scope.labelPadding = false;

  electronLog.hooks.push((message, _transport, transportName) => {
    const compacted: ElectronLogMessage = {
      ...message,
      data: compactStructuredLogData(message.data)
    };
    if (transportName === "file") {
      appendAppLogEntry({
        timestamp: message.date.getTime(),
        level: String(message.level),
        ...(message.scope !== undefined ? { scope: message.scope } : {}),
        line: formatAppLogLine(compacted)
      });
    }
    return compacted;
  });

  electronLog.transports.console.format = ({ message }) => {
    const scope = message.scope ?? "?";
    return [`${formatLocalLogTime(message.date)} ${consoleTag}(${scope})`, ...message.data];
  };
}

export function getMainLogger(scope: string) {
  return electronLog.scope(scope);
}

export function getMainLogFilePath(): string | undefined {
  try {
    return electronLog.transports.file.getFile().path;
  } catch {
    return undefined;
  }
}

export function isMainLogDebugCollectionEnabled(): boolean {
  return debugCollectionEnabled;
}

export function setMainLogDebugCollectionEnabled(enabled: boolean): void {
  debugCollectionEnabled = enabled;
  electronLog.transports.file.level = enabled ? "debug" : MAIN_LOG_FILE_LEVEL;
}

export function formatAppLogLine(message: ElectronLogMessage): string {
  const timestamp = formatLogTimestamp(message.date);
  const level = String(message.level).padEnd(5, " ");
  const scope = message.scope ? ` (${message.scope})` : "";
  const content = message.data.map(formatLogTextPart).join(" ");
  return `[${timestamp}] [${level}]${scope} ${content}`.trimEnd();
}

function formatLogTimestamp(date: Date): string {
  return `${date.getFullYear()}-${padLogDatePart(date.getMonth() + 1)}-${padLogDatePart(date.getDate())} ${formatLocalLogTime(date)}`;
}

function formatLocalLogTime(date: Date): string {
  return `${padLogDatePart(date.getHours())}:${padLogDatePart(date.getMinutes())}:${padLogDatePart(date.getSeconds())}.${padLogDatePart(date.getMilliseconds(), 3)}`;
}

function padLogDatePart(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function formatLogTextPart(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (value === undefined) return "undefined";
  return JSON.stringify(value) ?? String(value);
}

export function compactStructuredLogData(data: unknown[]): unknown[] {
  if (data.length < 2 || typeof data[0] !== "string") return data;

  const compacted: string[] = [];
  const passthrough: unknown[] = [];
  let hadStructuredPayload = false;
  for (const item of data.slice(1)) {
    if (isPlainObject(item)) {
      hadStructuredPayload = true;
      const fields = compactObjectFields(item);
      if (fields) compacted.push(fields);
    } else {
      passthrough.push(item);
    }
  }
  if (compacted.length > 0) return [`${data[0]} ${compacted.join(" ")}`, ...passthrough];
  return hadStructuredPayload ? [data[0], ...passthrough] : data;
}

type CompactField = { key: string; value: string };

function compactObjectFields(value: Record<string, unknown>): string {
  const fields: CompactField[] = [];
  collectCompactFields(value, "", fields, 0);
  const suffix = fields.length >= MAX_COMPACT_FIELDS ? " ..." : "";
  return `${fields.slice(0, MAX_COMPACT_FIELDS).map((field) => `${field.key}=${field.value}`).join(" ")}${suffix}`;
}

function collectCompactFields(
  value: Record<string, unknown>,
  prefix: string,
  fields: CompactField[],
  depth: number
): void {
  if (fields.length >= MAX_COMPACT_FIELDS) return;
  for (const [key, child] of Object.entries(value)) {
    if (fields.length >= MAX_COMPACT_FIELDS) return;
    if (child === undefined) continue;
    const fieldKey = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child) && depth < MAX_COMPACT_DEPTH && Object.keys(child).length <= 8) {
      collectCompactFields(child, fieldKey, fields, depth + 1);
      continue;
    }
    fields.push({ key: fieldKey, value: compactLogValue(child) });
  }
}

function compactLogValue(value: unknown): string {
  if (typeof value === "string") return quoteIfNeeded(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(compactLogValue).join(",")}]`;
  if (value instanceof Error) return quoteIfNeeded(value.stack ?? value.message);
  if (value instanceof Date) return value.toISOString();
  return quoteIfNeeded(JSON.stringify(value) ?? String(value));
}

function quoteIfNeeded(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const truncated = compact.length > MAX_COMPACT_STRING_LENGTH
    ? `${compact.slice(0, MAX_COMPACT_STRING_LENGTH - 3)}...`
    : compact;
  return /^[A-Za-z0-9_./:@+-]+$/.test(truncated) ? truncated : JSON.stringify(truncated);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
