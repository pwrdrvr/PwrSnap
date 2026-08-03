import type {
  RendererErrorReport,
  RendererErrorSource
} from "@pwrsnap/shared";
import { dispatch } from "./pwrsnap";

function errorShape(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      ...(error.stack !== undefined ? { stack: error.stack } : {})
    };
  }
  return { message: typeof error === "string" ? error : String(error) };
}

export function createRendererErrorReport(
  source: RendererErrorSource,
  error: unknown,
  details: {
    colno?: number;
    componentStack?: string | null;
    filename?: string;
    lineno?: number;
    stage?: string;
  } = {}
): RendererErrorReport {
  return {
    ...errorShape(error),
    source,
    timestamp: new Date().toISOString(),
    href: window.location.href,
    userAgent: navigator.userAgent,
    ...(details.colno !== undefined ? { colno: details.colno } : {}),
    ...(details.componentStack != null ? { componentStack: details.componentStack } : {}),
    ...(details.filename !== undefined ? { filename: details.filename } : {}),
    ...(details.lineno !== undefined ? { lineno: details.lineno } : {}),
    ...(details.stage !== undefined ? { stage: details.stage } : {})
  };
}

export function reportRendererError(report: RendererErrorReport): void {
  void dispatch("renderer:reportError", report).catch(() => undefined);
}

export function installGlobalRendererErrorHandlers(): () => void {
  const handleError = (event: ErrorEvent): void => {
    reportRendererError(
      createRendererErrorReport("window-error", event.error ?? event.message, {
        colno: event.colno,
        filename: event.filename,
        lineno: event.lineno
      })
    );
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    reportRendererError(createRendererErrorReport("unhandled-rejection", event.reason));
  };

  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  return () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
  };
}
