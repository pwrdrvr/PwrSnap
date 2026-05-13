// Segmented control. Two or more mutually-exclusive options laid
// out horizontally; the active one glows copper. Mirrors the
// design's `.pss__seg / .pss__seg-btn` shape (design/src/Settings.jsx
// AIProvidersPage line 559+).

import type { ReactElement } from "react";

export type SegmentOption<T extends string> = {
  id: T;
  label: string;
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
            className={"pss__seg-btn" + (active ? " is-active" : "")}
            onClick={() => onChange(opt.id)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
