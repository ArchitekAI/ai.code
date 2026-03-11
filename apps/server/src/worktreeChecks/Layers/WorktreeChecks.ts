import { randomUUID } from "node:crypto";

import {
  type WorktreeChecksComment,
  type WorktreeChecksDeployment,
  type WorktreeChecksItem,
  type WorktreeChecksPullRequest,
  type WorktreeChecksState,
  type WorktreeChecksTodo,
} from "@repo/contracts";
import { Effect, Layer, Option } from "effect";

import { GitHubCli, type GitHubPullRequestDetails } from "../../git/Services/GitHubCli.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { WorktreeCheckTodoRepository } from "../../persistence/Services/WorktreeCheckTodos.ts";
import { WorktreeChecksError } from "../Errors.ts";
import { WorktreeChecks, type WorktreeChecksShape } from "../Services/WorktreeChecks.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function bodyPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 180) {
    return collapsed;
  }
  return `${collapsed.slice(0, 177).trimEnd()}...`;
}

function toStateRank(state: WorktreeChecksState): number {
  switch (state) {
    case "pending":
    case "in_progress":
      return 0;
    case "failure":
      return 1;
    case "cancelled":
      return 2;
    case "success":
      return 3;
    case "neutral":
    case "skipped":
      return 4;
    default:
      return 5;
  }
}

function normalizeCheckState(input: {
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}): WorktreeChecksState {
  const conclusion = input.conclusion?.toLowerCase().trim() ?? "";
  const status = input.status?.toLowerCase().trim() ?? "";
  const state = input.state?.toLowerCase().trim() ?? "";

  if (
    status === "in_progress" ||
    status === "queued" ||
    status === "waiting" ||
    state === "pending"
  ) {
    return status === "in_progress" ? "in_progress" : "pending";
  }
  if (state === "success" || conclusion === "success") return "success";
  if (state === "failure" || conclusion === "failure" || conclusion === "timed_out") {
    return "failure";
  }
  if (state === "error" || conclusion === "startup_failure" || conclusion === "action_required") {
    return "failure";
  }
  if (state === "pending") return "pending";
  if (state === "cancelled" || conclusion === "cancelled") return "cancelled";
  if (state === "skipped" || conclusion === "skipped") return "skipped";
  if (state === "neutral" || conclusion === "neutral") return "neutral";
  if (status === "completed") {
    return conclusion.length > 0 ? normalizeCheckState({ conclusion }) : "unknown";
  }
  return "unknown";
}

function toRuntimeSeconds(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

function extractNodes(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (Array.isArray(value.nodes)) return value.nodes;
  if (isRecord(value.contexts) && Array.isArray(value.contexts.nodes)) {
    return value.contexts.nodes;
  }
  return [];
}

function normalizeStatusChecks(statusCheckRollup: unknown): WorktreeChecksItem[] {
  const nodes = extractNodes(statusCheckRollup);
  const items: WorktreeChecksItem[] = [];

  for (const [index, node] of nodes.entries()) {
    if (!isRecord(node)) continue;
    const typename = asString(node.__typename) ?? "";
    if (typename === "CheckRun") {
      const name = asString(node.name);
      if (!name) continue;
      const workflowName = asString(node.workflowName);
      const label = workflowName && workflowName !== name ? `${workflowName} - ${name}` : name;
      const id = asString(node.id) ?? asString(node.databaseId) ?? `check-run-${index}-${label}`;
      items.push({
        id,
        label,
        source: workflowName ?? null,
        state: normalizeCheckState({
          status: asString(node.status),
          conclusion: asString(node.conclusion),
        }),
        runtimeSeconds: toRuntimeSeconds(asString(node.startedAt), asString(node.completedAt)),
        linkUrl: asString(node.detailsUrl) ?? asString(node.url),
        description: asString(node.title) ?? asString(node.summary),
      });
      continue;
    }

    const context = asString(node.context) ?? asString(node.name);
    if (!context) continue;
    const id = asString(node.id) ?? `status-context-${index}-${context}`;
    items.push({
      id,
      label: context,
      source: null,
      state: normalizeCheckState({ state: asString(node.state), status: asString(node.status) }),
      runtimeSeconds: null,
      linkUrl: asString(node.targetUrl) ?? asString(node.detailsUrl) ?? asString(node.url),
      description: asString(node.description),
    });
  }

  return items.toSorted(
    (left, right) =>
      toStateRank(left.state) - toStateRank(right.state) || left.label.localeCompare(right.label),
  );
}

function normalizeComments(
  commentsValue: unknown,
  reviewsValue: unknown,
): ReadonlyArray<WorktreeChecksComment> {
  const comments: WorktreeChecksComment[] = [];

  for (const node of extractNodes(commentsValue)) {
    if (!isRecord(node)) continue;
    const url = asString(node.url);
    const author = isRecord(node.author)
      ? (asString(node.author.login) ?? asString(node.author.name))
      : null;
    const createdAt = asString(node.createdAt);
    if (!url || !author || !createdAt) continue;
    const body = asString(node.body) ?? "";
    comments.push({
      id: asString(node.id) ?? url,
      kind: "comment",
      author,
      bodyPreview: bodyPreview(body),
      createdAt,
      url,
    });
  }

  for (const node of extractNodes(reviewsValue)) {
    if (!isRecord(node)) continue;
    const url = asString(node.url);
    const author = isRecord(node.author)
      ? (asString(node.author.login) ?? asString(node.author.name))
      : null;
    const createdAt = asString(node.submittedAt) ?? asString(node.createdAt);
    if (!url || !author || !createdAt) continue;
    const state = asString(node.state);
    const body = asString(node.body) ?? state ?? "";
    comments.push({
      id: asString(node.id) ?? url,
      kind: "review",
      author,
      bodyPreview: bodyPreview(body),
      createdAt,
      url,
    });
  }

  return comments.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function toPullRequest(details: GitHubPullRequestDetails): WorktreeChecksPullRequest {
  return {
    number: details.number,
    title: details.title,
    body: details.body,
    url: details.url,
    reviewUrl: `${details.url}/files`,
    baseBranch: details.baseRefName,
    headBranch: details.headRefName,
    state: details.state ?? "open",
    reviewDecision: details.reviewDecision ?? null,
    isDraft: details.isDraft,
  };
}

function normalizeDeploymentName(record: Record<string, unknown>): string {
  return (
    asString(record.original_environment) ??
    asString(record.environment) ??
    asString(record.description) ??
    `Deployment ${asString(record.id) ?? "unknown"}`
  );
}

function normalizeDeployment(
  deployment: unknown,
  latestStatus: unknown,
): WorktreeChecksDeployment | null {
  if (!isRecord(deployment)) return null;
  const id =
    asString(deployment.id) ??
    (typeof deployment.id === "number" ? String(deployment.id) : null) ??
    null;
  if (!id) return null;

  const statusRecord = isRecord(latestStatus) ? latestStatus : null;
  return {
    id,
    name: normalizeDeploymentName(deployment),
    environment: asString(deployment.environment) ?? asString(deployment.original_environment),
    state: normalizeCheckState({
      state: statusRecord ? asString(statusRecord.state) : null,
      status: statusRecord ? asString(statusRecord.state) : null,
    }),
    previewUrl:
      (statusRecord ? asString(statusRecord.environment_url) : null) ??
      (statusRecord ? asString(statusRecord.target_url) : null),
    detailsUrl:
      (statusRecord ? asString(statusRecord.log_url) : null) ??
      (statusRecord ? asString(statusRecord.target_url) : null),
    updatedAt:
      (statusRecord ? asString(statusRecord.updated_at) : null) ??
      asString(deployment.updated_at) ??
      asString(deployment.created_at),
  };
}

function worktreeChecksError(
  operation: string,
  detail: string,
  cause?: unknown,
): WorktreeChecksError {
  return new WorktreeChecksError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isPullRequestNotFoundError(error: { detail?: string }): boolean {
  return (error.detail ?? "").toLowerCase().includes("pull request not found");
}

const makeWorktreeChecks = Effect.gen(function* () {
  const gitManager = yield* GitManager;
  const gitHubCli = yield* GitHubCli;
  const todoRepository = yield* WorktreeCheckTodoRepository;

  const listTodosByWorktreeId: WorktreeChecksShape["listTodosByWorktreeId"] = (worktreeId) =>
    todoRepository.listByWorktreeId({ worktreeId });

  const fetchDeployments = (cwd: string, headRefOid: string | null) =>
    Effect.gen(function* () {
      if (!headRefOid) {
        return [] as WorktreeChecksDeployment[];
      }

      const deploymentsResponse = yield* gitHubCli.execute({
        cwd,
        args: [
          "api",
          "repos/{owner}/{repo}/deployments",
          "--method",
          "GET",
          "-f",
          `sha=${headRefOid}`,
          "-f",
          "per_page=10",
        ],
      });
      const parsed = yield* Effect.try({
        try: () => JSON.parse(deploymentsResponse.stdout) as unknown,
        catch: (cause) =>
          worktreeChecksError("getDeployments", "GitHub returned invalid deployment JSON.", cause),
      });
      if (!Array.isArray(parsed)) {
        return [] as WorktreeChecksDeployment[];
      }

      const normalized = yield* Effect.all(
        parsed.slice(0, 10).map((deployment) =>
          Effect.gen(function* () {
            if (!isRecord(deployment) || typeof deployment.id !== "number") {
              return null;
            }
            const statusesResponse = yield* gitHubCli.execute({
              cwd,
              args: [
                "api",
                `repos/{owner}/{repo}/deployments/${deployment.id}/statuses`,
                "--method",
                "GET",
                "-f",
                "per_page=10",
              ],
            });
            const parsedStatuses = yield* Effect.try({
              try: () => JSON.parse(statusesResponse.stdout) as unknown,
              catch: (cause) =>
                worktreeChecksError(
                  "getDeployments",
                  "GitHub returned invalid deployment status JSON.",
                  cause,
                ),
            });
            const latestStatus = Array.isArray(parsedStatuses) ? (parsedStatuses[0] ?? null) : null;
            return normalizeDeployment(deployment, latestStatus);
          }),
        ),
        { concurrency: 4 },
      );

      return normalized
        .filter((deployment): deployment is WorktreeChecksDeployment => deployment !== null)
        .toSorted(
          (left, right) =>
            (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
            left.name.localeCompare(right.name),
        );
    });

  const get: WorktreeChecksShape["get"] = (input) =>
    Effect.gen(function* () {
      const [gitStatus, todos] = yield* Effect.all([
        gitManager.status({ cwd: input.cwd }),
        todoRepository.listByWorktreeId({ worktreeId: input.worktreeId }),
      ]);

      let details: GitHubPullRequestDetails | null = null;
      let githubUnavailableReason: string | null = null;
      const detailReference =
        gitStatus.pr?.number !== undefined
          ? String(gitStatus.pr.number)
          : (gitStatus.branch ?? null);

      if (detailReference) {
        details = yield* gitHubCli
          .getPullRequestDetails({
            cwd: input.cwd,
            reference: detailReference,
          })
          .pipe(
            Effect.catchTag("GitHubCliError", (error) => {
              if (isPullRequestNotFoundError(error)) {
                return Effect.succeed(null);
              }
              githubUnavailableReason = error.detail;
              return Effect.succeed(null);
            }),
          );
      }

      const deployments =
        details !== null
          ? yield* fetchDeployments(input.cwd, details.headRefOid ?? null).pipe(
              Effect.catchTag("GitHubCliError", (error) => {
                githubUnavailableReason ??= error.detail;
                return Effect.succeed([] as WorktreeChecksDeployment[]);
              }),
              Effect.catchTag("WorktreeChecksError", () =>
                Effect.succeed([] as WorktreeChecksDeployment[]),
              ),
            )
          : [];

      return {
        gitStatus,
        pr: details ? toPullRequest(details) : null,
        deployments,
        checks: details ? normalizeStatusChecks(details.statusCheckRollup) : [],
        comments: details ? normalizeComments(details.comments, details.reviews) : [],
        todos,
        githubUnavailableReason,
      };
    });

  const addTodo: WorktreeChecksShape["addTodo"] = (input) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const todo: WorktreeChecksTodo = {
        todoId: randomUUID(),
        worktreeId: input.worktreeId,
        text: input.text.trim(),
        completed: false,
        createdAt: now,
        updatedAt: now,
      };
      yield* todoRepository.upsert(todo);
      return { todo };
    });

  const updateTodo: WorktreeChecksShape["updateTodo"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* todoRepository.getById({
        worktreeId: input.worktreeId,
        todoId: input.todoId,
      });
      if (Option.isNone(existing)) {
        return yield* worktreeChecksError("updateTodo", "Todo no longer exists.");
      }

      const nextTodo: WorktreeChecksTodo = {
        ...existing.value,
        ...(input.text !== undefined ? { text: input.text.trim() } : {}),
        ...(input.completed !== undefined ? { completed: input.completed } : {}),
        updatedAt: new Date().toISOString(),
      };
      yield* todoRepository.upsert(nextTodo);
      return { todo: nextTodo };
    });

  const deleteTodo: WorktreeChecksShape["deleteTodo"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* todoRepository.getById({
        worktreeId: input.worktreeId,
        todoId: input.todoId,
      });
      if (Option.isNone(existing)) {
        return yield* worktreeChecksError("deleteTodo", "Todo no longer exists.");
      }
      yield* todoRepository.deleteById({
        worktreeId: input.worktreeId,
        todoId: input.todoId,
      });
      return { deletedTodoId: input.todoId };
    });

  return {
    get,
    addTodo,
    updateTodo,
    deleteTodo,
    listTodosByWorktreeId,
  } satisfies WorktreeChecksShape;
});

export const WorktreeChecksLive = Layer.effect(WorktreeChecks, makeWorktreeChecks);
