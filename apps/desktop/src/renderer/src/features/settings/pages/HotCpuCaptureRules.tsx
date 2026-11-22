import { useId, useRef, useState, type ReactElement } from "react";
import {
  formatHotCpuProfileTriggerMode, HOT_CPU_RULE_DURATIONS_MS, hotCpuRulesCadenceMs, isHotCpuThreshold,
  type HotCpuCaptureRules, type HotCpuEffectiveRule, type HotCpuEnvironmentOverrides, type HotCpuProfileTriggerMode
} from "@pwrsnap/shared";
import { Row, SegmentedControl } from "../components";

const HIGH_MODES = [
  { id: "spike", label: "Spike", tip: "Starts a capture on one sample at or above the threshold." },
  { id: "sustained", label: "Sustained", tip: "Needs every sample in the duration to stay at or above the threshold." }
] as const;
const LAST_RULE = "At least one rule stays on. To stop capturing, use Stop Capture.";
const THRESHOLD_ERROR = "Enter a whole number from 1 to 400.";

function durationLabel(durationMs: number, sampleCount: number): string {
  return `${durationMs / 1000} s · ${sampleCount} ${sampleCount === 1 ? "sample" : "samples"}`;
}

function describeRule(rule: HotCpuEffectiveRule, cadenceMs: number): string {
  const timing = rule.sampleCount === 1 ? `one ${cadenceMs / 1000} s sample`
    : `${rule.sampleCount} × ${cadenceMs / 1000} s consecutive samples`;
  const requested = rule.durationMs !== cadenceMs * rule.sampleCount ? ` (${rule.durationMs / 1000} s requested)` : "";
  return `${formatHotCpuProfileTriggerMode(rule.id)} at ≥${rule.thresholdPercent}% over ${timing}${requested}`;
}

function RuleFields({ id, rule, cadenceMs, disabled, onChange }: {
  id: HotCpuProfileTriggerMode;
  rule: { thresholdPercent: number; durationMs: number };
  cadenceMs: number;
  disabled: boolean;
  onChange: (next: { thresholdPercent: number; durationMs: number }) => void;
}): ReactElement {
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const threshold = draft ?? String(rule.thresholdPercent);
  const valid = threshold.trim() !== "" && isHotCpuThreshold(Number(threshold));
  const label = formatHotCpuProfileTriggerMode(id);
  const saveThreshold = () => {
    if (!valid || draft === null) return;
    if (Number(draft) !== rule.thresholdPercent) onChange({ ...rule, thresholdPercent: Number(draft) });
    setDraft(null);
  };
  return (
    <>
      <div className="pss__rule-values">
        <label className="pss__rule-threshold">
          <span>at least</span>
          <input type="number" min={1} max={400} step={1} value={threshold} disabled={disabled}
            aria-label={`${label} CPU threshold`}
            aria-invalid={!valid}
            aria-errormessage={!valid ? errorId : undefined}
            data-tip="Percent of one CPU core. 100% is one core fully busy. Multi-threaded work can exceed 100%."
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={saveThreshold}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDraft(null);
              } else if (event.key === "Enter") {
                event.preventDefault();
                saveThreshold();
              } else if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                event.preventDefault();
                const step = event.key === "ArrowUp" ? 10 : -10;
                setDraft(String(Math.max(1, Math.min(400, (valid ? Number(threshold) : rule.thresholdPercent) + step))));
              }
            }}
          />
          <span className="pss__rule-unit">% CPU</span>
        </label>
        <label className="pss__rule-duration">
          <span>for</span>
          <select value={rule.durationMs} disabled={disabled} aria-label={`${label} duration`}
            data-tip="Each sample in the window must meet the threshold. A short burst is averaged with the rest of its sample."
            onChange={(event) => onChange({ ...rule, durationMs: Number(event.currentTarget.value) })}>
            {HOT_CPU_RULE_DURATIONS_MS[id].map((durationMs) => (
              <option key={durationMs} value={durationMs}>
                {durationLabel(durationMs, id === "spike" ? 1 : durationMs / cadenceMs)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!valid && <p id={errorId} className="pss__rule-error">{THRESHOLD_ERROR}</p>}
    </>
  );
}

export function HotCpuCaptureRulesRow({ rules: savedRules, environment, disabled, onChange }: {
  rules: HotCpuCaptureRules;
  environment: HotCpuEnvironmentOverrides["rules"];
  disabled: boolean;
  onChange: (rules: HotCpuCaptureRules) => Promise<void>;
}): ReactElement {
  const labelId = useId();
  const summaryId = useId();
  const [lastRuleMessage, setLastRuleMessage] = useState("");
  const [pendingRules, setPendingRules] = useState<HotCpuCaptureRules | null>(null);
  const pending = useRef<{ rules: HotCpuCaptureRules; write: Promise<void> } | null>(null);
  const rules = pendingRules ?? savedRules;
  const locked = disabled || environment?.forcedMode !== undefined;
  const cadenceMs = hotCpuRulesCadenceMs(rules);
  const high = rules[rules.high.mode];
  const highIsLast = rules.high.enabled && !rules.slowburn.enabled;
  const slowburnIsLast = rules.slowburn.enabled && !rules.high.enabled;
  const names = environment?.renderer.map(({ id }) => id) ??
    [rules.high.enabled ? rules.high.mode : null, rules.slowburn.enabled ? "slowburn" as const : null]
      .filter((id) => id !== null);
  const clauses = [
    ...(rules.high.enabled ? [`at least ${high.thresholdPercent}% of one core over ${durationLabel(high.durationMs, high.durationMs / cadenceMs)}`] : []),
    ...(rules.slowburn.enabled ? [`at least ${rules.slowburn.thresholdPercent}% of one core over ${durationLabel(rules.slowburn.durationMs, rules.slowburn.durationMs / cadenceMs)}`] : [])
  ];
  const redundant = !environment && rules.high.enabled && rules.slowburn.enabled &&
    rules.slowburn.thresholdPercent >= high.thresholdPercent && rules.slowburn.durationMs >= high.durationMs;

  function save(update: (current: HotCpuCaptureRules) => HotCpuCaptureRules): void {
    // A threshold blur can land just before a mode click. Queue both
    // writes, using the preceding draft so either rule keeps its edit.
    const next = update(pending.current?.rules ?? savedRules);
    if (!next.high.enabled && !next.slowburn.enabled) {
      setLastRuleMessage(LAST_RULE);
      return;
    }
    setLastRuleMessage("");
    setPendingRules(next);
    const write = (pending.current?.write.catch(() => undefined) ?? Promise.resolve()).then(() => onChange(next));
    pending.current = { rules: next, write };
    const finish = () => {
      if (pending.current?.write !== write) return;
      pending.current = null;
      setPendingRules(null);
    };
    void write.then(finish, finish);
  }

  return (
    <Row label="Capture rules" labelId={labelId}
      sub="Start a capture when any checked rule matches. Rules apply independently to the main process and the Library renderer."
      tag={names.map((id) => formatHotCpuProfileTriggerMode(id).toLowerCase()).join(" + ")}>
      <div className="pss__capture-rules" role="group" aria-busy={pendingRules !== null} aria-labelledby={labelId} aria-describedby={summaryId}>
        <div className="pss__capture-rule">
          <div className="pss__rule-heading">
            <label data-tip={highIsLast ? LAST_RULE : undefined}>
              <input type="checkbox" checked={rules.high.enabled} disabled={locked}
                aria-disabled={highIsLast || undefined}
                onChange={(event) => {
                  if (highIsLast) setLastRuleMessage(LAST_RULE);
                  else {
                    const enabled = event.currentTarget.checked;
                    save((current) => ({ ...current, high: { ...current.high, enabled } }));
                  }
                }} />
              High CPU
            </label>
            <SegmentedControl options={HIGH_MODES} value={rules.high.mode} radioLabel="High CPU mode"
              disabled={locked || !rules.high.enabled}
              onChange={(mode) => save((current) => ({ ...current, high: { ...current.high, mode } }))} />
          </div>
          <RuleFields key={`${rules.high.mode}-${rules.high.enabled}`} id={rules.high.mode} rule={high} cadenceMs={cadenceMs}
            disabled={locked || !rules.high.enabled}
            onChange={(next) => save((current) => ({ ...current, [rules.high.mode]: next }))} />
        </div>
        <div className="pss__capture-rule">
          <div className="pss__rule-heading">
            <label data-tip={slowburnIsLast ? LAST_RULE : "A lower threshold for steady background work that never spikes."}>
              <input type="checkbox" checked={rules.slowburn.enabled} disabled={locked}
                aria-disabled={slowburnIsLast || undefined}
                onChange={(event) => {
                  if (slowburnIsLast) setLastRuleMessage(LAST_RULE);
                  else {
                    const enabled = event.currentTarget.checked;
                    save((current) => ({ ...current, slowburn: { ...current.slowburn, enabled } }));
                  }
                }} />
              Slow burn
            </label>
            <span className="pss__update-note">Lower threshold, longer window</span>
          </div>
          <RuleFields key={String(rules.slowburn.enabled)} id="slowburn" rule={rules.slowburn} cadenceMs={cadenceMs}
            disabled={locked || !rules.slowburn.enabled}
            onChange={(next) => save((current) => ({ ...current, slowburn: { ...current.slowburn, ...next } } as HotCpuCaptureRules))} />
        </div>
        <p className="pss__rule-summary" id={summaryId} aria-live="polite">
          {environment ? (
            <>
              Environment overrides ({environment.keys.join(", ")}). Main process: {environment.main.map((rule) => describeRule(rule, environment.cadenceMs)).join(" or ")}.
              {" "}Library renderer: {environment.renderer.map((rule) => describeRule(rule, environment.cadenceMs)).join(" or ")}.
            </>
          ) : `Starts a capture when the main process or Library renderer uses ${clauses.join(", or ")}.`}
        </p>
        <p className="pss__update-note">
          Duration counts consecutive samples. A match is seen at the end of a sample. When rules match together,
          one capture is saved and it names each rule.
        </p>
        <div className="pss__rule-status" role="status">{lastRuleMessage}</div>
        {redundant && <p className="pss__rule-warning">Slow burn has the same or higher threshold and an equal or longer window. Lower its threshold to capture lighter load.</p>}
      </div>
    </Row>
  );
}
