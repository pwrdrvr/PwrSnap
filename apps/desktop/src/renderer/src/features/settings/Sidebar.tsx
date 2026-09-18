// Settings sidebar nav. Ported from design/src/Settings.jsx's
// `Sidebar` function (lines 80–103), with the expandable-group rows
// ported from PwrAgnt's settings nav (`SettingsScreen.tsx`).
//
// Reads the category catalog from `settings-categories.ts` so the
// design / router / tests share a single source of truth. Clicking
// an item updates the URL hash; `useActiveRoute` listens for
// `hashchange` in `SettingsApp` and re-renders.
//
// Group rows carry a caret and a collapsible sublist of children (see
// `settings-nav.ts`): AI Providers lists one screen per provider, each
// with a status dot so the operator can read which providers are
// installed and configured without opening the page; AI Features lists
// jump-to links to its sections. Every row reserves the caret gutter,
// caret or not, so the labels align down the column.

import { Fragment, useEffect, useState, type ReactElement } from "react";
import type { SettingsPage } from "@pwrsnap/shared";
import { useAiProvidersContext } from "./AiProvidersContext";
import { SETTINGS_CATEGORIES } from "./settings-categories";
import { SETTINGS_NAV_GROUPS as NAV_GROUPS, settingsNavChildren } from "./settings-nav";
import { setActivePage } from "./useActivePage";

type SidebarProps = {
  active: SettingsPage;
  /** Child screen within `active`, or `null` for its hub. */
  sub: string | null;
};

export function Sidebar({ active, sub }: SidebarProps): ReactElement {
  const { request, statuses } = useAiProvidersContext();

  // Groups open collapsed except the one holding the current route — an
  // active page hidden behind a closed caret would read as a dead nav.
  const [openGroups, setOpenGroups] = useState<Partial<Record<SettingsPage, boolean>>>(() =>
    NAV_GROUPS.has(active) ? { [active]: true } : {}
  );
  const expandGroup = (page: SettingsPage): void => {
    if (!NAV_GROUPS.has(page)) return;
    setOpenGroups((current) => (current[page] === true ? current : { ...current, [page]: true }));
  };

  // Arriving at a group from anywhere else (a deep link, a hub row, the
  // title-bar crumb) expands it. Only the caret collapses one.
  useEffect(() => {
    if (!NAV_GROUPS.has(active)) return;
    setOpenGroups((current) =>
      current[active] === true ? current : { ...current, [active]: true }
    );
  }, [active, sub]);

  // Provider status is read only once its children can be seen, so
  // opening Settings on another page does no discovery at all.
  const aiOpen = openGroups.ai === true;
  useEffect(() => {
    if (aiOpen) request();
  }, [aiOpen, request]);

  return (
    <aside className="pss__sidebar">
      {SETTINGS_CATEGORIES.map((cat) => (
        <Fragment key={cat.group}>
          <div className="pss__sb-section">{cat.group}</div>
          {cat.items.map((it) => {
            const isGroup = NAV_GROUPS.has(it.id);
            const open = openGroups[it.id] === true;
            const holdsRoute = it.id === active;
            // A collapsed group hides its active child inside an inert
            // sublist, so the parent row takes over the marker — the nav
            // must always show where the operator is.
            const marksRoute = holdsRoute && (sub === null || (isGroup && !open));
            const sublistId = `pss-sb-sublist-${it.id}`;
            const children = settingsNavChildren(it.id, statuses);
            return (
              <Fragment key={it.id}>
                <div className={"pss__sb-row" + (marksRoute ? " is-active" : "")}>
                  {isGroup ? (
                    <button
                      type="button"
                      className="pss__sb-caret"
                      aria-controls={sublistId}
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${it.name}`}
                      onClick={() => {
                        setOpenGroups((current) => ({ ...current, [it.id]: !open }));
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className={"pss__sb-caret-mark" + (open ? " is-open" : "")}
                      />
                    </button>
                  ) : (
                    <span aria-hidden="true" className="pss__sb-caret-spacer" />
                  )}
                  <button
                    className={"pss__sb-nav" + (marksRoute ? " is-active" : "")}
                    type="button"
                    aria-current={marksRoute ? "page" : undefined}
                    onClick={() => {
                      // Clicking a group's label both routes to its hub
                      // and reveals its children.
                      expandGroup(it.id);
                      setActivePage(it.id);
                    }}
                  >
                    {it.name}
                  </button>
                </div>
                {isGroup ? (
                  <div
                    id={sublistId}
                    className={"pss__sb-sublist" + (open ? " is-open" : "")}
                    aria-hidden={!open}
                    inert={open ? undefined : true}
                  >
                    <div className="pss__sb-sublist-clip">
                      {children.map((child) => {
                        const childActive = holdsRoute && sub === child.sub;
                        return (
                          <button
                            key={child.sub}
                            type="button"
                            className={"pss__sb-sub" + (childActive ? " is-active" : "")}
                            aria-current={childActive ? "page" : undefined}
                            title={
                              child.status !== undefined
                                ? `${child.label} — ${child.status.badge}`
                                : undefined
                            }
                            onClick={() => {
                              setActivePage(it.id, child.sub);
                            }}
                          >
                            {/* Always rendered so labels don't shift when a
                                status lands, and line up across groups;
                                toneless = not known yet, or a jump link
                                with no status at all. */}
                            <span
                              aria-hidden="true"
                              className={
                                "pss__status-dot" +
                                (child.status?.tone !== undefined
                                  ? ` pss__status-dot--${child.status.tone}`
                                  : "")
                              }
                            />
                            <span className="pss__sb-sublabel">{child.label}</span>
                            {child.status?.chip !== undefined ? (
                              <span className="pss__sb-subchip">{child.status.chip}</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </Fragment>
      ))}
    </aside>
  );
}
