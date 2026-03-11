import {
  type EditorId,
  type KeybindingCommand,
  type ProjectId,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type ThreadId,
  type WorktreeId,
} from "@repo/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DockviewReact,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
  type DockviewReadyEvent,
  themeDark,
  themeLight,
  type IDockviewPanelProps,
} from "dockview";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, Clock3Icon, GitBranchIcon, PlusIcon, XIcon } from "lucide-react";

import ChatView from "./ChatView";
import GitActionsControl from "./GitActionsControl";
import OpenInPicker from "./OpenInPicker";
import ProjectScriptsControl, { type NewProjectScriptInput } from "./ProjectScriptsControl";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIcons";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import WorktreeRightRail from "./WorktreeRightRail";
import WorkspaceDiffPanel from "./WorkspaceDiffPanel";
import WorkspaceFilePanel from "./WorkspaceFilePanel";
import VscodeEntryIcon from "./VscodeEntryIcon";
import { Button } from "./ui/button";
import { KbdTooltip } from "./ui/kbd-tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { SidebarTrigger } from "./ui/sidebar";
import { toastManager } from "./ui/toast";
import { useAppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useTheme } from "../hooks/useTheme";
import { gitBranchesQueryOptions } from "../lib/gitReactQuery";
import { formatRelativeTime } from "../lib/relativeTime";
import { decodeProjectScriptKeybindingRule } from "../lib/projectScriptKeybindings";
import { sendCreatePullRequestPrompt } from "../lib/pullRequestPrompt";
import { sendWorktreeThreadPrompt } from "../lib/sendWorktreeThreadPrompt";
import { resolveThreadStatusVisual } from "../lib/threadStatus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { ensureWorktreeDraftThread } from "../lib/worktreeDraftThread";
import { worktreeDisplaySubtitle, worktreeDisplayTitle } from "../lib/worktrees";
import { cn, newCommandId, randomUUID } from "../lib/utils";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
  projectScriptRuntimeEnv,
} from "../projectScripts";
import { useStore } from "../store";
import { selectWorktreeTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_THREAD_TERMINAL_COUNT,
  type ProjectScript,
} from "../types";
import type { Worktree } from "../types";
import {
  isDefaultCommitAndPushPromptShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import {
  buildDiffDockPanelId,
  buildFileDockPanelId,
  createDefaultWorktreeRightRailState,
  type WorktreeDockDiffPanelParams,
  type WorktreeDockFilePanelParams,
  type WorktreeDockPanelParams,
  type WorktreeDockThreadPanelParams,
  type WorktreeRightRailState,
  sanitizeSerializedDockviewLayout,
  useWorktreeChatLayoutStore,
} from "../worktreeChatLayoutStore";
import { useWorkspaceDockPanelStore } from "../workspaceDockPanelStore";

const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
const DOCKVIEW_THREAD_COMPONENT = "thread-chat";
const DOCKVIEW_FILE_COMPONENT = "workspace-file";
const DOCKVIEW_DIFF_COMPONENT = "workspace-diff";
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];
const MIN_RIGHT_RAIL_WIDTH = 260;
const MAX_RIGHT_RAIL_WIDTH = 520;

function clampRightRailWidth(width: number): number {
  const safeWidth = Number.isFinite(width) ? width : MIN_RIGHT_RAIL_WIDTH;
  return Math.min(Math.max(Math.round(safeWidth), MIN_RIGHT_RAIL_WIDTH), MAX_RIGHT_RAIL_WIDTH);
}

function basename(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}

function isThreadPanelParams(
  params: WorktreeDockPanelParams,
): params is WorktreeDockThreadPanelParams {
  return params.kind === "thread";
}

function threadIdFromPanelParams(params: WorktreeDockPanelParams): ThreadId | null {
  return params.kind === "thread" ? params.threadId : null;
}

declare global {
  interface Window {
    __T3CODE_DOCKVIEW_API__?: DockviewApi;
  }
}

interface WorkspaceThreadEntry {
  threadId: ThreadId;
  projectId: ProjectId;
  title: string;
  worktreeId: WorktreeId;
  worktreePath: string | null;
  branch: string | null;
  createdAt: string;
  isServerThread: boolean;
}

interface WorktreeChatWorkspaceProps {
  threadId: ThreadId;
  worktreeId: WorktreeId;
}

type DockviewHeaderActionsProps = Parameters<
  NonNullable<ComponentProps<typeof DockviewReact>["leftHeaderActionsComponent"]>
>[0];

interface DockThreadHeaderActionsExtraProps {
  worktree: Worktree | null;
  projectName: string | null;
  worktreeSubtitle: string | null;
  unopenedThreads: readonly WorkspaceThreadEntry[];
  referenceThreadId: ThreadId | null;
  onCreateThread: (referencePanelId: ThreadId | null) => void;
  onOpenThread: (threadId: ThreadId, referencePanelId: ThreadId | null) => void;
}

function readLastInvokedScriptByProjectFromStorage(): Record<string, string> {
  const stored = localStorage.getItem(LAST_INVOKED_SCRIPT_BY_PROJECT_KEY);
  if (!stored) return {};

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function DockThreadPanel({
  params,
  routeThreadId,
  focusThreadId,
  onActivateThread,
  api,
}: IDockviewPanelProps<WorktreeDockThreadPanelParams> & {
  routeThreadId: ThreadId;
  focusThreadId: ThreadId;
  onActivateThread: (threadId: ThreadId) => void;
}) {
  const activateThread = useCallback(() => {
    api.setActive();
    onActivateThread(params.threadId);
  }, [api, onActivateThread, params.threadId]);

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      onFocusCapture={activateThread}
      onPointerDownCapture={activateThread}
    >
      <ChatView
        threadId={params.threadId}
        routeActive={params.threadId === routeThreadId}
        focusHotkeyActive={params.threadId === focusThreadId}
        showHeader={false}
        showTerminalDrawer={false}
        showPlanSidebar={false}
        enableGlobalShortcuts={false}
      />
    </div>
  );
}

function useDockPanelTitle(api: IDockviewPanelHeaderProps<WorktreeDockPanelParams>["api"]): string {
  const [title, setTitle] = useState(api.title ?? "");

  useEffect(() => {
    setTitle(api.title ?? "");
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title);
    });
    return () => {
      disposable.dispose();
    };
  }, [api]);

  return title;
}

function DockWorkspaceTab(props: IDockviewPanelHeaderProps<WorktreeDockPanelParams>) {
  const title = useDockPanelTitle(props.api);
  const { resolvedTheme } = useTheme();
  const threadParams = props.params.kind === "thread" ? props.params : null;
  const panelMeta = useWorkspaceDockPanelStore(
    useCallback((state) => state.metaByPanelId[props.api.id] ?? null, [props.api.id]),
  );
  const serverThread = useStore(
    useCallback(
      (store) =>
        threadParams
          ? (store.threads.find((thread) => thread.id === threadParams.threadId) ?? null)
          : null,
      [threadParams],
    ),
  );
  const draftProvider = useComposerDraftStore(
    useCallback(
      (store) =>
        threadParams ? (store.draftsByThreadId[threadParams.threadId]?.provider ?? null) : null,
      [threadParams],
    ),
  );

  const provider: ProviderKind = serverThread?.session?.provider ?? draftProvider ?? "codex";
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider];
  const threadStatus =
    threadParams && serverThread ? resolveThreadStatusVisual(serverThread) : null;
  const tabLabel =
    title || (props.params.kind === "thread" ? "Thread" : basename(props.params.relativePath));

  return (
    <div className="dv-default-tab">
      <div className="dv-default-tab-content">
        <span className="flex min-w-0 items-center gap-1.5">
          {props.params.kind === "thread" ? (
            <>
              <ProviderIcon aria-hidden="true" className="size-3 shrink-0 opacity-75" />
              {threadStatus ? (
                <span
                  aria-label={threadStatus.label}
                  className="inline-flex shrink-0"
                  data-dock-thread-status={threadStatus.kind}
                  data-thread-id={props.params.threadId}
                  title={threadStatus.label}
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${threadStatus.dotClass} ${
                      threadStatus.pulse ? "animate-pulse" : ""
                    }`}
                  />
                </span>
              ) : null}
            </>
          ) : (
            <>
              <VscodeEntryIcon
                pathValue={props.params.relativePath}
                kind="file"
                theme={resolvedTheme === "dark" ? "dark" : "light"}
              />
              {panelMeta?.dirty ? (
                <span
                  aria-label="Unsaved changes"
                  className="inline-flex h-2 w-2 shrink-0 rounded-full bg-warning"
                />
              ) : null}
            </>
          )}
          <span
            className="truncate"
            title={props.params.kind === "thread" ? tabLabel : props.params.relativePath}
          >
            {tabLabel}
          </span>
        </span>
      </div>
      {props.tabLocation === "header" ? (
        <button
          aria-label={`Close ${tabLabel || "tab"}`}
          className="dv-default-tab-action appearance-none border-0 bg-transparent text-inherit"
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.api.close();
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <XIcon aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function buildThreadPanelParams(entry: WorkspaceThreadEntry): WorktreeDockThreadPanelParams {
  return {
    kind: "thread",
    threadId: entry.threadId,
    worktreeId: entry.worktreeId,
    title: entry.title,
  };
}

function buildFilePanelParams(
  worktreeId: WorktreeId,
  relativePath: string,
): WorktreeDockFilePanelParams {
  return {
    kind: "file",
    worktreeId,
    relativePath,
    title: basename(relativePath),
  };
}

function buildDiffPanelParams(
  worktreeId: WorktreeId,
  relativePath: string,
): WorktreeDockDiffPanelParams {
  return {
    kind: "diff",
    worktreeId,
    relativePath,
    title: basename(relativePath),
  };
}

function DockThreadHeaderActions({
  worktree,
  referenceThreadId,
  onCreateThread,
}: DockviewHeaderActionsProps &
  Pick<DockThreadHeaderActionsExtraProps, "worktree" | "referenceThreadId" | "onCreateThread">) {
  const worktreeTitle = worktree ? worktreeDisplayTitle(worktree) : "Threads";
  return (
    <div className="dockview-thread-actions flex items-center gap-0.5 pr-1">
      <KbdTooltip label="New thread" side="bottom">
        <Button
          aria-label={`Create a new thread in ${worktreeTitle}`}
          className="dockview-thread-action"
          disabled={!worktree}
          size="icon-xs"
          variant="ghost"
          onClick={() => onCreateThread(referenceThreadId)}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </KbdTooltip>
    </div>
  );
}

function DockThreadHistoryAction({
  worktree,
  projectName,
  referenceThreadId,
  worktreeSubtitle,
  unopenedThreads,
  onOpenThread,
}: DockviewHeaderActionsProps & DockThreadHeaderActionsExtraProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const worktreeTitle = worktree ? worktreeDisplayTitle(worktree) : "Threads";

  return (
    <div className="dockview-thread-actions flex items-center gap-0.5 pr-1">
      <Popover onOpenChange={setPickerOpen} open={pickerOpen}>
        <PopoverTrigger
          render={
            <Button
              aria-label={`Open a closed thread from ${worktreeTitle}`}
              className="dockview-thread-action"
              disabled={!worktree}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <Clock3Icon className="size-3.5" />
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-[22rem] p-0" side="bottom" sideOffset={6}>
          <div className="border-b px-2.5 py-1.5">
            <div className="truncate text-xs font-medium text-foreground">{worktreeTitle}</div>
            <div className="truncate text-[10px] text-muted-foreground">
              {worktreeSubtitle ?? projectName ?? "Worktree threads"}
            </div>
          </div>

          {unopenedThreads.length > 0 ? (
            <ul className="max-h-80 space-y-0.5 overflow-y-auto p-1.5">
              {unopenedThreads.map((entry) => (
                <li key={entry.threadId}>
                  <button
                    className="flex h-6.5 w-full items-center justify-between gap-2.5 rounded-md px-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    type="button"
                    onClick={() => {
                      onOpenThread(entry.threadId, referenceThreadId);
                      setPickerOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {entry.isServerThread ? entry.title : "New thread"}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {formatRelativeTime(entry.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-2.5 py-5 text-center text-xs text-muted-foreground">
              All threads in this worktree are already open.
            </div>
          )}
        </PopoverPopup>
      </Popover>
    </div>
  );
}

export default function WorktreeChatWorkspace({
  threadId,
  worktreeId,
}: WorktreeChatWorkspaceProps) {
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const isMobile = useMediaQuery("(max-width: 767px)");

  const projects = useStore((store) => store.projects);
  const worktrees = useStore((store) => store.worktrees);
  const threads = useStore((store) => store.threads);
  const setStoreThreadError = useStore((store) => store.setError);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const getDraftThreadByWorktreeId = useComposerDraftStore(
    (store) => store.getDraftThreadByWorktreeId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setWorktreeDraftThreadId = useComposerDraftStore((store) => store.setWorktreeDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const layout = useWorktreeChatLayoutStore(
    (store) => store.layoutsByWorktreeId[worktreeId] ?? null,
  );
  const setLayout = useWorktreeChatLayoutStore((store) => store.setLayout);
  const storedRightRailState = useWorktreeChatLayoutStore(
    (store) => store.rightRailStateByWorktreeId[worktreeId] ?? null,
  );
  const storeSetRightRailState = useWorktreeChatLayoutStore((store) => store.setRightRailState);
  const [dockviewApi, setDockviewApi] = useState<DockviewApi | null>(null);
  const [focusedDockThreadId, setFocusedDockThreadId] = useState<ThreadId>(threadId);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const restoredRef = useRef(false);
  const pendingPanelReferenceIdRef = useRef<string | null>(null);
  const rightRailResizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    divider: HTMLDivElement;
  } | null>(null);
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useState<
    Record<string, string>
  >(() => readLastInvokedScriptByProjectFromStorage());
  const worktreeTerminalOwnerId = worktreeId as unknown as ThreadId;
  const rightRailState = useMemo(
    () => storedRightRailState ?? createDefaultWorktreeRightRailState(),
    [storedRightRailState],
  );
  const rightRailWidth = clampRightRailWidth(rightRailState.width);

  const workspaceThreadsById = useMemo(() => {
    const next = new Map<ThreadId, WorkspaceThreadEntry>();
    for (const thread of threads) {
      if (thread.worktreeId !== worktreeId) {
        continue;
      }
      next.set(thread.id, {
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        worktreeId,
        worktreePath: thread.worktreePath,
        branch: thread.branch,
        createdAt: thread.createdAt,
        isServerThread: true,
      });
    }

    for (const [draftThreadId, draftThread] of Object.entries(draftThreadsByThreadId)) {
      if (draftThread.worktreeId !== worktreeId || next.has(draftThreadId as ThreadId)) {
        continue;
      }
      next.set(draftThreadId as ThreadId, {
        threadId: draftThreadId as ThreadId,
        projectId: draftThread.projectId,
        title: "New thread",
        worktreeId,
        worktreePath: draftThread.worktreePath,
        branch: draftThread.branch,
        createdAt: draftThread.createdAt,
        isServerThread: false,
      });
    }

    return next;
  }, [draftThreadsByThreadId, threads, worktreeId]);
  const workspaceThreadIds = useMemo(
    () => new Set(workspaceThreadsById.keys()),
    [workspaceThreadsById],
  );
  const activeThread = workspaceThreadsById.get(threadId) ?? null;
  const focusedThread = workspaceThreadsById.get(focusedDockThreadId) ?? activeThread;
  const activeWorktree = worktrees.find((worktree) => worktree.id === worktreeId) ?? null;
  const activeProject =
    projects.find(
      (project) => project.id === (activeThread?.projectId ?? activeWorktree?.projectId),
    ) ?? null;
  const focusedProject =
    projects.find((project) => project.id === (focusedThread?.projectId ?? activeProject?.id)) ??
    activeProject;
  const activeThreadId = activeThread?.threadId ?? null;
  const gitCwd =
    activeThread?.worktreePath ??
    (activeWorktree && !activeWorktree.isRoot ? activeWorktree.workspacePath : null) ??
    activeProject?.cwd ??
    null;
  const worktreeSubtitle =
    activeWorktree && activeProject ? worktreeDisplaySubtitle(activeWorktree, activeProject) : null;
  const worktreeHeaderLabel = [activeProject?.name, activeThread?.branch].filter(Boolean).join("/");

  const keybindingsQuery = useQuery(serverConfigQueryOptions());
  const branchesQuery = useQuery(gitBranchesQueryOptions(gitCwd));
  const keybindings = keybindingsQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = keybindingsQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
  const isGitRepo = branchesQuery.data?.isRepo ?? true;

  const terminalState = useTerminalStateStore((state) =>
    selectWorktreeTerminalState(state.terminalStateByWorktreeId, worktreeId),
  );
  const storeSetTerminalOpen = useTerminalStateStore((state) => state.setWorktreeTerminalOpen);
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setWorktreeTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitWorktreeTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newWorktreeTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveWorktreeTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeWorktreeTerminal);

  const threadTerminalRuntimeEnv = useMemo(() => {
    if (!activeProject?.cwd) return {};
    return projectScriptRuntimeEnv({
      project: { cwd: activeProject.cwd },
      worktreePath:
        (activeWorktree && !activeWorktree.isRoot ? activeWorktree.workspacePath : null) ??
        activeThread?.worktreePath ??
        null,
    });
  }, [activeProject?.cwd, activeThread?.worktreePath, activeWorktree]);

  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split"),
    [keybindings],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new"),
    [keybindings],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close"),
    [keybindings],
  );
  const hasReachedTerminalLimit = terminalState.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT;
  const setRightRailState = useCallback(
    (
      updater:
        | Partial<WorktreeRightRailState>
        | ((state: WorktreeRightRailState) => Partial<WorktreeRightRailState>),
    ) => {
      storeSetRightRailState(worktreeId, updater);
    },
    [storeSetRightRailState, worktreeId],
  );

  const setTerminalOpen = useCallback(
    (open: boolean) => {
      storeSetTerminalOpen(worktreeId, open);
    },
    [storeSetTerminalOpen, worktreeId],
  );
  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(worktreeId, height);
    },
    [storeSetTerminalHeight, worktreeId],
  );
  const splitTerminal = useCallback(() => {
    if (hasReachedTerminalLimit) return;
    storeSplitTerminal(worktreeId, `terminal-${randomUUID()}`);
    setTerminalFocusRequestId((value) => value + 1);
  }, [hasReachedTerminalLimit, storeSplitTerminal, worktreeId]);
  const createNewTerminal = useCallback(() => {
    if (hasReachedTerminalLimit) return;
    storeNewTerminal(worktreeId, `terminal-${randomUUID()}`);
    setTerminalFocusRequestId((value) => value + 1);
  }, [hasReachedTerminalLimit, storeNewTerminal, worktreeId]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(worktreeId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [storeSetActiveTerminal, worktreeId],
  );
  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: worktreeTerminalOwnerId, terminalId, data: "exit\n" })
          .catch(() => undefined);

      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: worktreeTerminalOwnerId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: worktreeTerminalOwnerId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }

      storeCloseTerminal(worktreeId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [storeCloseTerminal, terminalState.terminalIds.length, worktreeId, worktreeTerminalOwnerId],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      nextScripts: ProjectScript[];
      keybinding: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);
      await persistProjectScripts({
        projectId: activeProject.id,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );

  const runProjectScript = useCallback(
    async (script: ProjectScript) => {
      const api = readNativeApi();
      if (!api || !activeProject) return;

      setLastInvokedScriptByProjectId((current) => {
        if (current[activeProject.id] === script.id) return current;
        return { ...current, [activeProject.id]: script.id };
      });

      const targetCwd = gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const shouldCreateNewTerminal =
        isBaseTerminalBusy && terminalState.terminalIds.length < MAX_THREAD_TERMINAL_COUNT;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;

      if (shouldCreateNewTerminal) {
        storeNewTerminal(worktreeId, targetTerminalId);
        storeSetActiveTerminal(worktreeId, targetTerminalId);
      } else if (targetTerminalId !== terminalState.activeTerminalId) {
        storeSetActiveTerminal(worktreeId, targetTerminalId);
      }

      setTerminalOpen(true);
      setTerminalFocusRequestId((value) => value + 1);

      try {
        await api.terminal.open({
          threadId: worktreeTerminalOwnerId,
          terminalId: targetTerminalId,
          cwd: targetCwd,
          env: threadTerminalRuntimeEnv,
        });
        await api.terminal.write({
          threadId: worktreeTerminalOwnerId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        if (activeThreadId) {
          setStoreThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
          );
        }
      }
    },
    [
      activeProject,
      activeThreadId,
      gitCwd,
      setStoreThreadError,
      setTerminalOpen,
      storeNewTerminal,
      storeSetActiveTerminal,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
      threadTerminalRuntimeEnv,
      worktreeId,
      worktreeTerminalOwnerId,
    ],
  );
  const sendCommitAndPushPrompt = useCallback(async () => {
    if (!focusedThread || !focusedProject?.model) {
      toastManager.add({
        type: "warning",
        title: "No focused thread",
        description: "Open or create a worktree thread first.",
      });
      return;
    }

    try {
      await sendWorktreeThreadPrompt({
        targetThreadId: focusedThread.threadId,
        worktreeId,
        projectId: focusedProject.id,
        projectModel: focusedProject.model,
        prompt: settings.commitAndPushPrompt,
        isServerThread: focusedThread.isServerThread,
        draftThread: getDraftThread(focusedThread.threadId),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not send prompt",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
      });
    }
  }, [focusedProject, focusedThread, getDraftThread, settings.commitAndPushPrompt, worktreeId]);
  const sendCreatePullRequestMessage = useCallback(async () => {
    if (!focusedThread || !focusedProject?.model || !gitCwd) {
      toastManager.add({
        type: "warning",
        title: "No focused thread",
        description: "Open or create a worktree thread first.",
      });
      return;
    }

    try {
      await sendCreatePullRequestPrompt({
        queryClient,
        cwd: gitCwd,
        worktreeId,
        projectId: focusedProject.id,
        projectModel: focusedProject.model,
        targetThreadId: focusedThread.threadId,
        isServerThread: focusedThread.isServerThread,
        draftThread: getDraftThread(focusedThread.threadId),
        defaultPullRequestBaseBranch: focusedProject.defaultPullRequestBaseBranch,
        promptTemplate: focusedProject.pullRequestPromptTemplate,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not send prompt",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
      });
    }
  }, [focusedProject, focusedThread, getDraftThread, gitCwd, queryClient, worktreeId]);

  useEffect(() => {
    if (rightRailState.width === rightRailWidth) {
      return;
    }
    setRightRailState({ width: rightRailWidth });
  }, [rightRailState.width, rightRailWidth, setRightRailState]);

  const stopRightRailResize = useCallback((pointerId: number) => {
    const resizeState = rightRailResizeStateRef.current;
    if (!resizeState) {
      return;
    }
    rightRailResizeStateRef.current = null;
    document.body.style.cursor = "";
    if (resizeState.divider.hasPointerCapture(pointerId)) {
      resizeState.divider.releasePointerCapture(pointerId);
    }
  }, []);

  const handleRightRailResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile || !rightRailState.open) {
        return;
      }
      event.preventDefault();
      rightRailResizeStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: rightRailWidth,
        divider: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
    },
    [isMobile, rightRailState.open, rightRailWidth],
  );

  const handleRightRailResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = rightRailResizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }
      const nextWidth = clampRightRailWidth(
        resizeState.startWidth + (resizeState.startX - event.clientX),
      );
      setRightRailState({ width: nextWidth });
    },
    [setRightRailState],
  );

  const handleRightRailResizePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = rightRailResizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }
      stopRightRailResize(event.pointerId);
    },
    [stopRightRailResize],
  );

  useEffect(
    () => () => {
      document.body.style.cursor = "";
    },
    [],
  );

  useEffect(() => {
    try {
      if (Object.keys(lastInvokedScriptByProjectId).length === 0) {
        localStorage.removeItem(LAST_INVOKED_SCRIPT_BY_PROJECT_KEY);
        return;
      }
      localStorage.setItem(
        LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
        JSON.stringify(lastInvokedScriptByProjectId),
      );
    } catch {
      // Ignore storage failures.
    }
  }, [lastInvokedScriptByProjectId]);

  const addDockPanel = useCallback(
    (
      api: DockviewApi,
      input: {
        id: string;
        component: string;
        title: string;
        params: WorktreeDockPanelParams;
        referencePanelId?: string | null;
      },
    ) => {
      const resolvedReferencePanelId =
        input.referencePanelId ?? pendingPanelReferenceIdRef.current ?? null;
      const referencePanel =
        (resolvedReferencePanelId ? api.getPanel(resolvedReferencePanelId) : null) ??
        api.activePanel;
      const panel = api.addPanel<WorktreeDockPanelParams>({
        id: input.id,
        component: input.component,
        title: input.title,
        params: input.params,
        renderer: "always",
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              } as const,
            }
          : {}),
      });
      pendingPanelReferenceIdRef.current = null;
      return panel;
    },
    [],
  );

  const addThreadPanel = useCallback(
    (api: DockviewApi, targetThreadId: ThreadId, referencePanelId?: string | null) => {
      const entry = workspaceThreadsById.get(targetThreadId);
      if (!entry) {
        return null;
      }

      return addDockPanel(api, {
        id: targetThreadId,
        component: DOCKVIEW_THREAD_COMPONENT,
        title: entry.title,
        params: buildThreadPanelParams(entry),
        ...(referencePanelId !== undefined ? { referencePanelId } : {}),
      });
    },
    [addDockPanel, workspaceThreadsById],
  );

  const openThreadInGroup = useCallback(
    (targetThreadId: ThreadId, referencePanelId: ThreadId | null) => {
      if (!dockviewApi) return;
      const existingPanel = dockviewApi.getPanel(targetThreadId);
      if (existingPanel) {
        pendingPanelReferenceIdRef.current = null;
        existingPanel.api.setActive();
        return;
      }

      const addedPanel = addThreadPanel(dockviewApi, targetThreadId, referencePanelId);
      if (addedPanel) {
        addedPanel.api.setActive();
      }
    },
    [addThreadPanel, dockviewApi],
  );

  const openWorkspaceFile = useCallback(
    (relativePath: string, panelType: "file" | "diff") => {
      if (!dockviewApi) {
        return;
      }
      const panelId =
        panelType === "file"
          ? buildFileDockPanelId(relativePath)
          : buildDiffDockPanelId(relativePath);
      const existingPanel = dockviewApi.getPanel(panelId);
      if (existingPanel) {
        existingPanel.api.setActive();
        return;
      }
      const panel = addDockPanel(dockviewApi, {
        id: panelId,
        component: panelType === "file" ? DOCKVIEW_FILE_COMPONENT : DOCKVIEW_DIFF_COMPONENT,
        title: basename(relativePath),
        params:
          panelType === "file"
            ? buildFilePanelParams(worktreeId, relativePath)
            : buildDiffPanelParams(worktreeId, relativePath),
      });
      panel?.api.setActive();
      if (isMobile && rightRailState.open) {
        setRightRailState({ open: false });
      }
    },
    [addDockPanel, dockviewApi, isMobile, rightRailState.open, setRightRailState, worktreeId],
  );

  const handleCreateThread = useCallback(
    (referencePanelId: ThreadId | null) => {
      if (!activeProject || !activeWorktree) {
        return;
      }

      const nextThreadId = ensureWorktreeDraftThread({
        projectId: activeProject.id,
        worktreeId,
        routeThreadId: threadId,
        branch: activeWorktree.branch,
        worktreePath: activeWorktree.isRoot ? null : activeWorktree.workspacePath,
        envMode: activeWorktree.isRoot ? "local" : "worktree",
        getDraftThreadByWorktreeId,
        getDraftThread,
        setWorktreeDraftThreadId,
        setDraftThreadContext,
      });

      const existingPanel = dockviewApi?.getPanel(nextThreadId);
      if (existingPanel) {
        pendingPanelReferenceIdRef.current = null;
        existingPanel.api.setActive();
      } else if (workspaceThreadsById.has(nextThreadId)) {
        openThreadInGroup(nextThreadId, referencePanelId);
      } else {
        pendingPanelReferenceIdRef.current = referencePanelId;
      }

      if (threadId !== nextThreadId) {
        void navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      }
    },
    [
      activeProject,
      activeWorktree,
      dockviewApi,
      getDraftThread,
      getDraftThreadByWorktreeId,
      navigate,
      openThreadInGroup,
      setDraftThreadContext,
      setWorktreeDraftThreadId,
      threadId,
      workspaceThreadsById,
      worktreeId,
    ],
  );

  const unopenedThreads = useMemo(() => {
    const openThreadIds = new Set(
      (dockviewApi?.panels ?? [])
        .map((panel) => panel.api.getParameters<WorktreeDockPanelParams>())
        .filter(isThreadPanelParams)
        .map((panel) => panel.threadId),
    );
    return [...workspaceThreadsById.values()]
      .filter((entry) => !openThreadIds.has(entry.threadId))
      .toSorted(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          right.threadId.localeCompare(left.threadId),
      );
  }, [dockviewApi?.panels, workspaceThreadsById]);

  const referenceThreadId = useMemo(() => {
    if (workspaceThreadsById.has(focusedDockThreadId)) {
      return focusedDockThreadId;
    }
    return workspaceThreadsById.has(threadId) ? threadId : null;
  }, [focusedDockThreadId, threadId, workspaceThreadsById]);

  const leftHeaderActionsComponent = useCallback(
    (props: DockviewHeaderActionsProps) => (
      <DockThreadHeaderActions
        {...props}
        worktree={activeWorktree}
        referenceThreadId={referenceThreadId}
        onCreateThread={handleCreateThread}
      />
    ),
    [activeWorktree, handleCreateThread, referenceThreadId],
  );

  const rightHeaderActionsComponent = useCallback(
    (props: DockviewHeaderActionsProps) => (
      <DockThreadHistoryAction
        {...props}
        projectName={activeProject?.name ?? null}
        referenceThreadId={referenceThreadId}
        worktree={activeWorktree}
        worktreeSubtitle={worktreeSubtitle}
        unopenedThreads={unopenedThreads}
        onCreateThread={handleCreateThread}
        onOpenThread={openThreadInGroup}
      />
    ),
    [
      activeProject?.name,
      activeWorktree,
      handleCreateThread,
      openThreadInGroup,
      referenceThreadId,
      unopenedThreads,
      worktreeSubtitle,
    ],
  );

  const activateFocusedThread = useCallback(
    (nextThreadId: ThreadId, options?: { syncRoute?: boolean }) => {
      setFocusedDockThreadId((current) => (current === nextThreadId ? current : nextThreadId));

      if (options?.syncRoute === false || nextThreadId === threadId) {
        return;
      }

      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        replace: true,
      });
    },
    [navigate, threadId],
  );

  const dockComponents = useMemo(
    () => ({
      [DOCKVIEW_THREAD_COMPONENT]: (props: IDockviewPanelProps<WorktreeDockPanelParams>) => (
        <DockThreadPanel
          {...(props as IDockviewPanelProps<WorktreeDockThreadPanelParams>)}
          focusThreadId={focusedDockThreadId}
          onActivateThread={activateFocusedThread}
          routeThreadId={threadId}
        />
      ),
      [DOCKVIEW_FILE_COMPONENT]: (props: IDockviewPanelProps<WorktreeDockPanelParams>) => (
        <WorkspaceFilePanel
          {...(props as IDockviewPanelProps<WorktreeDockFilePanelParams>)}
          cwd={gitCwd}
        />
      ),
      [DOCKVIEW_DIFF_COMPONENT]: (props: IDockviewPanelProps<WorktreeDockPanelParams>) => (
        <WorkspaceDiffPanel
          {...(props as IDockviewPanelProps<WorktreeDockDiffPanelParams>)}
          cwd={gitCwd}
          onOpenFile={(relativePath) => openWorkspaceFile(relativePath, "file")}
        />
      ),
    }),
    [activateFocusedThread, focusedDockThreadId, gitCwd, openWorkspaceFile, threadId],
  );

  useEffect(() => {
    if (!dockviewApi || restoredRef.current) return;
    restoredRef.current = true;

    const sanitizedLayout =
      layout && workspaceThreadIds.size > 0
        ? sanitizeSerializedDockviewLayout({
            layout,
            validThreadIds: workspaceThreadIds,
            worktreeId,
          })
        : null;

    dockviewApi.clear();
    if (sanitizedLayout) {
      dockviewApi.fromJSON(sanitizedLayout);
    }
    if (!dockviewApi.getPanel(threadId)) {
      addThreadPanel(dockviewApi, threadId);
    }
    dockviewApi.getPanel(threadId)?.api.setActive();
  }, [addThreadPanel, dockviewApi, layout, threadId, workspaceThreadIds, worktreeId]);

  useEffect(() => {
    if (!dockviewApi || !restoredRef.current || !workspaceThreadsById.has(threadId)) return;

    const existing = dockviewApi.getPanel(threadId);
    if (existing) {
      pendingPanelReferenceIdRef.current = null;
      existing.api.setActive();
      return;
    }

    addThreadPanel(dockviewApi, threadId)?.api.setActive();
  }, [addThreadPanel, dockviewApi, threadId, workspaceThreadsById]);

  useEffect(() => {
    if (!dockviewApi) return;

    const panels = [...dockviewApi.panels];
    for (const panel of panels) {
      const currentParams = panel.api.getParameters<WorktreeDockPanelParams>();
      if (!isThreadPanelParams(currentParams)) {
        continue;
      }
      const nextEntry = workspaceThreadsById.get(currentParams.threadId);
      if (!nextEntry) {
        panel.api.close();
        continue;
      }
      const currentThreadParams = currentParams as WorktreeDockThreadPanelParams;

      if (panel.title !== nextEntry.title) {
        panel.api.setTitle(nextEntry.title);
      }

      const nextParams = buildThreadPanelParams(nextEntry);
      if (
        currentThreadParams.threadId !== nextParams.threadId ||
        currentThreadParams.worktreeId !== nextParams.worktreeId ||
        currentThreadParams.title !== nextParams.title
      ) {
        panel.api.updateParameters(nextParams);
      }
    }

    if (workspaceThreadsById.has(threadId)) {
      return;
    }

    const nextPanel =
      dockviewApi.panels.find((panel) =>
        isThreadPanelParams(panel.api.getParameters<WorktreeDockPanelParams>()),
      ) ?? null;
    if (!nextPanel) {
      void navigate({ to: "/", replace: true });
      return;
    }

    const nextThreadId = threadIdFromPanelParams(
      nextPanel.api.getParameters<WorktreeDockPanelParams>(),
    );
    if (!nextThreadId) {
      return;
    }

    void navigate({
      to: "/$threadId",
      params: { threadId: nextThreadId },
      replace: true,
    });
  }, [dockviewApi, navigate, threadId, workspaceThreadsById]);

  useEffect(() => {
    if (!dockviewApi) return;

    const syncFocusedThread = (
      nextParams: WorktreeDockPanelParams | null | undefined,
      syncRoute: boolean,
    ) => {
      const nextThreadId = nextParams ? threadIdFromPanelParams(nextParams) : null;
      if (!nextThreadId) {
        return;
      }

      activateFocusedThread(nextThreadId, { syncRoute });
    };

    syncFocusedThread(
      dockviewApi.activeGroup?.activePanel?.api.getParameters<WorktreeDockPanelParams>() ??
        dockviewApi.activePanel?.api.getParameters<WorktreeDockPanelParams>() ??
        null,
      false,
    );

    const layoutDisposable = dockviewApi.onDidLayoutChange(() => {
      setLayout(worktreeId, dockviewApi.toJSON());
    });
    const activePanelDisposable = dockviewApi.onDidActivePanelChange((panel) => {
      syncFocusedThread(panel?.api.getParameters<WorktreeDockPanelParams>() ?? null, true);
    });
    const activeGroupDisposable = dockviewApi.onDidActiveGroupChange((group) => {
      syncFocusedThread(
        group?.activePanel?.api.getParameters<WorktreeDockPanelParams>() ?? null,
        true,
      );
    });

    return () => {
      layoutDisposable.dispose();
      activePanelDisposable.dispose();
      activeGroupDisposable.dispose();
    };
  }, [activateFocusedThread, dockviewApi, setLayout, worktreeId]);

  useEffect(() => {
    if (import.meta.env.MODE !== "test") {
      return;
    }

    if (dockviewApi) {
      window.__T3CODE_DOCKVIEW_API__ = dockviewApi;
    } else {
      delete window.__T3CODE_DOCKVIEW_API__;
    }

    return () => {
      if (window.__T3CODE_DOCKVIEW_API__ === dockviewApi) {
        delete window.__T3CODE_DOCKVIEW_API__;
      }
    };
  }, [dockviewApi]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
      };
      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      const useDefaultPromptHotkeyFallback =
        command === null &&
        !shortcutContext.terminalFocus &&
        isDefaultCommitAndPushPromptShortcut(event);
      const resolvedCommand =
        command ?? (useDefaultPromptHotkeyFallback ? "prompt.commitAndPush" : null);
      if (!resolvedCommand) return;

      if (resolvedCommand === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        setTerminalOpen(!terminalState.terminalOpen);
        return;
      }

      if (resolvedCommand === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (resolvedCommand === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (resolvedCommand === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (resolvedCommand === "prompt.commitAndPush") {
        event.preventDefault();
        event.stopPropagation();
        void sendCommitAndPushPrompt();
        return;
      }

      if (resolvedCommand === "prompt.createPullRequest") {
        event.preventDefault();
        event.stopPropagation();
        void sendCreatePullRequestMessage();
        return;
      }

      const scriptId = projectScriptIdFromCommand(resolvedCommand);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeProject,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    keybindings,
    runProjectScript,
    sendCommitAndPushPrompt,
    sendCreatePullRequestMessage,
    setTerminalOpen,
    splitTerminal,
    terminalState.activeTerminalId,
    terminalState.terminalOpen,
  ]);

  return (
    <div className="worktree-thread-dock flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            {worktreeHeaderLabel ? (
              <div className="flex min-w-0 shrink items-center gap-1.5 text-sm font-medium text-foreground/90">
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 shrink truncate" title={worktreeHeaderLabel}>
                  {worktreeHeaderLabel}
                </span>
              </div>
            ) : null}
            {activeProject?.name && !isGitRepo ? (
              <span className="shrink-0 text-[10px] font-medium text-amber-700">No Git</span>
            ) : null}
          </div>
          <div className="@container/header-actions flex min-w-0 flex-1 items-center justify-end gap-2 @sm/header-actions:gap-3">
            {activeProject?.scripts ? (
              <ProjectScriptsControl
                scripts={activeProject.scripts}
                keybindings={keybindings}
                preferredScriptId={
                  activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
                }
                onRunScript={(script) => {
                  void runProjectScript(script);
                }}
                onAddScript={saveProjectScript}
                onUpdateScript={updateProjectScript}
                onDeleteScript={deleteProjectScript}
              />
            ) : null}
            {activeProject?.name ? (
              <OpenInPicker
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={gitCwd}
              />
            ) : null}
            {activeProject?.name ? (
              <GitActionsControl
                gitCwd={gitCwd}
                activeThreadId={activeThreadId}
                defaultPullRequestBaseBranch={activeProject?.defaultPullRequestBaseBranch ?? null}
              />
            ) : null}
            {activeProject?.name ? (
              <Button
                size="sm"
                variant={rightRailState.open ? "secondary" : "outline"}
                onClick={() => {
                  setRightRailState({ open: !rightRailState.open });
                }}
              >
                {rightRailState.open ? "Hide sidebar" : "Show sidebar"}
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <DockviewReact
                  className="h-full w-full"
                  components={dockComponents}
                  defaultRenderer="always"
                  defaultTabComponent={DockWorkspaceTab}
                  disableFloatingGroups
                  leftHeaderActionsComponent={leftHeaderActionsComponent}
                  rightHeaderActionsComponent={rightHeaderActionsComponent}
                  scrollbars="native"
                  theme={resolvedTheme === "dark" ? themeDark : themeLight}
                  onReady={(event: DockviewReadyEvent) => {
                    setDockviewApi(event.api);
                  }}
                />
              </div>

              {terminalState.terminalOpen && activeProject ? (
                <ThreadTerminalDrawer
                  key={worktreeId}
                  threadId={worktreeTerminalOwnerId}
                  cwd={gitCwd ?? activeProject.cwd}
                  runtimeEnv={threadTerminalRuntimeEnv}
                  height={terminalState.terminalHeight}
                  terminalIds={terminalState.terminalIds}
                  activeTerminalId={terminalState.activeTerminalId}
                  terminalGroups={terminalState.terminalGroups}
                  activeTerminalGroupId={terminalState.activeTerminalGroupId}
                  focusRequestId={terminalFocusRequestId}
                  onSplitTerminal={splitTerminal}
                  onNewTerminal={createNewTerminal}
                  splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
                  newShortcutLabel={newTerminalShortcutLabel ?? undefined}
                  closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
                  onActiveTerminalChange={activateTerminal}
                  onCloseTerminal={closeTerminal}
                  onHeightChange={setTerminalHeight}
                />
              ) : null}
            </div>
          </div>

          {!isMobile && rightRailState.open ? (
            <>
              <div
                aria-hidden="true"
                className="w-1 shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-border"
                onPointerDown={handleRightRailResizePointerDown}
                onPointerMove={handleRightRailResizePointerMove}
                onPointerUp={handleRightRailResizePointerUp}
                onPointerCancel={handleRightRailResizePointerUp}
              />
              <div
                className="min-h-0 shrink-0 overflow-hidden"
                style={{ width: `${rightRailWidth}px` }}
              >
                <WorktreeRightRail
                  worktreeId={worktreeId}
                  cwd={gitCwd}
                  projectId={focusedProject?.id ?? null}
                  projectModel={focusedProject?.model ?? null}
                  defaultPullRequestBaseBranch={
                    focusedProject?.defaultPullRequestBaseBranch ?? null
                  }
                  pullRequestPromptTemplate={focusedProject?.pullRequestPromptTemplate ?? null}
                  focusedThreadId={focusedThread?.threadId ?? null}
                  focusedThreadIsServer={focusedThread?.isServerThread ?? false}
                  railState={rightRailState}
                  setRailState={setRightRailState}
                  onOpenFile={(relativePath) => openWorkspaceFile(relativePath, "file")}
                  onOpenDiff={(relativePath) => openWorkspaceFile(relativePath, "diff")}
                  onClose={() => setRightRailState({ open: false })}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>

      {isMobile ? (
        <Sheet
          open={rightRailState.open}
          onOpenChange={(open) => {
            setRightRailState({ open });
          }}
        >
          <SheetContent
            side="right"
            showCloseButton={false}
            className="w-[min(92vw,420px)] max-w-[420px] p-0"
          >
            <SheetTitle className="sr-only">Worktree sidebar</SheetTitle>
            <div className="h-full min-h-0">
              <WorktreeRightRail
                worktreeId={worktreeId}
                cwd={gitCwd}
                projectId={focusedProject?.id ?? null}
                projectModel={focusedProject?.model ?? null}
                defaultPullRequestBaseBranch={focusedProject?.defaultPullRequestBaseBranch ?? null}
                pullRequestPromptTemplate={focusedProject?.pullRequestPromptTemplate ?? null}
                focusedThreadId={focusedThread?.threadId ?? null}
                focusedThreadIsServer={focusedThread?.isServerThread ?? false}
                railState={rightRailState}
                setRailState={setRightRailState}
                onOpenFile={(relativePath) => openWorkspaceFile(relativePath, "file")}
                onOpenDiff={(relativePath) => openWorkspaceFile(relativePath, "diff")}
                onClose={() => setRightRailState({ open: false })}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

      {!activeThread && (
        <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground/70">
          <div className="flex items-center gap-2">
            <ChevronRightIcon className="size-4" />
            <span>Select a thread to get started.</span>
          </div>
        </div>
      )}
    </div>
  );
}
