import type { KeyboardEvent, ReactElement } from "react";

export type SegmentOption<T extends string> = {
  id: T;
  label: string;
  meta?: string;
  tip?: string;
};

type SegmentedControlProps<T extends string> = {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
  radioLabel?: string;
  disabled?: boolean;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  radioLabel,
  disabled
}: SegmentedControlProps<T>): ReactElement {
  function navigate(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled || options.length === 0) return;
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1
      : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const current = options.findIndex((option) => option.id === value);
    const next = (current + step + options.length) % options.length;
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
    onChange(options[next]!.id);
  }
  return (
    <div className="pss__seg" role={radioLabel ? "radiogroup" : "tablist"} aria-label={radioLabel}
      onKeyDown={radioLabel ? navigate : undefined}>
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role={radioLabel ? "radio" : "tab"}
            aria-selected={radioLabel ? undefined : active}
            aria-checked={radioLabel ? active : undefined}
            tabIndex={radioLabel ? (active ? 0 : -1) : undefined}
            disabled={disabled}
            data-tip={opt.tip}
            className={
              "pss__seg-btn" +
              (opt.meta !== undefined ? " pss__seg-btn--stacked" : "") +
              (active ? " is-active" : "")
            }
            onClick={() => onChange(opt.id)}
          >
            <span>{opt.label}</span>
            {opt.meta !== undefined ? (
              <span className="pss__seg-meta">{opt.meta}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
