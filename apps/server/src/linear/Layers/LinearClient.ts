import { IssueRelationType, LinearClient as SdkLinearClient, PaginationOrderBy } from "@linear/sdk";
import { LinearActivitySinkError } from "@t3tools/contracts";
import { Data, Effect, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { LinearOAuth } from "../Services/LinearOAuth.ts";
import {
  LinearClient,
  type LinearChildIssue,
  type LinearClientShape,
  type LinearIssueComment,
} from "../Services/LinearClient.ts";

class LinearSdkRequestError extends Data.TaggedError("LinearSdkRequestError")<{
  readonly cause: unknown;
}> {}

function isTokenExpiredError(cause: unknown): boolean {
  const error = cause as { status?: number; response?: { status?: number } };
  return error?.status === 401 || error?.response?.status === 401;
}

function toProjectKey(project: unknown): string | null {
  if (!project || typeof project !== "object") {
    return null;
  }
  const record = project as {
    slugId?: unknown;
    key?: unknown;
    name?: unknown;
  };
  for (const candidate of [record.slugId, record.key, record.name]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function toAgentSessionSummary(session: unknown): {
  readonly id: string;
  readonly issueId?: string;
  readonly issueIdentifier?: string;
} {
  const record = session as {
    id?: unknown;
    issueId?: unknown;
    issue?: {
      identifier?: unknown;
    } | null;
  };
  return {
    id: typeof record.id === "string" ? record.id : "",
    ...(typeof record.issueId === "string" ? { issueId: record.issueId } : {}),
    ...(typeof record.issue?.identifier === "string"
      ? { issueIdentifier: record.issue.identifier }
      : {}),
  };
}

const makeLinearClient = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const linearOAuth = yield* LinearOAuth;

  const toLinearActivitySinkError = (detail: string, cause: unknown) =>
    new LinearActivitySinkError({
      detail,
      cause,
    });

  const loadSdkClient = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new LinearActivitySinkError({
            detail: "Failed to load Linear settings.",
            cause,
          }),
      ),
    );
    const token = settings.linear.apiToken.trim();
    if (!token) {
      const oauthToken = yield* linearOAuth.getAccessToken.pipe(
        Effect.mapError((cause) =>
          toLinearActivitySinkError("Failed to load Linear OAuth credentials.", cause),
        ),
      );
      if (!oauthToken) {
        return yield* new LinearActivitySinkError({
          detail: "Linear is not configured. Add an API token or complete the OAuth install flow.",
        });
      }
      return {
        client: new SdkLinearClient({ apiKey: oauthToken.accessToken }),
        workspace: oauthToken.workspace,
      };
    }
    return {
      client: new SdkLinearClient({ apiKey: token }),
      workspace: null,
    };
  });

  const runWithSdkClient = <Result>(
    detail: string,
    execute: (client: SdkLinearClient) => Promise<Result>,
  ): Effect.Effect<Result, LinearActivitySinkError> =>
    loadSdkClient.pipe(
      Effect.flatMap(({ client, workspace }) =>
        Effect.tryPromise({
          try: () => execute(client),
          catch: (cause) => new LinearSdkRequestError({ cause }),
        }).pipe(
          Effect.catch((error) => {
            if (!workspace || !isTokenExpiredError(error.cause)) {
              return Effect.fail(toLinearActivitySinkError(detail, error.cause));
            }
            // Mirror Cyrus by refreshing and retrying once when Linear returns 401.
            return linearOAuth.refreshWorkspaceToken(workspace).pipe(
              Effect.mapError((refreshCause) => toLinearActivitySinkError(detail, refreshCause)),
              Effect.flatMap((refreshedWorkspace) =>
                Effect.tryPromise({
                  try: () =>
                    execute(new SdkLinearClient({ apiKey: refreshedWorkspace.accessToken })),
                  catch: (retryCause) => new LinearSdkRequestError({ cause: retryCause }),
                }),
              ),
              Effect.mapError((retryError) =>
                retryError instanceof LinearSdkRequestError
                  ? toLinearActivitySinkError(detail, retryError.cause)
                  : retryError,
              ),
            );
          }),
        ),
      ),
    );

  const createAgentActivity: LinearClientShape["createAgentActivity"] = (input) =>
    runWithSdkClient("Failed to create Linear agent activity.", async (client) => {
      const payload = await client.createAgentActivity({
        agentSessionId: input.agentSessionId,
        content: input.content,
        ...(input.ephemeral !== undefined ? { ephemeral: input.ephemeral } : {}),
        ...(input.signal ? { signal: input.signal as any } : {}),
        ...(input.signalMetadata ? { signalMetadata: input.signalMetadata as any } : {}),
      });
      const agentActivity = payload.agentActivity ? await payload.agentActivity : null;
      return { activityId: payload.success ? (agentActivity?.id ?? "") : "" };
    }).pipe(
      Effect.tap((result) =>
        // Capture the SDK response shape so Linear rendering mismatches are easier to debug.
        Effect.logInfo("linear client createAgentActivity completed", {
          agentSessionId: input.agentSessionId,
          contentType: input.content.type,
          ephemeral: input.ephemeral ?? null,
          activityId: result.activityId,
        }),
      ),
      Effect.flatMap((result) =>
        result.activityId
          ? Effect.succeed(result)
          : Effect.fail(
              new LinearActivitySinkError({
                detail: "Linear did not return an agent activity id.",
              }),
            ),
      ),
    );

  const fetchIssue: LinearClientShape["fetchIssue"] = (issueId) =>
    runWithSdkClient(`Failed to fetch Linear issue ${issueId}.`, async (client) => {
      const issue = await client.issue(issueId);
      const labelsConnection = await issue.labels();
      const relationsConnection =
        typeof issue.relations === "function"
          ? await issue.relations({ includeArchived: true })
          : { nodes: [] };
      const team = issue.team ? await issue.team : null;
      const state = issue.state ? await issue.state : null;
      const project =
        "project" in issue && issue.project ? await (issue.project as Promise<unknown>) : null;
      const labels = labelsConnection.nodes;
      const blockedByIssueIds = (
        await Promise.all(
          relationsConnection.nodes.map(async (relation) => {
            const relationRecord = relation as {
              type?: unknown;
              issue?: Promise<{ id?: string } | null> | { id?: string } | null;
              relatedIssue?: Promise<{ id?: string } | null> | { id?: string } | null;
            };
            if (relationRecord.type !== "blocks") {
              return null;
            }
            const blockingIssue = relationRecord.issue ? await relationRecord.issue : null;
            return typeof blockingIssue?.id === "string" ? blockingIssue.id : null;
          }),
        )
      ).filter((value): value is string => value !== null);
      const projectKey = toProjectKey(project);
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? "",
        teamKey: team?.key ?? "",
        state: state?.name ?? "",
        priority: issue.priority,
        url: issue.url,
        labelNames: labels.map((label) => label.name),
        projectKeys: projectKey ? [projectKey] : [],
        blockedByIssueIds,
      };
    });

  const fetchIssueComments: LinearClientShape["fetchIssueComments"] = (issueId) =>
    runWithSdkClient(`Failed to fetch Linear issue comments for ${issueId}.`, async (client) => {
      const issue = await client.issue(issueId);
      const commentsConnection = await issue.comments();
      const comments = await Promise.all(
        commentsConnection.nodes.map(async (comment): Promise<LinearIssueComment> => {
          const user = comment.user ? await comment.user : null;
          const author =
            user?.displayName?.trim() || user?.name?.trim() || user?.email?.trim() || "Unknown";
          const mappedComment: {
            id: string;
            body: string;
            createdAt: string;
            author: string;
            parentId?: string;
          } = {
            id: comment.id,
            body: comment.body ?? "",
            createdAt: comment.createdAt.toISOString(),
            author,
          };
          if (comment.parentId) {
            mappedComment.parentId = comment.parentId;
          }
          return mappedComment;
        }),
      );
      return comments;
    });

  const fetchIssueState: LinearClientShape["fetchIssueState"] = (issueId) =>
    runWithSdkClient(`Failed to fetch Linear issue state for ${issueId}.`, async (client) => {
      const issue = await client.issue(issueId);
      const state = issue.state ? await issue.state : null;
      if (!state) {
        throw new Error(`Linear issue ${issueId} does not have a workflow state.`);
      }
      return {
        id: state.id,
        name: state.name,
        ...(state.type ? { type: String(state.type) } : {}),
      };
    });

  const uploadFile: LinearClientShape["uploadFile"] = (input) =>
    runWithSdkClient("Failed to upload file to Linear.", async (client) => {
      const uploadOptions =
        input.makePublic !== undefined ? { makePublic: input.makePublic } : undefined;
      const upload = await client.fileUpload(
        input.contentType,
        input.filename,
        input.bytes.byteLength,
        uploadOptions,
      );
      const uploadRecord = upload as {
        uploadUrl?: unknown;
        assetUrl?: unknown;
      };
      const uploadUrl =
        typeof uploadRecord.uploadUrl === "string" ? uploadRecord.uploadUrl : undefined;
      const assetUrl =
        typeof uploadRecord.assetUrl === "string" ? uploadRecord.assetUrl : undefined;
      if (!uploadUrl || !assetUrl) {
        throw new Error("Linear file upload did not return upload URLs.");
      }
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": input.contentType,
        },
        body: input.bytes,
      });
      if (!response.ok) {
        throw new Error(`Linear upload PUT failed with status ${response.status}.`);
      }
      return {
        assetUrl,
        uploadUrl,
      };
    });

  const createAgentSessionOnIssue: LinearClientShape["createAgentSessionOnIssue"] = (
    issueId,
    externalLink,
  ) =>
    runWithSdkClient(
      `Failed to create Linear agent session on issue ${issueId}.`,
      async (client) => {
        const payload = await client.agentSessionCreateOnIssue({
          issueId,
          ...(externalLink ? { externalLink } : {}),
        });
        return toAgentSessionSummary(payload.agentSession ?? payload);
      },
    );

  const createAgentSessionOnComment: LinearClientShape["createAgentSessionOnComment"] = (
    commentId,
    externalLink,
  ) =>
    runWithSdkClient(
      `Failed to create Linear agent session on comment ${commentId}.`,
      async (client) => {
        const payload = await client.agentSessionCreateOnComment({
          commentId,
          ...(externalLink ? { externalLink } : {}),
        });
        return toAgentSessionSummary(payload.agentSession ?? payload);
      },
    );

  const listAgentSessions: LinearClientShape["listAgentSessions"] = (input = {}) =>
    runWithSdkClient("Failed to list Linear agent sessions.", async (client) => {
      const connection = await client.agentSessions({
        ...(input.first !== undefined ? { first: input.first } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.last !== undefined ? { last: input.last } : {}),
        ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
        ...(input.orderBy !== undefined ? { orderBy: input.orderBy as PaginationOrderBy } : {}),
      });
      return connection.nodes.map((session) => toAgentSessionSummary(session));
    });

  const getAgentSession: LinearClientShape["getAgentSession"] = (sessionId) =>
    runWithSdkClient(`Failed to fetch Linear agent session ${sessionId}.`, async (client) => {
      const session = await client.agentSession(sessionId);
      return toAgentSessionSummary(session);
    });

  const createIssueRelation: LinearClientShape["createIssueRelation"] = (input) =>
    runWithSdkClient(
      `Failed to create Linear issue relation for ${input.issueId}.`,
      async (client) => {
        const type =
          input.type === "duplicate"
            ? IssueRelationType.Duplicate
            : input.type === "related"
              ? IssueRelationType.Related
              : IssueRelationType.Blocks;
        await client.createIssueRelation({
          issueId: input.issueId,
          relatedIssueId: input.relatedIssueId,
          type,
        });
      },
    );

  const listChildIssues: LinearClientShape["listChildIssues"] = (input) =>
    runWithSdkClient(`Failed to list child issues for ${input.issueId}.`, async (client) => {
      const issue = await client.issue(input.issueId);
      const connection = await issue.children({
        ...(input.limit !== undefined ? { first: input.limit } : {}),
        ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
      });
      return await Promise.all(
        connection.nodes.map(async (child): Promise<LinearChildIssue> => {
          const state =
            "state" in child && child.state
              ? await (child.state as Promise<{ name?: string } | null>)
              : null;
          return Object.assign(
            {
              id: child.id,
              identifier: child.identifier,
              title: child.title,
            },
            typeof state?.name === "string" ? { state: state.name } : undefined,
            child.archivedAt ? { archivedAt: child.archivedAt.toISOString() } : undefined,
          ) as LinearChildIssue;
        }),
      );
    });

  return {
    createAgentActivity,
    fetchIssue,
    fetchIssueComments,
    fetchIssueState,
    uploadFile,
    createAgentSessionOnIssue,
    createAgentSessionOnComment,
    listAgentSessions,
    getAgentSession,
    createIssueRelation,
    listChildIssues,
  } satisfies LinearClientShape;
});

export const LinearClientLive = Layer.effect(LinearClient, makeLinearClient);
