// The Sizzle Reels composer window: title bar (brand + crumb + chat
// toggle), the project rail (a column with no reel open, a dropdown
// under the crumb with one), the editor + agent chat workspace, the
// capture picker modal, and the project context menu.
//
// Project state lives in `useSizzleProject`; the editor's preview
// plumbing in `useSequencePlan` (inside `Editor`). This file is the shell
// and the routing between them.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from "react";
import { sizzleProjectCaptureIds, type SizzleProject } from "@pwrsnap/shared";
import { PwrSnapMark, PwrSnapWordmark } from "../shared/BrandMark";
import { CapturePicker } from "./CapturePicker";
import { ChatResizer, getSavedChatWidth, setSavedChatWidth } from "./ChatResizer";
import { Editor } from "./Editor";
import {
  PROJECT_CONTEXT_MENU_HEIGHT,
  PROJECT_CONTEXT_MENU_WIDTH,
  ProjectRail,
  SizzleProjectContextMenu,
  clampContextMenuPosition,
  type ProjectContextMenuState
} from "./ProjectRail";
import { SizzleChatPanel } from "./SizzleChatPanel";
import { isTypingTarget } from "./sizzle-helpers";
import { useSizzleProject } from "./useSizzleProject";
import "./sizzle.css";

// Re-exported for the tests that pin these helpers at this module path.
export {
  formatSequencePreviewWarnings,
  formatTranscriptPhraseOptionLabel,
  type SequencePreviewDisplayWarning
} from "./sizzle-helpers";
export { resetSizzleChatWidthForTests } from "./ChatResizer";

type PickerTarget =
  | { kind: "scene" }
  | { kind: "sequenceBeat"; sceneId: string };

export function SizzleApp(): ReactElement {
  const {
    projects,
    active,
    activeId,
    loading,
    captures,
    status,
    projectRail,
    focusTitleForId,
    setFocusTitleForId,
    selectProject: selectProjectState,
    onCreate,
    onDuplicate,
    onDelete,
    onRender,
    onReveal,
    onUpdate,
    flushPatch,
    onAddScene,
    onAddSequenceBeat
  } = useSizzleProject();

  const [picker, setPicker] = useState<PickerTarget | null>(null);
  // Chat lives in a right sidebar alongside the editor (not a full-pane
  // swap) so the scene list stays visible + updates live as the agent
  // edits. Shown by default — chat is the primary way to compose a reel.
  const [showChat, setShowChat] = useState(true);
  // The project rail. With no reel open it is the left column (you need
  // the list to pick one). With a reel open it collapses into a dropdown
  // under the "Sizzle Reels ▾" crumb so the editor gets the full width —
  // a list of OTHER reels is not worth a third of the window while
  // authoring one. Ephemeral UI state, deliberately not in Settings.
  const [railOpen, setRailOpen] = useState(false);
  const railRef = useRef<HTMLElement | null>(null);
  const railCrumbRef = useRef<HTMLButtonElement | null>(null);
  // Chat pane width — drag the divider; module-scoped so it survives
  // remounts within a session (like EditToolbar's position).
  const [chatWidth, setChatWidth] = useState<number>(() => getSavedChatWidth());
  const [projectContextMenu, setProjectContextMenu] =
    useState<ProjectContextMenuState | null>(null);

  const selectProject = useCallback(
    (id: string): void => {
      selectProjectState(id);
      setRailOpen(false);
    },
    [selectProjectState]
  );

  // Rail-as-dropdown: close on outside click / Esc, toggle with ⌘⇧L.
  const railIsPopover = active !== null;
  useEffect(() => {
    if (!railIsPopover || !railOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (railRef.current?.contains(target) === true) return;
      if (railCrumbRef.current?.contains(target) === true) return;
      setRailOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setRailOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [railIsPopover, railOpen]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Only while a reel is open. Otherwise the rail IS the left column
      // and the chord just latches `railOpen`, leaving the dropdown
      // already expanded the next time a reel loads.
      if (!railIsPopover) return;
      // Never steal the chord from a text field: this editor is mostly
      // narration textareas, the reel title, and per-clip timing inputs.
      // Popping a dropdown mid-sentence while preventDefault swallows the
      // keystroke is what makes a shortcut feel broken.
      if (isTypingTarget(event.target)) return;
      if (event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setRailOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [railIsPopover]);
  useEffect(() => {
    setSavedChatWidth(chatWidth);
  }, [chatWidth]);

  const closeProjectContextMenu = useCallback((): void => {
    setProjectContextMenu(null);
  }, []);

  const openProjectContextMenu = useCallback(
    (project: SizzleProject, event: ReactMouseEvent<HTMLElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      const position = clampContextMenuPosition(
        event.clientX,
        event.clientY,
        PROJECT_CONTEXT_MENU_WIDTH,
        PROJECT_CONTEXT_MENU_HEIGHT
      );
      setProjectContextMenu({
        projectId: project.id,
        projectName: project.name,
        ...position
      });
    },
    []
  );

  return (
    <div
      className={
        "szl" +
        (railIsPopover ? " szl--rail-popover" : "") +
        (railIsPopover && railOpen ? " is-rail-open" : "")
      }
    >
      <header className="szl__titlebar">
        <div className="szl__title-brand">
          <span className="szl__title-mark">
            <PwrSnapMark size={18} />
          </span>
          <PwrSnapWordmark />
        </div>
        <span className="szl__title-crumb">
          {railIsPopover ? (
            <button
              ref={railCrumbRef}
              type="button"
              className={"szl__title-crumb-btn" + (railOpen ? " is-open" : "")}
              aria-haspopup="true"
              aria-expanded={railOpen}
              aria-controls="szl-rail"
              onClick={() => setRailOpen((v) => !v)}
              title="Browse Sizzle Reels (⌘⇧L)"
              data-testid="sizzle-rail-toggle"
            >
              Sizzle Reels
              <span className="szl__title-caret" aria-hidden="true">▾</span>
            </button>
          ) : (
            "Sizzle Reels"
          )}
          {active !== null ? (
            <>
              <span className="szl__title-sep">›</span>
              <span className="szl__title-here">{active.name}</span>
            </>
          ) : null}
        </span>
        {active !== null ? (
          <>
            <span className="szl__spacer" />
            <button
              type="button"
              className={"szl__chat-toggle" + (showChat ? " is-active" : "")}
              aria-pressed={showChat}
              onClick={() => setShowChat((v) => !v)}
              title={showChat ? "Hide agent chat" : "Show agent chat"}
            >
              {showChat ? "Hide chat" : "Chat with agent"}
            </button>
          </>
        ) : null}
      </header>
      <ProjectRail
        railRef={railRef}
        railIsPopover={railIsPopover}
        railOpen={railOpen}
        loading={loading}
        projectCount={projects.length}
        rail={projectRail}
        activeId={activeId}
        onCreate={() => void onCreate()}
        onSelect={selectProject}
        onOpenMenu={openProjectContextMenu}
        onDuplicate={(id) => void onDuplicate(id)}
      />

      <main className="szl__main">
        {active === null ? (
          <EmptyState />
        ) : (
          <div className="szl__workspace">
            <Editor
              project={active}
              captures={captures}
              autoFocusTitle={focusTitleForId === active.id}
              onTitleFocused={() => setFocusTitleForId(null)}
              onRename={(name) => onUpdate(active.id, { name })}
              onVoice={(voice) => onUpdate(active.id, { voice })}
              onProvider={(ttsProvider) => onUpdate(active.id, { ttsProvider })}
              onResolution={(resolution) =>
                onUpdate(active.id, { resolution })
              }
              onScenes={(scenes) => onUpdate(active.id, { scenes })}
              onFlushPending={() => flushPatch(active.id)}
              onPickCapture={() => setPicker({ kind: "scene" })}
              onPickSequenceBeat={(sceneId) => setPicker({ kind: "sequenceBeat", sceneId })}
              onRender={() => void onRender()}
              onReveal={() => void onReveal()}
              onDuplicate={() => void onDuplicate(active.id)}
              onDelete={() => void onDelete(active.id)}
              status={status}
            />
            {showChat ? (
              <aside className="szl__chat" style={{ flexBasis: chatWidth }}>
                <ChatResizer width={chatWidth} onResize={setChatWidth} />
                <SizzleChatPanel key={active.id} projectId={active.id} />
              </aside>
            ) : null}
          </div>
        )}
      </main>

      {picker !== null && active !== null ? (
        <CapturePicker
          captures={captures}
          onPick={(captureId) => {
            const added =
              picker.kind === "scene"
                ? onAddScene(captureId)
                : onAddSequenceBeat(picker.sceneId, captureId);
            void added.then(() => setPicker(null));
          }}
          onClose={() => setPicker(null)}
          existing={
            new Set(
              picker.kind === "scene"
                ? [...sizzleProjectCaptureIds(active.scenes)]
                : active.scenes
                    .find((s) => s.id === picker.sceneId)
                    ?.beats?.map((beat) => beat.captureId) ?? []
            )
          }
        />
      ) : null}
      {projectContextMenu !== null ? (
        <SizzleProjectContextMenu
          menu={projectContextMenu}
          onClose={closeProjectContextMenu}
          onOpenProject={(projectId) => {
            closeProjectContextMenu();
            selectProject(projectId);
          }}
          onDuplicateProject={(projectId) => {
            closeProjectContextMenu();
            void onDuplicate(projectId);
          }}
        />
      ) : null}
    </div>
  );
}

function EmptyState(): ReactElement {
  return (
    <div className="szl__empty-pane">
      <div className="szl__empty-mark">▶</div>
      <h2>Sizzle Reels</h2>
      <p>
        Pick a project on the left or create a new one to start composing a
        narrated reel from your captures.
      </p>
      <p className="szl__hint">
        Tip: Add your OpenAI API key in Settings → AI Providers to enable text-to-speech voiceover.
      </p>
    </div>
  );
}
