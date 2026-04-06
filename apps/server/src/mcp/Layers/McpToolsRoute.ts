import { randomUUID } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { CommandId, MessageId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { LinearClient } from "../../linear/Services/LinearClient.ts";
import { LinearSessionRegistry } from "../../linear/Services/LinearSessionRegistry.ts";
import { BootstrapTurnService } from "../../orchestration/Services/BootstrapTurnService.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { createT3ToolsServer } from "../t3Tools.ts";
import { McpContextRegistry } from "../Services/McpContextRegistry.ts";
import { ThreadRelationshipRegistry } from "../Services/ThreadRelationshipRegistry.ts";

const getHeader = (headers: Headers, name: string) =>
  headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase());

export const mcpToolsRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const bootstrapTurnService = yield* BootstrapTurnService;
    const linearClient = yield* LinearClient;
    const linearSessionRegistry = yield* LinearSessionRegistry;
    const mcpContextRegistry = yield* McpContextRegistry;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const serverConfig = yield* ServerConfig;
    const threadRelationshipRegistry = yield* ThreadRelationshipRegistry;

    const transports = new Map<
      string,
      {
        readonly server: ReturnType<typeof createT3ToolsServer>;
        readonly transport: WebStandardStreamableHTTPServerTransport;
      }
    >();

    return HttpRouter.add(
      "POST",
      "/mcp/t3-tools",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);

        if (serverConfig.authToken) {
          const authorization = getHeader(webRequest.headers, "authorization");
          if (authorization !== `Bearer ${serverConfig.authToken}`) {
            return HttpServerResponse.text("Unauthorized MCP request", { status: 401 });
          }
        }

        const contextId = getHeader(webRequest.headers, "x-t3-mcp-context-id");
        if (!contextId) {
          return HttpServerResponse.text("Missing MCP context id", { status: 400 });
        }

        const contextRegistration = yield* mcpContextRegistry.lookup(contextId);
        if (contextRegistration._tag === "None") {
          return HttpServerResponse.text("Unknown MCP context id", { status: 404 });
        }

        const requestBody = yield* Effect.tryPromise({
          try: () =>
            webRequest
              .clone()
              .json()
              .catch(() => undefined),
          catch: () => undefined,
        });

        const sessionId = getHeader(webRequest.headers, "mcp-session-id");
        let transportRecord = sessionId ? transports.get(sessionId) : undefined;

        if (!transportRecord) {
          if (sessionId || !isInitializeRequest(requestBody)) {
            return HttpServerResponse.text("Bad MCP session request", { status: 400 });
          }

          const snapshot = yield* projectionSnapshotQuery.getSnapshot();
          const parentThread = snapshot.threads.find(
            (thread) => thread.id === contextRegistration.value.parentThreadId,
          );
          const parentProject = snapshot.projects.find(
            (project) => project.id === contextRegistration.value.projectId,
          );
          if (!parentThread || !parentProject) {
            return HttpServerResponse.text("MCP context no longer points at a live thread", {
              status: 404,
            });
          }

          const parentSessions = yield* linearSessionRegistry.listByThreadId(parentThread.id);
          const parentIssueIdentifier = parentSessions.at(-1)?.issueIdentifier;

          const server = createT3ToolsServer({
            uploadFile: async (input) => {
              const path = await import("node:path");
              const { readFile } = await import("node:fs/promises");
              const resolvedPath = path.isAbsolute(input.filePath)
                ? input.filePath
                : path.resolve(
                    parentThread.worktreePath ?? parentProject.workspaceRoot,
                    input.filePath,
                  );
              const bytes = new Uint8Array(await readFile(resolvedPath));
              return Effect.runPromise(
                linearClient.uploadFile({
                  bytes,
                  filename: input.filename?.trim() || path.basename(resolvedPath),
                  contentType: input.contentType?.trim() || "application/octet-stream",
                  ...(input.makePublic !== undefined ? { makePublic: input.makePublic } : {}),
                }),
              );
            },
            createAgentSessionOnIssue: (issueId, externalLink) =>
              Effect.runPromise(linearClient.createAgentSessionOnIssue(issueId, externalLink)),
            createAgentSessionOnComment: (commentId, externalLink) =>
              Effect.runPromise(linearClient.createAgentSessionOnComment(commentId, externalLink)),
            createAgentActivity: ({ agentSessionId, body }) =>
              Effect.runPromise(
                linearClient.createAgentActivity({
                  agentSessionId,
                  content: {
                    type: "thought",
                    body: parentIssueIdentifier
                      ? `Feedback from ${parentIssueIdentifier}: ${body}`
                      : `Feedback from orchestrator: ${body}`,
                  },
                  ephemeral: false,
                }),
              ).then(() => undefined),
            createIssueRelation: (input) =>
              Effect.runPromise(linearClient.createIssueRelation(input)).then(() => undefined),
            listChildIssues: (input) =>
              Effect.runPromise(
                linearClient.listChildIssues({
                  issueId: input.issueId,
                  ...(input.limit !== undefined ? { limit: input.limit } : {}),
                  ...(input.includeArchived !== undefined
                    ? { includeArchived: input.includeArchived }
                    : {}),
                }),
              ),
            listAgentSessions: (input) => Effect.runPromise(linearClient.listAgentSessions(input)),
            getAgentSession: (sessionId) =>
              Effect.runPromise(linearClient.getAgentSession(sessionId)),
            onSessionCreated: (childLinearSessionId, childIssueIdentifier) =>
              Effect.runPromise(
                threadRelationshipRegistry.registerFromMcp({
                  id: randomUUID(),
                  parentThreadId: parentThread.id,
                  childLinearSessionId,
                  ...(childIssueIdentifier ? { childIssueIdentifier } : {}),
                  createdAt: new Date().toISOString(),
                }),
              ).then(() => undefined),
            onFeedbackDelivery: async (childLinearSessionId, message) => {
              const relationship = await Effect.runPromise(
                threadRelationshipRegistry.findParentByLinearSession(childLinearSessionId),
              );
              if (relationship._tag === "None" || !relationship.value.childThreadId) {
                return false;
              }

              const currentSnapshot = await Effect.runPromise(
                projectionSnapshotQuery.getSnapshot(),
              );
              const childThread = currentSnapshot.threads.find(
                (thread) => thread.id === relationship.value.childThreadId,
              );
              if (!childThread) {
                return false;
              }

              await Effect.runPromise(
                bootstrapTurnService.dispatch({
                  type: "thread.turn.start",
                  commandId: CommandId.makeUnsafe(`server:feedback:${randomUUID()}`),
                  threadId: childThread.id,
                  message: {
                    messageId: MessageId.makeUnsafe(randomUUID()),
                    role: "user",
                    text: [
                      "## Received feedback from orchestrator",
                      "",
                      "---",
                      "",
                      message,
                      "",
                      "---",
                    ].join("\n"),
                    attachments: [],
                  },
                  modelSelection: childThread.modelSelection,
                  titleSeed: childThread.title,
                  runtimeMode: childThread.runtimeMode,
                  interactionMode: childThread.interactionMode,
                  createdAt: new Date().toISOString(),
                }),
              );
              return true;
            },
          });

          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (initializedSessionId) => {
              transports.set(initializedSessionId, {
                server,
                transport,
              });
            },
          });
          yield* Effect.tryPromise(() => server.connect(transport));
          transportRecord = { server, transport };
        }

        const response = yield* Effect.tryPromise(() =>
          transportRecord.transport.handleRequest(webRequest),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    ).pipe(
      Layer.provide(
        HttpRouter.cors({
          allowedMethods: ["POST", "OPTIONS"],
          allowedHeaders: [
            "authorization",
            "content-type",
            "mcp-session-id",
            "x-t3-mcp-context-id",
          ],
          exposedHeaders: ["mcp-session-id", "mcp-protocol-version"],
        }),
      ),
    );
  }),
);
