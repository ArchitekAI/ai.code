import type { WorktreeId } from "@repo/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { mutationOptions, queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";

const WORKTREE_CHECKS_STALE_TIME_MS = 10_000;

export const worktreeChecksQueryKeys = {
  all: ["worktree-checks"] as const,
  detail: (cwd: string | null, worktreeId: WorktreeId | null) =>
    ["worktree-checks", "detail", cwd, worktreeId] as const,
};

export function invalidateWorktreeChecksQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: worktreeChecksQueryKeys.all });
}

export function worktreeChecksQueryOptions(input: {
  cwd: string | null;
  worktreeId: WorktreeId | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: worktreeChecksQueryKeys.detail(input.cwd, input.worktreeId),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.worktreeId) {
        throw new Error("Worktree checks are unavailable.");
      }
      return api.worktreeChecks.get({
        cwd: input.cwd,
        worktreeId: input.worktreeId,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.worktreeId !== null,
    staleTime: WORKTREE_CHECKS_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
}

export function worktreeChecksAddTodoMutationOptions(input: {
  worktreeId: WorktreeId | null;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["worktree-checks", "mutation", "add-todo", input.worktreeId] as const,
    mutationFn: async (text: string) => {
      const api = ensureNativeApi();
      if (!input.worktreeId) {
        throw new Error("Todo creation is unavailable.");
      }
      return api.worktreeChecks.addTodo({ worktreeId: input.worktreeId, text });
    },
    onSettled: async () => {
      await invalidateWorktreeChecksQueries(input.queryClient);
    },
  });
}

export function worktreeChecksUpdateTodoMutationOptions(input: {
  worktreeId: WorktreeId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["worktree-checks", "mutation", "update-todo", input.worktreeId] as const,
    mutationFn: async (payload: { todoId: string; text?: string; completed?: boolean }) => {
      const api = ensureNativeApi();
      if (!input.worktreeId) {
        throw new Error("Todo updates are unavailable.");
      }
      return api.worktreeChecks.updateTodo({
        worktreeId: input.worktreeId,
        todoId: payload.todoId,
        ...(payload.text !== undefined ? { text: payload.text } : {}),
        ...(payload.completed !== undefined ? { completed: payload.completed } : {}),
      });
    },
    onSettled: async () => {
      await invalidateWorktreeChecksQueries(input.queryClient);
    },
  });
}

export function worktreeChecksDeleteTodoMutationOptions(input: {
  worktreeId: WorktreeId | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["worktree-checks", "mutation", "delete-todo", input.worktreeId] as const,
    mutationFn: async (todoId: string) => {
      const api = ensureNativeApi();
      if (!input.worktreeId) {
        throw new Error("Todo deletion is unavailable.");
      }
      return api.worktreeChecks.deleteTodo({
        worktreeId: input.worktreeId,
        todoId,
      });
    },
    onSettled: async () => {
      await invalidateWorktreeChecksQueries(input.queryClient);
    },
  });
}

export function gitUpdatePullRequestMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: ["git", "mutation", "update-pull-request", input.cwd] as const,
    mutationFn: async (payload: { number: number; title: string; body: string }) => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Pull request updates are unavailable.");
      }
      return api.git.updatePullRequest({
        cwd: input.cwd,
        number: payload.number,
        title: payload.title,
        body: payload.body,
      });
    },
    onSettled: async () => {
      await invalidateWorktreeChecksQueries(input.queryClient);
    },
  });
}
