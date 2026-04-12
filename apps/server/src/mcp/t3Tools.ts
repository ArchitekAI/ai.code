import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

export interface T3ToolsServerDependencies {
  readonly uploadFile: (input: {
    readonly filePath: string;
    readonly filename?: string;
    readonly contentType?: string;
    readonly makePublic?: boolean;
  }) => Promise<{
    readonly assetUrl: string;
    readonly uploadUrl: string;
  }>;
  readonly createAgentSessionOnIssue: (
    issueId: string,
    externalLink?: string,
  ) => Promise<{
    readonly id: string;
    readonly issueId?: string;
    readonly issueIdentifier?: string;
  }>;
  readonly createAgentSessionOnComment: (
    commentId: string,
    externalLink?: string,
  ) => Promise<{
    readonly id: string;
    readonly issueId?: string;
    readonly issueIdentifier?: string;
  }>;
  readonly createAgentActivity: (input: {
    readonly agentSessionId: string;
    readonly body: string;
  }) => Promise<void>;
  readonly createIssueRelation: (input: {
    readonly issueId: string;
    readonly relatedIssueId: string;
    readonly type: "blocks" | "related" | "duplicate";
  }) => Promise<void>;
  readonly listChildIssues: (input: {
    readonly issueId: string;
    readonly limit?: number;
    readonly includeArchived?: boolean;
  }) => Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly identifier: string;
      readonly title: string;
      readonly state?: string;
      readonly archivedAt?: string;
    }>
  >;
  readonly listAgentSessions: (input: {
    readonly first?: number;
    readonly after?: string;
    readonly before?: string;
    readonly last?: number;
    readonly includeArchived?: boolean;
    readonly orderBy?: string;
  }) => Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly issueId?: string;
      readonly issueIdentifier?: string;
    }>
  >;
  readonly getAgentSession: (sessionId: string) => Promise<{
    readonly id: string;
    readonly issueId?: string;
    readonly issueIdentifier?: string;
  }>;
  readonly onSessionCreated?: (
    childLinearSessionId: string,
    childIssueIdentifier?: string,
  ) => Promise<void> | void;
  readonly onFeedbackDelivery?: (childLinearSessionId: string, message: string) => Promise<boolean>;
}

const textAndJson = <T>(payload: T) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(payload, null, 2),
    },
  ],
  structuredContent: payload,
});

export function createT3ToolsServer(dependencies: T3ToolsServerDependencies) {
  const server = new McpServer({
    name: "t3-tools",
    version: "1.0.0",
  });

  server.registerTool(
    "linear_upload_file",
    {
      description: "Upload a local file into Linear and return the resulting asset URL.",
      inputSchema: {
        filePath: z.string().min(1),
        filename: z.string().optional(),
        contentType: z.string().optional(),
        makePublic: z.boolean().optional(),
      },
    },
    async ({ filePath, filename, contentType, makePublic }) => {
      const uploaded = await dependencies.uploadFile({
        filePath,
        ...(filename !== undefined ? { filename } : {}),
        ...(contentType !== undefined ? { contentType } : {}),
        ...(makePublic !== undefined ? { makePublic } : {}),
      });
      return textAndJson({
        success: true,
        assetUrl: uploaded.assetUrl,
        uploadUrl: uploaded.uploadUrl,
      });
    },
  );

  server.registerTool(
    "linear_agent_session_create",
    {
      description:
        "Create a child Linear agent session on an issue and wire it back to the parent thread.",
      inputSchema: {
        issueId: z.string().min(1),
        externalLink: z.string().optional(),
      },
    },
    async ({ issueId, externalLink }) => {
      const session = await dependencies.createAgentSessionOnIssue(issueId, externalLink);
      if (dependencies.onSessionCreated) {
        await dependencies.onSessionCreated(session.id, session.issueIdentifier);
      }
      return textAndJson({
        success: true,
        sessionId: session.id,
        issueId: session.issueId,
        issueIdentifier: session.issueIdentifier,
      });
    },
  );

  server.registerTool(
    "linear_agent_session_create_on_comment",
    {
      description:
        "Create a child Linear agent session on a comment and wire it back to the parent thread.",
      inputSchema: {
        commentId: z.string().min(1),
        externalLink: z.string().optional(),
      },
    },
    async ({ commentId, externalLink }) => {
      const session = await dependencies.createAgentSessionOnComment(commentId, externalLink);
      if (dependencies.onSessionCreated) {
        await dependencies.onSessionCreated(session.id, session.issueIdentifier);
      }
      return textAndJson({
        success: true,
        sessionId: session.id,
        issueId: session.issueId,
        issueIdentifier: session.issueIdentifier,
      });
    },
  );

  server.registerTool(
    "linear_agent_give_feedback",
    {
      description: "Send review feedback back into a child Linear agent session.",
      inputSchema: {
        agentSessionId: z.string().min(1),
        message: z.string().min(1),
      },
    },
    async ({ agentSessionId, message }) => {
      try {
        await dependencies.createAgentActivity({
          agentSessionId,
          body: message,
        });
        if (dependencies.onFeedbackDelivery) {
          await dependencies.onFeedbackDelivery(agentSessionId, message);
        }
      } catch (error) {
        // Cyrus treats feedback delivery as best effort so parent flows do not stall on retries.
        console.warn("t3-tools feedback delivery callback failed", error);
      }

      return textAndJson({
        success: true,
      });
    },
  );

  server.registerTool(
    "linear_set_issue_relation",
    {
      description: "Create an issue relation in Linear.",
      inputSchema: {
        issueId: z.string().min(1),
        relatedIssueId: z.string().min(1),
        type: z.enum(["blocks", "related", "duplicate"]),
      },
    },
    async ({ issueId, relatedIssueId, type }) => {
      await dependencies.createIssueRelation({
        issueId,
        relatedIssueId,
        type,
      });
      return textAndJson({
        success: true,
      });
    },
  );

  server.registerTool(
    "linear_get_child_issues",
    {
      description: "List child issues for a parent issue in Linear.",
      inputSchema: {
        issueId: z.string().min(1),
        limit: z.number().int().positive().optional(),
        includeCompleted: z.boolean().optional(),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ issueId, limit, includeCompleted, includeArchived }) => {
      const issues = await dependencies.listChildIssues({
        issueId,
        ...(limit !== undefined ? { limit } : {}),
        ...(includeArchived !== undefined ? { includeArchived } : {}),
      });
      const filteredIssues =
        includeCompleted === true
          ? issues
          : issues.filter(
              (issue) => !issue.state || !/done|complete|closed|cancel/i.test(issue.state),
            );
      return textAndJson({
        success: true,
        issues: filteredIssues,
      });
    },
  );

  server.registerTool(
    "linear_get_agent_sessions",
    {
      description: "List Linear agent sessions.",
      inputSchema: {
        first: z.number().int().positive().optional(),
        after: z.string().optional(),
        before: z.string().optional(),
        last: z.number().int().positive().optional(),
        includeArchived: z.boolean().optional(),
        orderBy: z.string().optional(),
      },
    },
    async ({ first, after, before, last, includeArchived, orderBy }) => {
      const sessions = await dependencies.listAgentSessions({
        ...(first !== undefined ? { first } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(last !== undefined ? { last } : {}),
        ...(includeArchived !== undefined ? { includeArchived } : {}),
        ...(orderBy !== undefined ? { orderBy } : {}),
      });
      return textAndJson({
        success: true,
        sessions,
      });
    },
  );

  server.registerTool(
    "linear_get_agent_session",
    {
      description: "Get a specific Linear agent session by id.",
      inputSchema: {
        sessionId: z.string().min(1),
      },
    },
    async ({ sessionId }) => {
      const session = await dependencies.getAgentSession(sessionId);
      return textAndJson({
        success: true,
        session,
      });
    },
  );

  return server;
}
