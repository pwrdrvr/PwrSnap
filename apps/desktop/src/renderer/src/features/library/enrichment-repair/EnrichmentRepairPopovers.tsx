// The three refinements behind the set-up view's token line: when, which
// apps, and how many at a time. Each is a token button with a non-modal
// popover right after it in the DOM, so Escape and Tab come from the focus
// hooks (lib/AGENTS.md): `useDismissable` with `dismissOnFocusLeave`, and
// `useFocusReturn` because picking an option closes the popover under the
// focused control.

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { EnrichmentRepairAppCount, EnrichmentRepairAppFacet } from "@pwrsnap/shared";

import { useDismissable } from "../../../lib/useDismissable";
import { useFocusReturn } from "../../../lib/useFocusReturn";
import { AppIcon } from "../../shared/AppIcons";
import {
  REPAIR_CONCURRENCY_OPTIONS,
  WINDOW_PRESETS,
  repairAppRowState,
  repairPaceToken,
  repairWindowToken,
  toggleRepairApp,
  type RepairConcurrency,
  type RepairWindow,
  type RepairWindowPreset
} from "./enrichment-repair-model";

export type RepairPopoverId = "when" | "apps" | "pace";

/** A token in the "Captured … from … · …" line, and its popover. */
export function RepairToken({
  id,
  label,
  value,
  set,
  open,
  onOpenChange,
  children
}: {
  id: RepairPopoverId;
  /** The accessible name's prefix: "Captured", "Apps", "Pace". */
  label: string;
  value: string;
  /** Not the default: drawn in accent so a narrowed batch is noticed. */
  set: boolean;
  open: boolean;
  onOpenChange: (id: RepairPopoverId | null) => void;
  children: (close: () => void) => ReactNode;
}): ReactElement {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const close = (): void => onOpenChange(null);
  useDismissable({ open, onDismiss: close, surfaceRef, triggerRef, dismissOnFocusLeave: true });
  useFocusReturn({ open, containerRef: surfaceRef, returnFocusRef: triggerRef });

  // A press outside the token and its popover closes it. Escape and Tab are
  // the hooks'; this is only the pointer half of light dismissal.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (surfaceRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return;
      onOpenChange(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, onOpenChange]);

  // Under its token, but kept inside the token line (the popover's
  // containing block), so one opened near the right edge does not hang out
  // of the dialog. Layout measures only: the Library's entrance transform
  // may still be running.
  const [left, setLeft] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const surface = surfaceRef.current;
    const line = surface?.offsetParent;
    if (trigger === null || surface === null || !(line instanceof HTMLElement)) return;
    const room = line.clientWidth - surface.offsetWidth;
    setLeft(Math.max(0, Math.min(trigger.offsetLeft, room)));
  }, [open]);

  // Opening moves focus in, to the picked option or the search field.
  useEffect(() => {
    if (!open) return;
    const surface = surfaceRef.current;
    const target =
      surface?.querySelector<HTMLElement>("[data-autofocus]") ??
      surface?.querySelector<HTMLElement>("input:checked") ??
      surface?.querySelector<HTMLElement>("input, button");
    target?.focus();
  }, [open]);

  return (
    <span className="ps-repair-tokwrap">
      <button
        ref={triggerRef}
        type="button"
        className={"ps-repair-tok" + (set ? " is-set" : "") + (open ? " is-open" : "")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${value}`}
        onClick={() => onOpenChange(open ? null : id)}
      >
        {value}
      </button>
      {open ? (
        <div
          ref={surfaceRef}
          className={`ps-repair-pop ps-repair-pop--${id}`}
          style={{ left }}
          role="dialog"
          aria-label={label}
        >
          {children(close)}
        </div>
      ) : null}
    </span>
  );
}

/**
 * One radio row. A pointer click picks AND closes. A keyboard-made click
 * (the arrow keys on a radio fire one, with `detail === 0`) only picks, so
 * arrowing through the options does not slam the popover shut.
 *
 * The pointer path picks in the label's own handler and prevents the label's
 * default: closing unmounts the input, and React flushes that before the
 * browser would forward the click to it, so its `change` would never fire.
 */
function RadioOption({
  name,
  checked,
  onPick,
  close,
  children
}: {
  name: string;
  checked: boolean;
  onPick: () => void;
  close?: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <label
      className="ps-repair-opt"
      onClick={(event) => {
        if (event.detail === 0) return;
        event.preventDefault();
        onPick();
        close?.();
      }}
    >
      <input type="radio" name={name} checked={checked} onChange={onPick} />
      {children}
    </label>
  );
}

export function WhenPopover({
  window,
  counts,
  now,
  onChange,
  close
}: {
  window: RepairWindow;
  /** Snaps each preset would run, with the current tiles and apps. */
  counts: Partial<Record<RepairWindowPreset, number>> | null;
  now: number;
  onChange: (window: RepairWindow) => void;
  close: () => void;
}): ReactElement {
  const dates = window.kind === "dates" ? window : null;
  const today = new Date(now);
  const iso = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return (
    <div className="ps-repair-pop__list" role="radiogroup" aria-label="Captured">
      {window.kind === "range" ? (
        <label className="ps-repair-opt">
          <input type="radio" name="ps-repair-when" checked readOnly />
          <span>{repairWindowToken(window, now)}</span>
        </label>
      ) : null}
      {WINDOW_PRESETS.map((preset) => (
        <RadioOption
          key={preset.id}
          name="ps-repair-when"
          checked={window.kind === "preset" && window.preset === preset.id}
          onPick={() => onChange({ kind: "preset", preset: preset.id })}
          close={close}
        >
          <span>{preset.label}</span>
          <span className="ps-repair-opt__n">{counts?.[preset.id]?.toLocaleString() ?? ""}</span>
        </RadioOption>
      ))}
      <div className="ps-repair-pop__sep" role="presentation" />
      <RadioOption
        name="ps-repair-when"
        checked={dates !== null}
        onPick={() => {
          if (dates === null) onChange({ kind: "dates", from: "", to: iso(today) });
        }}
      >
        <span>Between dates…</span>
      </RadioOption>
      {dates !== null ? (
        <div className="ps-repair-pop__dates">
          <label>
            <span>From</span>
            <input
              type="date"
              value={dates.from}
              max={dates.to === "" ? undefined : dates.to}
              onChange={(event) => onChange({ ...dates, from: event.target.value })}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="date"
              value={dates.to}
              min={dates.from === "" ? undefined : dates.from}
              onChange={(event) => onChange({ ...dates, to: event.target.value })}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

export function PacePopover({
  concurrency,
  onChange,
  close
}: {
  concurrency: RepairConcurrency;
  onChange: (concurrency: RepairConcurrency) => void;
  close: () => void;
}): ReactElement {
  return (
    <>
      <div className="ps-repair-pop__list" role="radiogroup" aria-label="Snaps at a time">
        {REPAIR_CONCURRENCY_OPTIONS.map((option) => (
          <RadioOption
            key={option}
            name="ps-repair-pace"
            checked={concurrency === option}
            onPick={() => onChange(option)}
            close={close}
          >
            <span>{option === 1 ? "One at a time" : repairPaceToken(option)}</span>
            {option === 1 ? <span className="ps-repair-opt__n">Recommended</span> : null}
          </RadioOption>
        ))}
      </div>
      <div className="ps-repair-pop__sep" role="presentation" />
      <p className="ps-repair-pop__note">
        Re-runs start no faster than your steady rate limit, and never use the budget new captures draw on.
      </p>
    </>
  );
}

export function AppsPopover({
  apps,
  rows,
  query,
  counting,
  altModifierLabel,
  nameOf,
  onQueryChange,
  onAppsChange
}: {
  apps: EnrichmentRepairAppFacet;
  rows: readonly EnrichmentRepairAppCount[];
  query: string;
  counting: boolean;
  altModifierLabel: string;
  nameOf: (app: EnrichmentRepairAppCount) => string;
  onQueryChange: (query: string) => void;
  onAppsChange: (apps: EnrichmentRepairAppFacet) => void;
}): ReactElement {
  const narrowed = apps.appIds.length > 0;
  return (
    <>
      <input
        type="search"
        className="ps-repair-pop__search"
        placeholder="Find an app…"
        aria-label="Find an app"
        value={query}
        data-autofocus=""
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <div className="ps-repair-pop__apps" role="group" aria-label="Apps to re-run">
        {rows.length === 0 ? (
          <div className="ps-repair-pop__empty">{counting ? "Counting…" : "No snaps match."}</div>
        ) : (
          rows.map((app) => {
            const state = repairAppRowState(apps, app.appKey);
            const name = nameOf(app);
            const dimmed = state === "neutral" && apps.mode === "include" && narrowed;
            return (
              <button
                key={app.appKey}
                type="button"
                aria-pressed={state !== "neutral"}
                aria-label={
                  state === "excluded" ? `${name} (excluded)` : state === "included" ? `${name} (selected)` : name
                }
                className={
                  "ps-repair-app" +
                  (state === "included" ? " is-active" : "") +
                  (state === "excluded" ? " is-excluded" : "") +
                  (dimmed ? " is-dimmed" : "")
                }
                data-tip={
                  state === "included"
                    ? `Click to unselect ${name}`
                    : state === "excluded"
                      ? `Click to include ${name} again`
                      : `Click to select ${name}`
                }
                data-tip-detail={`${altModifierLabel}-click to ${state === "excluded" ? "stop excluding" : "exclude"} it`}
                onClick={(event) => onAppsChange(toggleRepairApp(apps, app.appKey, event.altKey))}
              >
                <span className="ps-repair-app__box" aria-hidden="true">
                  {state === "included" ? "✓" : state === "excluded" ? "–" : ""}
                </span>
                <span className="ps-repair-app__icon">
                  <AppIcon
                    app={app.appKey === "" ? "any" : app.appKey}
                    size={11}
                    name={name}
                    bundleId={app.bundleId ?? undefined}
                  />
                </span>
                <span className="ps-repair-app__name">{name}</span>
                <span className="ps-repair-app__n">{app.count.toLocaleString()}</span>
              </button>
            );
          })
        )}
      </div>
      <div className="ps-repair-pop__sep" role="presentation" />
      <div className="ps-repair-pop__foot">
        <p className="ps-repair-pop__note">
          Click to pick apps. {altModifierLabel}-click to leave one out.
        </p>
        {narrowed ? (
          <button type="button" className="ps-repair-link" onClick={() => onAppsChange({ mode: "include", appIds: [] })}>
            All apps
          </button>
        ) : null}
      </div>
    </>
  );
}
