import type { Thread } from "../types";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  findLatestProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";

export type ThreadStatusKind =
  | "pendingApproval"
  | "awaitingInput"
  | "working"
  | "connecting"
  | "planReady"
  | "completed";

export interface ThreadStatusVisual {
  kind: ThreadStatusKind;
  label:
    | "Pending Approval"
    | "Awaiting Input"
    | "Working"
    | "Connecting"
    | "Plan Ready"
    | "Completed";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

export type ThreadStatusSnapshot = Pick<
  Thread,
  "interactionMode" | "latestTurn" | "lastVisitedAt" | "proposedPlans" | "session" | "activities"
>;

const THREAD_STATUS_PRIORITY: readonly ThreadStatusKind[] = [
  "pendingApproval",
  "awaitingInput",
  "working",
  "connecting",
  "planReady",
  "completed",
];

const THREAD_STATUS_VISUALS = {
  pendingApproval: {
    label: "Pending Approval",
    colorClass: "text-amber-600 dark:text-amber-300/90",
    dotClass: "bg-amber-500 dark:bg-amber-300/90",
    pulse: false,
  },
  awaitingInput: {
    label: "Awaiting Input",
    colorClass: "text-indigo-600 dark:text-indigo-300/90",
    dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
    pulse: false,
  },
  working: {
    label: "Working",
    colorClass: "text-sky-600 dark:text-sky-300/80",
    dotClass: "bg-sky-500 dark:bg-sky-300/80",
    pulse: true,
  },
  connecting: {
    label: "Connecting",
    colorClass: "text-sky-600 dark:text-sky-300/80",
    dotClass: "bg-sky-500 dark:bg-sky-300/80",
    pulse: true,
  },
  planReady: {
    label: "Plan Ready",
    colorClass: "text-violet-600 dark:text-violet-300/90",
    dotClass: "bg-violet-500 dark:bg-violet-300/90",
    pulse: false,
  },
  completed: {
    label: "Completed",
    colorClass: "text-emerald-600 dark:text-emerald-300/90",
    dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
    pulse: false,
  },
} as const satisfies Record<ThreadStatusKind, Omit<ThreadStatusVisual, "kind">>;

export function hasUnseenCompletion(
  thread: Pick<ThreadStatusSnapshot, "latestTurn" | "lastVisitedAt">,
): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function resolveThreadStatusKind(thread: ThreadStatusSnapshot): ThreadStatusKind | null {
  if (derivePendingApprovals(thread.activities).length > 0) {
    return "pendingApproval";
  }

  if (derivePendingUserInputs(thread.activities).length > 0) {
    return "awaitingInput";
  }

  if (thread.session?.status === "running") {
    return "working";
  }

  if (thread.session?.status === "connecting") {
    return "connecting";
  }

  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId ?? null) !== null;
  if (hasPlanReadyPrompt) {
    return "planReady";
  }

  if (hasUnseenCompletion(thread)) {
    return "completed";
  }

  return null;
}

export function getThreadStatusVisual(kind: ThreadStatusKind): ThreadStatusVisual {
  return {
    kind,
    ...THREAD_STATUS_VISUALS[kind],
  };
}

export function resolveThreadStatusVisual(thread: ThreadStatusSnapshot): ThreadStatusVisual | null {
  const kind = resolveThreadStatusKind(thread);
  return kind ? getThreadStatusVisual(kind) : null;
}

export function resolveWorktreeStatusKind(
  threads: ReadonlyArray<ThreadStatusSnapshot>,
): ThreadStatusKind | null {
  if (threads.length === 0) {
    return null;
  }

  const statuses = new Set(
    threads
      .map((thread) => resolveThreadStatusKind(thread))
      .filter((kind): kind is ThreadStatusKind => kind !== null),
  );

  for (const kind of THREAD_STATUS_PRIORITY) {
    if (statuses.has(kind)) {
      return kind;
    }
  }

  return null;
}
