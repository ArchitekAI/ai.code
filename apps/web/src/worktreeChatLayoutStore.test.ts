import type { ThreadId, WorktreeId } from "@repo/contracts";
import type { SerializedDockview } from "dockview";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKTREE_ID = "worktree-1" as WorktreeId;
const OTHER_WORKTREE_ID = "worktree-2" as WorktreeId;
const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;
const THREAD_C = "thread-c" as ThreadId;

type WorktreeChatLayoutStoreModule = typeof import("./worktreeChatLayoutStore");

let worktreeChatLayoutStoreModule: WorktreeChatLayoutStoreModule;

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function createLayout(): SerializedDockview {
  return {
    grid: {
      root: {
        type: "leaf",
        size: 1,
        data: {
          id: "group-1",
          views: [THREAD_A, THREAD_B],
          activeView: THREAD_A,
        },
      },
      height: 800,
      width: 1200,
      orientation: "horizontal" as SerializedDockview["grid"]["orientation"],
    },
    panels: {
      [THREAD_A]: {
        id: THREAD_A,
        contentComponent: "thread-chat",
        title: "Thread A",
        params: {
          kind: "thread",
          threadId: THREAD_A,
          worktreeId: WORKTREE_ID,
          title: "Thread A",
        },
      },
      [THREAD_B]: {
        id: THREAD_B,
        contentComponent: "thread-chat",
        title: "Thread B",
        params: {
          kind: "thread",
          threadId: THREAD_B,
          worktreeId: WORKTREE_ID,
          title: "Thread B",
        },
      },
    },
    activeGroup: "group-1",
  } as SerializedDockview;
}

describe("worktreeChatLayoutStore", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", createMemoryStorage());
    worktreeChatLayoutStoreModule = await import("./worktreeChatLayoutStore");
    worktreeChatLayoutStoreModule.useWorktreeChatLayoutStore.setState({
      layoutsByWorktreeId: {},
      rightRailStateByWorktreeId: {},
    });
  });

  it("stores layouts by worktree id", () => {
    const layout = createLayout();

    worktreeChatLayoutStoreModule.useWorktreeChatLayoutStore
      .getState()
      .setLayout(WORKTREE_ID, layout);

    expect(
      worktreeChatLayoutStoreModule.useWorktreeChatLayoutStore.getState().layoutsByWorktreeId[
        WORKTREE_ID
      ],
    ).toEqual(layout);
  });

  it("falls back to an empty state when persisted JSON is invalid", async () => {
    localStorage.setItem(worktreeChatLayoutStoreModule.WORKTREE_CHAT_LAYOUT_STORAGE_KEY, "{");

    vi.resetModules();
    const { useWorktreeChatLayoutStore: rehydratedStore } =
      await import("./worktreeChatLayoutStore");

    expect(rehydratedStore.getState().layoutsByWorktreeId).toEqual({});
  });

  it("sanitizes missing or deleted panel ids from a restored layout", () => {
    const sanitized = worktreeChatLayoutStoreModule.sanitizeSerializedDockviewLayout({
      layout: createLayout(),
      validThreadIds: new Set([THREAD_A]),
      worktreeId: WORKTREE_ID,
    });

    expect(sanitized).not.toBeNull();
    expect(Object.keys(sanitized?.panels ?? {})).toEqual([THREAD_A]);
    expect(sanitized?.grid.root).toEqual({
      type: "leaf",
      size: 1,
      data: {
        id: "group-1",
        views: [THREAD_A],
        activeView: THREAD_A,
      },
    });
  });

  it("drops layouts whose panels belong to another worktree", () => {
    const layout = createLayout();
    const threadAPanel = layout.panels[THREAD_A]!;
    layout.panels[THREAD_A] = {
      ...threadAPanel,
      params: {
        kind: "thread",
        threadId: THREAD_A,
        worktreeId: OTHER_WORKTREE_ID,
      },
    } as typeof threadAPanel;

    const sanitized = worktreeChatLayoutStoreModule.sanitizeSerializedDockviewLayout({
      layout,
      validThreadIds: new Set([THREAD_A, THREAD_B, THREAD_C]),
      worktreeId: WORKTREE_ID,
    });

    expect(sanitized).not.toBeNull();
    expect(Object.keys(sanitized?.panels ?? {})).toEqual([THREAD_B]);
  });

  it("provides a default right-rail state per worktree", () => {
    const rightRailState = worktreeChatLayoutStoreModule.selectWorktreeRightRailState(
      {},
      WORKTREE_ID,
    );

    expect(rightRailState).toEqual({
      open: true,
      width: 336,
      activeTab: "checks",
      allFilesViewMode: "tree",
      changesViewMode: "tree",
      allFilesExpandedPaths: null,
      changesExpandedPaths: null,
    });
  });

  it("stores right-rail state by worktree id", () => {
    worktreeChatLayoutStoreModule.useWorktreeChatLayoutStore
      .getState()
      .setRightRailState(WORKTREE_ID, {
        open: false,
        width: 420,
        activeTab: "checks",
      });

    expect(
      worktreeChatLayoutStoreModule.selectWorktreeRightRailState(
        worktreeChatLayoutStoreModule.useWorktreeChatLayoutStore.getState()
          .rightRailStateByWorktreeId,
        WORKTREE_ID,
      ),
    ).toMatchObject({
      open: false,
      width: 420,
      activeTab: "checks",
      allFilesViewMode: "tree",
      changesViewMode: "tree",
    });
  });

  it("preserves file and diff panels for the same worktree", () => {
    const layout = createLayout();
    layout.panels["file::src/app.ts"] = {
      id: "file::src/app.ts",
      contentComponent: "workspace-file",
      title: "app.ts",
      params: {
        kind: "file",
        worktreeId: WORKTREE_ID,
        relativePath: "src/app.ts",
        title: "app.ts",
      },
    };
    layout.panels["diff::src/app.ts"] = {
      id: "diff::src/app.ts",
      contentComponent: "workspace-diff",
      title: "app.ts",
      params: {
        kind: "diff",
        worktreeId: WORKTREE_ID,
        relativePath: "src/app.ts",
        title: "app.ts",
      },
    };
    layout.grid.root = {
      type: "leaf",
      size: 1,
      data: {
        id: "group-1",
        views: [THREAD_A, "file::src/app.ts", "diff::src/app.ts"],
        activeView: "file::src/app.ts",
      },
    } as SerializedDockview["grid"]["root"];

    const sanitized = worktreeChatLayoutStoreModule.sanitizeSerializedDockviewLayout({
      layout,
      validThreadIds: new Set([THREAD_A]),
      worktreeId: WORKTREE_ID,
    });

    expect(Object.keys(sanitized?.panels ?? {}).toSorted()).toEqual([
      "diff::src/app.ts",
      "file::src/app.ts",
      THREAD_A,
    ]);
  });
});
