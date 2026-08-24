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
import {
  acceleratorToDisplayText,
  sizzleProjectCaptureIds,
  type ShortcutPlatform,
  type SizzleProject
} from "@pwrsnap/shared";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
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
import { isPrimaryAccel } from "../shared/keyboard";
import { useSizzleProject } from "./useSizzleProject";
import "./sizzle.css";

// Re-exported for the tests that pin these helpers at this module path.
export {
  formatSequencePreviewWarnings,
  formatTranscriptPhraseOptionLabel,
  type SequencePreviewDisplayWarning
} from "./sizzle-helpers";
export { resetSizzleChatWidthForTests } from "./ChatResizer";

/** Below this rail width the chat and the clip inspector cannot both be
 *  usable (plan §4.6): the inspector takes the rail and the chat folds to
 *  a one-line bar until the inspector closes or the rail widens. Plan §4.6
 *  guessed "roughly 480"; the inspector is a bottom DRAWER (stacked, not
 *  beside the chat), so the binding constraint is its widest row (type
 *  select + duration, ~300 px) — 360 keeps the default 400 px rail whole
 *  and folds only a deliberately narrowed one (the resizer floor is 320). */
export const RAIL_NARROW_PX = 360;

type PickerTarget =
  | { kind: "scene" }
  | { kind: "sequenceBeat"; sceneId: string };

export type SizzleAppProps = {
  /** Explicit host semantics keep shortcut behavior deterministic in tests. */
  readonly shortcutPlatform?: ShortcutPlatform;
};

export function SizzleApp({
  shortcutPlatform = rendererShortcutPlatform()
}: SizzleAppProps): ReactElement {
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
  // The selected clip on the timeline. Lives here (not in the Editor)
  // because the right rail shows the clip inspector for it beside the
  // chat — the rail needs to know when there is one to show. Ephemeral.
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  // …or the selected SCENE (a region / transition pill on the timeline).
  // Mutually exclusive with the clip selection; the Editor enforces it.
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  // The inspector's DOM slot in the right rail; the Editor portals the
  // inspector into it so the inspector's state + handlers stay with the
  // timeline model that owns them.
  const [inspectorHost, setInspectorHost] = useState<HTMLDivElement | null>(null);
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

  // Rail-as-dropdown: close on outside click / Esc, toggle with primary+Shift+L.
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
      if (
        isPrimaryAccel(event, shortcutPlatform) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "l"
      ) {
        event.preventDefault();
        setRailOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [railIsPopover, shortcutPlatform]);
  useEffect(() => {
    setSavedChatWidth(chatWidth);
  }, [chatWidth]);
  // A clip selection belongs to one reel; switching reels drops it.
  const selectedReelId = active?.id ?? null;
  useEffect(() => {
    setSelectedClipId(null);
    setSelectedSceneId(null);
  }, [selectedReelId]);

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
              title={`Browse Sizzle Reels (${acceleratorToDisplayText("CommandOrControl+Shift+L", shortcutPlatform)})`}
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
              selectedClipId={selectedClipId}
              onSelectClipId={setSelectedClipId}
              selectedSceneId={selectedSceneId}
              onSelectSceneId={setSelectedSceneId}
              inspectorHost={inspectorHost}
            />
            {showChat || selectedClipId !== null || selectedSceneId !== null ? (
              // The right rail: chat above, the clip inspector as a bottom
              // drawer (plan §4.6) — beside the chat, never replacing it.
              // Below RAIL_NARROW_PX the two cannot share the rail, so the
              // inspector takes over and the chat folds to a one-line bar
              // (still mounted — its state survives). A selected clip keeps
              // the rail up even with the chat hidden.
              <aside
                className={
                  "szl__chat" +
                  (selectedClipId !== null || selectedSceneId !== null ? " has-inspector" : "") +
                  (chatWidth < RAIL_NARROW_PX ? " is-narrow" : "")
                }
                style={{ flexBasis: chatWidth }}
                data-testid="sizzle-rail"
              >
                <ChatResizer width={chatWidth} onResize={setChatWidth} />
                {showChat ? (
                  <>
                    {(selectedClipId !== null || selectedSceneId !== null) && chatWidth < RAIL_NARROW_PX ? (
                      <div className="szl__chat-folded" data-testid="sizzle-chat-folded">
                        <span>Chat folded while the inspector is open — widen the rail, or</span>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedClipId(null);
                            setSelectedSceneId(null);
                          }}
                        >
                          close the inspector
                        </button>
                      </div>
                    ) : null}
                    <div
                      className={
                        "szl__chat-pane" +
                        ((selectedClipId !== null || selectedSceneId !== null) && chatWidth < RAIL_NARROW_PX ? " is-folded" : "")
                      }
                    >
                      <SizzleChatPanel key={active.id} projectId={active.id} />
                    </div>
                  </>
                ) : null}
                <div className="szl__inspector-host" ref={setInspectorHost} data-testid="sizzle-inspector-host" />
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
