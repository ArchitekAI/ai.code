import type { ThreadId, WorktreeId } from "@repo/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SerializedDockview } from "dockview";
import type { GroupviewPanelState } from "dockview";

export const WORKTREE_CHAT_LAYOUT_STORAGE_KEY = "t3code:worktree-chat-layouts:v1";
const DEFAULT_RIGHT_RAIL_WIDTH = 336;

export type WorktreeRightRailTab = "all-files" | "changes" | "checks";
export type WorktreeExplorerViewMode = "tree" | "list";

export interface WorktreeRightRailState {
  open: boolean;
  width: number;
  activeTab: WorktreeRightRailTab;
  allFilesViewMode: WorktreeExplorerViewMode;
  changesViewMode: WorktreeExplorerViewMode;
  allFilesExpandedPaths: string[] | null;
  changesExpandedPaths: string[] | null;
}

export interface WorktreeDockThreadPanelParams {
  kind: "thread";
  threadId: ThreadId;
  worktreeId: WorktreeId;
  title?: string;
}

export interface WorktreeDockFilePanelParams {
  kind: "file";
  worktreeId: WorktreeId;
  relativePath: string;
  title?: string;
}

export interface WorktreeDockDiffPanelParams {
  kind: "diff";
  worktreeId: WorktreeId;
  relativePath: string;
  title?: string;
}

export type WorktreeDockPanelParams =
  | WorktreeDockThreadPanelParams
  | WorktreeDockFilePanelParams
  | WorktreeDockDiffPanelParams;

interface WorktreeChatLayoutStoreState {
  layoutsByWorktreeId: Partial<Record<WorktreeId, SerializedDockview>>;
  rightRailStateByWorktreeId: Partial<Record<WorktreeId, WorktreeRightRailState>>;
  setLayout: (worktreeId: WorktreeId, layout: SerializedDockview) => void;
  clearLayout: (worktreeId: WorktreeId) => void;
  setRightRailState: (
    worktreeId: WorktreeId,
    updater:
      | Partial<WorktreeRightRailState>
      | ((state: WorktreeRightRailState) => Partial<WorktreeRightRailState>),
  ) => void;
  clearRightRailState: (worktreeId: WorktreeId) => void;
}

export function createDefaultWorktreeRightRailState(): WorktreeRightRailState {
  return {
    open: true,
    width: DEFAULT_RIGHT_RAIL_WIDTH,
    activeTab: "checks",
    allFilesViewMode: "tree",
    changesViewMode: "tree",
    allFilesExpandedPaths: null,
    changesExpandedPaths: null,
  };
}

export function buildFileDockPanelId(relativePath: string): string {
  return `file::${relativePath}`;
}

export function buildDiffDockPanelId(relativePath: string): string {
  return `diff::${relativePath}`;
}

export function selectWorktreeRightRailState(
  stateByWorktreeId: Partial<Record<WorktreeId, WorktreeRightRailState>>,
  worktreeId: WorktreeId,
): WorktreeRightRailState {
  return stateByWorktreeId[worktreeId] ?? createDefaultWorktreeRightRailState();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeDockPanelParams(
  value: unknown,
  validThreadIds: ReadonlySet<ThreadId>,
  worktreeId: WorktreeId,
): WorktreeDockPanelParams | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind =
    value.kind === "thread" || value.kind === "file" || value.kind === "diff"
      ? value.kind
      : typeof value.threadId === "string"
        ? "thread"
        : null;
  const storedWorktreeId = value.worktreeId;
  const title = value.title;
  if (storedWorktreeId !== worktreeId) {
    return null;
  }

  if (kind === "thread") {
    const threadId = value.threadId;
    if (
      typeof threadId !== "string" ||
      threadId.length === 0 ||
      !validThreadIds.has(threadId as ThreadId)
    ) {
      return null;
    }

    return {
      kind,
      threadId: threadId as ThreadId,
      worktreeId,
      ...(typeof title === "string" && title.length > 0 ? { title } : {}),
    };
  }

  if (kind === "file" || kind === "diff") {
    const relativePath = value.relativePath;
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      return null;
    }

    return {
      kind,
      worktreeId,
      relativePath,
      ...(typeof title === "string" && title.length > 0 ? { title } : {}),
    };
  }

  return null;
}

function sanitizeSerializedGroupState(
  value: unknown,
  validPanelIds: ReadonlySet<string>,
): ({ activeView?: string; id: string; views: string[] } & Record<string, unknown>) | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  const views = Array.isArray(value.views)
    ? value.views.filter(
        (entry): entry is string => typeof entry === "string" && validPanelIds.has(entry),
      )
    : [];
  if (typeof id !== "string" || id.length === 0 || views.length === 0) {
    return null;
  }

  const activeView =
    typeof value.activeView === "string" && views.includes(value.activeView)
      ? value.activeView
      : (views[0] ?? undefined);

  return {
    ...value,
    id,
    views,
    ...(activeView ? { activeView } : {}),
  };
}

function sanitizeSerializedGridNode(
  value: unknown,
  validPanelIds: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.type === "leaf") {
    const data = sanitizeSerializedGroupState(value.data, validPanelIds);
    if (!data) {
      return null;
    }
    return {
      ...value,
      type: "leaf",
      data,
    };
  }

  if (value.type === "branch") {
    const children = Array.isArray(value.data)
      ? value.data
          .map((entry) => sanitizeSerializedGridNode(entry, validPanelIds))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
      : [];
    if (children.length === 0) {
      return null;
    }
    return {
      ...value,
      type: "branch",
      data: children,
    };
  }

  return null;
}

export function sanitizeSerializedDockviewLayout(options: {
  layout: SerializedDockview;
  validThreadIds: ReadonlySet<ThreadId>;
  worktreeId: WorktreeId;
}): SerializedDockview | null {
  const nextPanels: Record<string, GroupviewPanelState> = {};
  for (const [panelId, panelState] of Object.entries(options.layout.panels)) {
    if (typeof panelId !== "string" || panelId.length === 0) {
      continue;
    }
    const params = sanitizeDockPanelParams(
      panelState.params,
      options.validThreadIds,
      options.worktreeId,
    );
    if (!params) {
      continue;
    }
    nextPanels[panelId] = {
      ...panelState,
      params,
    };
  }

  const validPanelIds = new Set(Object.keys(nextPanels));
  if (validPanelIds.size === 0) {
    return null;
  }

  const root = sanitizeSerializedGridNode(options.layout.grid?.root, validPanelIds);
  if (!root) {
    return null;
  }

  const activeGroup =
    typeof options.layout.activeGroup === "string" && options.layout.activeGroup.length > 0
      ? options.layout.activeGroup
      : undefined;

  return {
    grid: {
      ...options.layout.grid,
      root: root as unknown as SerializedDockview["grid"]["root"],
    },
    panels: nextPanels,
    ...(activeGroup ? { activeGroup } : {}),
  };
}

export const useWorktreeChatLayoutStore = create<WorktreeChatLayoutStoreState>()(
  persist(
    (set) => ({
      layoutsByWorktreeId: {},
      rightRailStateByWorktreeId: {},
      setLayout: (worktreeId, layout) =>
        set((state) => ({
          layoutsByWorktreeId: {
            ...state.layoutsByWorktreeId,
            [worktreeId]: layout,
          },
        })),
      clearLayout: (worktreeId) =>
        set((state) => {
          if (!state.layoutsByWorktreeId[worktreeId]) {
            return state;
          }
          const next = { ...state.layoutsByWorktreeId };
          delete next[worktreeId];
          return { layoutsByWorktreeId: next };
        }),
      setRightRailState: (worktreeId, updater) =>
        set((state) => {
          const current = selectWorktreeRightRailState(
            state.rightRailStateByWorktreeId,
            worktreeId,
          );
          const patch = typeof updater === "function" ? updater(current) : updater;
          const nextValue: WorktreeRightRailState = {
            ...current,
            ...patch,
          };
          return {
            rightRailStateByWorktreeId: {
              ...state.rightRailStateByWorktreeId,
              [worktreeId]: nextValue,
            },
          };
        }),
      clearRightRailState: (worktreeId) =>
        set((state) => {
          if (!state.rightRailStateByWorktreeId[worktreeId]) {
            return state;
          }
          const next = { ...state.rightRailStateByWorktreeId };
          delete next[worktreeId];
          return { rightRailStateByWorktreeId: next };
        }),
    }),
    {
      name: WORKTREE_CHAT_LAYOUT_STORAGE_KEY,
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        layoutsByWorktreeId: state.layoutsByWorktreeId,
        rightRailStateByWorktreeId: state.rightRailStateByWorktreeId,
      }),
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== "object") {
          return {
            layoutsByWorktreeId: {},
            rightRailStateByWorktreeId: {},
          } satisfies Partial<WorktreeChatLayoutStoreState>;
        }

        const value = persistedState as Partial<WorktreeChatLayoutStoreState>;
        return {
          layoutsByWorktreeId: value.layoutsByWorktreeId ?? {},
          rightRailStateByWorktreeId: value.rightRailStateByWorktreeId ?? {},
        } satisfies Partial<WorktreeChatLayoutStoreState>;
      },
    },
  ),
);
