// AiRunBadge — small "✕" reject badge painted over a layer the agent
// placed during an open AI run.
//
// During an active AI run, every layer the agent adds gets one of
// these badges in the editor / preview surface. Clicking it rejects
// just that one change. This is a PURE button: the parent owns
// visibility — badges vanish on the next user turn, on "Keep all", or
// on archive, NOT on turn-complete (plan §F10 T6). This component only
// renders the button and calls `onReject(aiRunId)`.

import { useCallback, type ReactElement } from "react";

export interface AiRunBadgeProps {
  /** Identifies the AI run this placed layer belongs to. */
  readonly aiRunId: string;
  /** Reject this single AI-placed change. */
  readonly onReject: (aiRunId: string) => void;
  /** Accessible label override. Defaults to "Reject this AI change". */
  readonly label?: string;
}

export function AiRunBadge(props: AiRunBadgeProps): ReactElement {
  const { aiRunId, onReject, label = "Reject this AI change" } = props;

  const handleClick = useCallback((): void => {
    onReject(aiRunId);
  }, [onReject, aiRunId]);

  return (
    <button
      type="button"
      className="ps-airun-badge"
      onClick={handleClick}
      aria-label={label}
      title={label}
      data-ai-run-id={aiRunId}
      data-testid="ps-airun-badge"
    >
      <span className="ps-airun-badge__glyph" aria-hidden="true">
        {"✕"}
      </span>
    </button>
  );
}
