import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  stage: string;
};

type State = {
  error: Error | null;
};

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export class RendererErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: normalizeError(error) };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("PwrSnap renderer error", {
      stage: this.props.stage,
      error,
      componentStack: errorInfo.componentStack
    });
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;

    return (
      <div className="renderer-failure" role="alert">
        <div className="renderer-failure__panel">
          <div className="renderer-failure__eyebrow">{this.props.stage}</div>
          <h1 className="renderer-failure__title">Renderer failed to load</h1>
          <p className="renderer-failure__message">
            PwrSnap hit a renderer error while opening this window. Reload the window after the
            underlying error is fixed.
          </p>
          <pre className="renderer-failure__details">
            {this.state.error.name}: {this.state.error.message}
          </pre>
          <button
            className="renderer-failure__button"
            type="button"
            onClick={() => window.location.reload()}
          >
            Reload window
          </button>
        </div>
      </div>
    );
  }
}
