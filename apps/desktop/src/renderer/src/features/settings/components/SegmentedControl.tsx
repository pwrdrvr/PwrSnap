import type { ReactElement } from "react";

export type SegmentOption<T extends string> = {
  id: T;
  label: string;
  meta?: string;
};

type SegmentedControlProps<T extends string> = {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange
}: SegmentedControlProps<T>): ReactElement {
  return (
    <div className="pss__seg" role="tablist">
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={active}
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
