// The project rail: "+ New Sizzle Reel", Recents, Projects — plus the
// per-row context menu. With a reel open the shell renders the rail as a
// dropdown under the title-bar crumb (see `.szl--rail-popover`); the
// rail itself is the same markup either way.

import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactElement, type RefObject } from "react";
import type { SizzleProject } from "@pwrsnap/shared";
import { formatProjectDate, isDifferentProjectDate } from "./sizzle-helpers";

export type ProjectRailModel = {
  recents: SizzleProject[];
  list: SizzleProject[];
  totalProjectCount: number;
};

export type ProjectContextMenuState = {
  projectId: string;
  projectName: string;
  x: number;
  y: number;
};

export const PROJECT_CONTEXT_MENU_WIDTH = 188;
export const PROJECT_CONTEXT_MENU_HEIGHT = 70;

export function clampContextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 8))
  };
}

export type ProjectRailProps = {
  railRef: RefObject<HTMLElement | null>;
  /** True when a reel is open and the rail is a dropdown, not a column. */
  railIsPopover: boolean;
  railOpen: boolean;
  loading: boolean;
  projectCount: number;
  rail: ProjectRailModel;
  activeId: string | null;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onOpenMenu: (project: SizzleProject, event: ReactMouseEvent<HTMLElement>) => void;
  onDuplicate: (id: string) => void;
};

export function ProjectRail({
  railRef,
  railIsPopover,
  railOpen,
  loading,
  projectCount,
  rail,
  activeId,
  onCreate,
  onSelect,
  onOpenMenu,
  onDuplicate
}: ProjectRailProps): ReactElement {
  return (
    <aside
      id="szl-rail"
      ref={railRef}
      className="szl__rail"
      aria-hidden={railIsPopover && !railOpen ? true : undefined}
    >
      <button className="szl__new" onClick={onCreate} type="button">
        + New Sizzle Reel
      </button>
      <section className="szl__section" aria-label="Recent projects">
        <div className="szl__section-head">
          <span>Recents</span>
        </div>
        <ul className="szl__list szl__list--recents" data-testid="sizzle-recents-list">
          {loading ? (
            <li className="szl__empty">Loading...</li>
          ) : rail.recents.length === 0 ? (
            <li className="szl__empty">No recent projects.</li>
          ) : (
            rail.recents.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                active={activeId === p.id}
                onSelect={() => onSelect(p.id)}
                onOpenMenu={(event) => onOpenMenu(p, event)}
                onDuplicate={() => onDuplicate(p.id)}
              />
            ))
          )}
        </ul>
      </section>
      <section className="szl__section szl__section--projects" aria-label="Projects">
        <div className="szl__section-head">
          <span>Projects</span>
          {rail.totalProjectCount > rail.recents.length ? (
            <span className="szl__section-count">
              {rail.list.length} of{" "}
              {rail.totalProjectCount - rail.recents.length}
            </span>
          ) : null}
        </div>
        <ul className="szl__list szl__list--projects" data-testid="sizzle-projects-list">
          {loading ? null : projectCount === 0 ? (
            <li className="szl__empty">No projects yet. Create one above.</li>
          ) : rail.list.length === 0 ? (
            <li className="szl__empty">All visible projects are in Recents.</li>
          ) : (
            rail.list.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                active={activeId === p.id}
                onSelect={() => onSelect(p.id)}
                onOpenMenu={(event) => onOpenMenu(p, event)}
                onDuplicate={() => onDuplicate(p.id)}
              />
            ))
          )}
        </ul>
      </section>
    </aside>
  );
}

function ProjectRow({
  project,
  active,
  onSelect,
  onOpenMenu,
  onDuplicate
}: {
  project: SizzleProject;
  active: boolean;
  onSelect: () => void;
  onOpenMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onDuplicate: () => void;
}): ReactElement {
  const clipLabel = `${project.scenes.length} clip${project.scenes.length === 1 ? "" : "s"}`;
  const updatedLabel = isDifferentProjectDate(project.createdAt, project.modifiedAt)
    ? `Updated ${formatProjectDate(project.modifiedAt)}`
    : null;
  return (
    <li
      className="szl__row-wrap"
      onContextMenu={onOpenMenu}
    >
      <button
        className={"szl__row" + (active ? " is-active" : "")}
        onClick={onSelect}
        type="button"
      >
        <span className="szl__row-name">{project.name}</span>
        <span className="szl__row-meta">
          Created {formatProjectDate(project.createdAt)} · {clipLabel}
        </span>
        {updatedLabel !== null ? (
          <span className="szl__row-meta szl__row-meta--sub">{updatedLabel}</span>
        ) : null}
      </button>
      <button
        type="button"
        className="szl__row-duplicate"
        title="Duplicate Sizzle Reel"
        aria-label={`Duplicate ${project.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onDuplicate();
        }}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M5 15H4a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v1" />
        </svg>
      </button>
    </li>
  );
}

export function SizzleProjectContextMenu({
  menu,
  onClose,
  onOpenProject,
  onDuplicateProject
}: {
  menu: ProjectContextMenuState;
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
  onDuplicateProject: (projectId: string) => void;
}): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onMouseDown(event: MouseEvent): void {
      const root = rootRef.current;
      if (root === null) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [onClose]);

  useEffect(() => {
    requestAnimationFrame(() => rootRef.current?.focus());
  }, []);

  return (
    <div
      ref={rootRef}
      className="szl__context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
      onContextMenu={(event) => event.preventDefault()}
      aria-label={`${menu.projectName} actions`}
    >
      <button
        type="button"
        role="menuitem"
        className="szl__context-menu-row"
        onClick={() => onOpenProject(menu.projectId)}
      >
        Open
      </button>
      <button
        type="button"
        role="menuitem"
        className="szl__context-menu-row"
        onClick={() => onDuplicateProject(menu.projectId)}
      >
        Duplicate
      </button>
    </div>
  );
}
