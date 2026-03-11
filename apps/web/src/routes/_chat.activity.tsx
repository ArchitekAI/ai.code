import { ChevronRightIcon, HistoryIcon, SearchIcon } from "lucide-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ThreadId, WorktreeId } from "@repo/contracts";

import { isElectron } from "../env";
import { SidebarTrigger, SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { useStore } from "../store";
import { useComposerDraftStore } from "../composerDraftStore";
import { gitUnarchiveWorktreeMutationOptions } from "../lib/gitReactQuery";
import { ensureWorktreeDraftThread } from "../lib/worktreeDraftThread";
import { worktreeDisplaySubtitle, worktreeDisplayTitle } from "../lib/worktrees";
import { readNativeApi } from "../nativeApi";
import { newCommandId } from "../lib/utils";

function maxTimestamp(values: ReadonlyArray<string | null | undefined>): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > max) {
      max = parsed;
    }
  }
  return Number.isFinite(max) ? max : 0;
}

function formatActivityDate(input: string | null): string {
  if (!input) {
    return "";
  }
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function relativeDayLabel(timestamp: number, now = Date.now()): string {
  const diffDays = Math.max(
    0,
    Math.floor((startOfLocalDay(now) - startOfLocalDay(timestamp)) / (24 * 60 * 60 * 1000)),
  );
  if (diffDays === 0) {
    return "Today";
  }
  if (diffDays === 1) {
    return "Yesterday";
  }
  return `${diffDays} days ago`;
}

function ActivityRouteView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const projects = useStore((store) => store.projects);
  const worktrees = useStore((store) => store.worktrees);
  const archivedWorktrees = useStore((store) => store.archivedWorktrees);
  const threads = useStore((store) => store.threads);
  const archivedThreads = useStore((store) => store.archivedThreads);
  const getDraftThreadByWorktreeId = useComposerDraftStore(
    (store) => store.getDraftThreadByWorktreeId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setWorktreeDraftThreadId = useComposerDraftStore((store) => store.setWorktreeDraftThreadId);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const unarchiveWorktreeMutation = useMutation(
    gitUnarchiveWorktreeMutationOptions({ queryClient }),
  );
  const [pendingWorktreeId, setPendingWorktreeId] = useState<WorktreeId | null>(null);
  const [filterQuery, setFilterQuery] = useState("");

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const allWorktrees = useMemo(
    () => [...worktrees, ...archivedWorktrees],
    [archivedWorktrees, worktrees],
  );
  const allThreads = useMemo(() => [...threads, ...archivedThreads], [archivedThreads, threads]);

  const latestServerThreadByWorktreeId = useMemo(() => {
    const next = new Map<WorktreeId, (typeof allThreads)[number]>();
    for (const thread of allThreads) {
      const existing = next.get(thread.worktreeId!);
      if (!existing) {
        next.set(thread.worktreeId!, thread);
        continue;
      }
      const currentTimestamp = maxTimestamp([
        existing.latestTurn?.completedAt,
        existing.latestTurn?.requestedAt,
        existing.createdAt,
      ]);
      const nextTimestamp = maxTimestamp([
        thread.latestTurn?.completedAt,
        thread.latestTurn?.requestedAt,
        thread.createdAt,
      ]);
      if (
        nextTimestamp > currentTimestamp ||
        (nextTimestamp === currentTimestamp && thread.id.localeCompare(existing.id) > 0)
      ) {
        next.set(thread.worktreeId!, thread);
      }
    }
    return next;
  }, [allThreads]);

  const latestDraftThreadByWorktreeId = useMemo(() => {
    const next = new Map<WorktreeId, { threadId: ThreadId; createdAt: string }>();
    for (const [draftThreadId, draftThread] of Object.entries(draftThreadsByThreadId)) {
      if (!draftThread.worktreeId) {
        continue;
      }
      const existing = next.get(draftThread.worktreeId);
      if (
        !existing ||
        Date.parse(draftThread.createdAt) > Date.parse(existing.createdAt) ||
        (draftThread.createdAt === existing.createdAt &&
          draftThreadId.localeCompare(existing.threadId) > 0)
      ) {
        next.set(draftThread.worktreeId, {
          threadId: draftThreadId as ThreadId,
          createdAt: draftThread.createdAt,
        });
      }
    }
    return next;
  }, [draftThreadsByThreadId]);

  const openWorktree = useCallback(
    async (worktree: (typeof allWorktrees)[number]) => {
      const latestServerThread = latestServerThreadByWorktreeId.get(worktree.id) ?? null;
      const latestDraftThread = latestDraftThreadByWorktreeId.get(worktree.id) ?? null;
      const threadId =
        latestServerThread &&
        latestDraftThread &&
        Date.parse(latestDraftThread.createdAt) > Date.parse(latestServerThread.createdAt)
          ? latestDraftThread.threadId
          : latestDraftThread && !latestServerThread
            ? latestDraftThread.threadId
            : (latestServerThread?.id ?? null);

      if (threadId) {
        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
        return;
      }

      const draftThreadId = ensureWorktreeDraftThread({
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        branch: worktree.branch,
        worktreePath: worktree.isRoot ? null : worktree.workspacePath,
        envMode: worktree.isRoot ? "local" : "worktree",
        getDraftThreadByWorktreeId,
        getDraftThread,
        setDraftThreadContext,
        setWorktreeDraftThreadId,
      });
      await navigate({
        to: "/$threadId",
        params: { threadId: draftThreadId },
      });
    },
    [
      getDraftThread,
      getDraftThreadByWorktreeId,
      latestDraftThreadByWorktreeId,
      latestServerThreadByWorktreeId,
      navigate,
      setDraftThreadContext,
      setWorktreeDraftThreadId,
    ],
  );

  const handleOpenWorktree = useCallback(
    async (worktreeId: WorktreeId) => {
      const worktree = allWorktrees.find((entry) => entry.id === worktreeId);
      if (!worktree) {
        return;
      }

      if (worktree.isRoot || worktree.archivedAt == null) {
        await openWorktree(worktree);
        return;
      }

      const api = readNativeApi();
      if (!api) {
        return;
      }
      const project = projectById.get(worktree.projectId);
      if (!project) {
        return;
      }

      setPendingWorktreeId(worktree.id);
      try {
        const result = await unarchiveWorktreeMutation.mutateAsync({
          cwd: project.cwd,
          worktreeId: worktree.id,
        });
        await api.orchestration.dispatchCommand({
          type: "worktree.unarchive",
          commandId: newCommandId(),
          worktreeId: worktree.id,
        });
        const snapshot = await api.orchestration.getSnapshot();
        syncServerReadModel(snapshot);
        if (result.warning) {
          toastManager.add({
            type: "warning",
            title: "Worktree restored with conflicts",
            description: result.warning,
          });
        }
        await openWorktree({
          ...worktree,
          archivedAt: null,
          branch: result.worktree.branch,
          workspacePath: result.worktree.path,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to restore worktree",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      } finally {
        setPendingWorktreeId((current) => (current === worktree.id ? null : current));
      }
    },
    [allWorktrees, openWorktree, projectById, syncServerReadModel, unarchiveWorktreeMutation],
  );

  const orderedWorktrees = useMemo(
    () =>
      [...allWorktrees].toSorted((left, right) => {
        const leftLatestThread = latestServerThreadByWorktreeId.get(left.id) ?? null;
        const rightLatestThread = latestServerThreadByWorktreeId.get(right.id) ?? null;
        const leftLatestDraft = latestDraftThreadByWorktreeId.get(left.id) ?? null;
        const rightLatestDraft = latestDraftThreadByWorktreeId.get(right.id) ?? null;
        const leftTimestamp = maxTimestamp([
          left.archivedAt,
          left.updatedAt,
          leftLatestThread?.latestTurn?.completedAt,
          leftLatestThread?.latestTurn?.requestedAt,
          leftLatestThread?.createdAt,
          leftLatestDraft?.createdAt,
        ]);
        const rightTimestamp = maxTimestamp([
          right.archivedAt,
          right.updatedAt,
          rightLatestThread?.latestTurn?.completedAt,
          rightLatestThread?.latestTurn?.requestedAt,
          rightLatestThread?.createdAt,
          rightLatestDraft?.createdAt,
        ]);
        if (rightTimestamp !== leftTimestamp) {
          return rightTimestamp - leftTimestamp;
        }
        return right.id.localeCompare(left.id);
      }),
    [allWorktrees, latestDraftThreadByWorktreeId, latestServerThreadByWorktreeId],
  );
  const filteredSections = useMemo(() => {
    const normalizedQuery = filterQuery.trim().toLowerCase();
    const rows = orderedWorktrees.flatMap((worktree) => {
      const project = projectById.get(worktree.projectId);
      if (!project) {
        return [];
      }
      const latestServerThread = latestServerThreadByWorktreeId.get(worktree.id) ?? null;
      const latestDraftThread = latestDraftThreadByWorktreeId.get(worktree.id) ?? null;
      const latestLabel =
        latestServerThread?.title ??
        (latestDraftThread
          ? "Draft thread"
          : worktree.isRoot
            ? "Local workspace"
            : "No threads yet");
      const subtitle = worktreeDisplaySubtitle(worktree, project);
      const worktreeLabel = worktreeDisplayTitle(worktree);
      const activityTimestamp = maxTimestamp([
        worktree.archivedAt,
        worktree.updatedAt,
        latestServerThread?.latestTurn?.completedAt,
        latestServerThread?.latestTurn?.requestedAt,
        latestServerThread?.createdAt,
        latestDraftThread?.createdAt,
      ]);
      const searchText = [project.name, worktreeLabel, subtitle, latestLabel, worktree.branch]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" ")
        .toLowerCase();
      if (normalizedQuery.length > 0 && !searchText.includes(normalizedQuery)) {
        return [];
      }
      return [
        {
          worktree,
          project,
          latestLabel,
          subtitle,
          worktreeLabel,
          activityTimestamp,
          activityDate: formatActivityDate(new Date(activityTimestamp).toISOString()),
        },
      ];
    });

    const sections = new Map<string, Array<(typeof rows)[number]>>();
    for (const row of rows) {
      const label = relativeDayLabel(row.activityTimestamp);
      const existing = sections.get(label);
      if (existing) {
        existing.push(row);
      } else {
        sections.set(label, [row]);
      }
    }
    return Array.from(sections.entries()).map(([label, items]) => ({
      label,
      items,
    }));
  }, [
    filterQuery,
    latestDraftThreadByWorktreeId,
    latestServerThreadByWorktreeId,
    orderedWorktrees,
    projectById,
  ]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">Activity</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-5">
          <HistoryIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Activity</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <div className="flex h-11 items-center rounded-xl border border-border/70 bg-card/40 px-4 shadow-xs">
            <SearchIcon className="mr-3 size-4 shrink-0 text-muted-foreground/60" />
            <input
              value={filterQuery}
              onChange={(event) => {
                setFilterQuery(event.target.value);
              }}
              placeholder="Filter workspaces..."
              className="h-full min-w-0 flex-1 bg-transparent text-sm leading-none text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>

          {filteredSections.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
              No worktrees match that filter.
            </div>
          ) : null}

          {filteredSections.map((section) => (
            <section key={section.label} className="flex flex-col gap-2">
              <div className="text-sm font-medium text-muted-foreground">
                {section.label} {section.items.length}
              </div>

              <div className="flex flex-col gap-1">
                {section.items.map((row) => {
                  const isPending = pendingWorktreeId === row.worktree.id;
                  return (
                    <button
                      key={row.worktree.id}
                      type="button"
                      className="flex w-full items-center gap-4 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent/30 disabled:cursor-wait disabled:opacity-70"
                      onClick={() => {
                        void handleOpenWorktree(row.worktree.id);
                      }}
                      disabled={isPending}
                    >
                      <div className="min-w-0 w-32 shrink-0 text-sm text-muted-foreground">
                        <div className="truncate">{row.project.name}</div>
                      </div>

                      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
                        <span className="truncate text-foreground">{row.worktreeLabel}</span>
                        <span className="truncate text-muted-foreground">· {row.latestLabel}</span>
                        {row.subtitle ? (
                          <span className="truncate text-muted-foreground/70">
                            · {row.subtitle}
                          </span>
                        ) : null}
                      </div>

                      <div className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                        {isPending
                          ? "Unarchiving..."
                          : !row.worktree.isRoot && row.worktree.archivedAt != null
                            ? "Unarchive"
                            : row.activityDate}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/activity")({
  component: ActivityRouteView,
});
