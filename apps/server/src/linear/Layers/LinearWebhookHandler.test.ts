import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  type LinearProjectMapping,
  type LinearSessionRow,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import { BootstrapTurnService } from "../../orchestration/Services/BootstrapTurnService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ThreadRelationshipRegistry } from "../../mcp/Services/ThreadRelationshipRegistry.ts";
import { ToolPolicyResolver } from "../../provider/Services/ToolPolicyResolver.ts";
import { ProjectOnboarding } from "../../project/Services/ProjectOnboarding.ts";
import {
  LinearClient,
  type LinearAgentActivityInput,
  type LinearIssueDetails,
} from "../Services/LinearClient.ts";
import { LinearPromptAssembler } from "../Services/LinearPromptAssembler.ts";
import { LinearSessionRegistry } from "../Services/LinearSessionRegistry.ts";
import { LinearWebhookHandler } from "../Services/LinearWebhookHandler.ts";
import { LinearWebhookHandlerLive } from "./LinearWebhookHandler.ts";

const defaultProjectId = ProjectId.makeUnsafe("project-linear");
const activeThreadId = ThreadId.makeUnsafe("thread-active");
const staleThreadId = ThreadId.makeUnsafe("thread-stale");
const now = "2026-04-05T12:00:00.000Z";
const defaultModelSelection = {
  provider: "codex" as const,
  model: "gpt-5-codex",
};

const makeThread = (
  threadId: ThreadId,
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] => ({
  id: threadId,
  projectId: defaultProjectId,
  title: `Thread ${threadId}`,
  modelSelection: defaultModelSelection,
  interactionMode: "default",
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  ...overrides,
});

const makeReadModel = (
  threads: ReadonlyArray<OrchestrationReadModel["threads"][number]>,
): OrchestrationReadModel => ({
  snapshotSequence: 0,
  updatedAt: now,
  projects: [
    {
      id: defaultProjectId,
      title: "Linear Project",
      workspaceRoot: "/tmp/linear-project",
      defaultModelSelection,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [...threads],
});

const makeCreatedPayload = (linearSessionId: string) => ({
  type: "AgentSessionEvent" as const,
  action: "created" as const,
  createdAt: now,
  organizationId: "org-linear",
  agentSession: {
    id: linearSessionId,
    creator: {
      id: "user-1",
      name: "Alice Smith",
    },
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Fix Linear webhook parity",
      description: "Port the Linear webhook behavior cleanly.",
      team: { key: "ENG" },
    },
  },
});

const makeCreatedPayloadWithNullables = (linearSessionId: string) => ({
  type: "AgentSessionEvent" as const,
  action: "created" as const,
  createdAt: now,
  organizationId: "org-linear",
  agentSession: {
    id: linearSessionId,
    issueId: null,
    creator: null,
    comment: null,
    issue: {
      id: "issue-1",
      identifier: null,
      title: null,
      description: null,
      team: null,
    },
  },
  guidance: [
    {
      body: null,
      origin: null,
    },
  ],
});

const makePromptedPayload = (body: string, linearSessionId = "linear-session-active") => ({
  type: "AgentSessionEvent" as const,
  action: "prompted" as const,
  createdAt: now,
  organizationId: "org-linear",
  agentSession: {
    id: linearSessionId,
    issueId: "issue-1",
    creator: {
      id: "user-2",
      name: "Bob Jones",
    },
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Fix Linear webhook parity",
      description: "Port the Linear webhook behavior cleanly.",
      team: { key: "ENG" },
    },
  },
  agentActivity: {
    id: "activity-1",
    content: {
      body,
    },
  },
});

const makeIssueUpdatePayload = (input: {
  readonly updatedFrom: {
    readonly stateId?: string;
    readonly title?: string;
    readonly description?: string;
  };
}) => ({
  type: "Issue" as const,
  action: "update" as const,
  createdAt: now,
  organizationId: "org-linear",
  data: {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Fix Linear webhook parity",
    description: "Port the Linear webhook behavior cleanly.",
    url: "https://linear.app/t3/issue/ENG-1",
    stateId: "state-in-progress",
    team: {
      id: "team-1",
      key: "ENG",
      name: "Engineering",
    },
  },
  updatedFrom: input.updatedFrom,
});

const makeUnassignedPayload = () => ({
  type: "AppUserNotification" as const,
  action: "issueUnassignedFromYou" as const,
  createdAt: now,
  organizationId: "org-linear",
  notification: {
    type: "issueUnassignedFromYou" as const,
    issueId: "issue-1",
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Fix Linear webhook parity",
      description: "Port the Linear webhook behavior cleanly.",
      team: { key: "ENG" },
    },
  },
});

const defaultIssueDetails: LinearIssueDetails = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Fix Linear webhook parity",
  description: "Port the Linear webhook behavior cleanly.",
  teamKey: "ENG",
  state: "Started",
  priority: 2,
  url: "https://linear.app/t3/issue/ENG-1",
  labelNames: [],
  projectKeys: [],
  blockedByIssueIds: [],
};

const makeHandlerLayer = (input: {
  readonly readModel: OrchestrationReadModel;
  readonly issueSessions?: ReadonlyArray<LinearSessionRow>;
  readonly sessionLookup?: LinearSessionRow | null;
  readonly issueDetails?: LinearIssueDetails;
  readonly issueComments?: ReadonlyArray<{
    readonly id: string;
    readonly body: string;
    readonly createdAt: string;
    readonly author: string;
    readonly parentId?: string;
  }>;
  readonly issueState?: {
    readonly id: string;
    readonly name: string;
    readonly type?: string;
  };
  readonly mappings?: ReadonlyArray<LinearProjectMapping>;
  readonly defaultWorkspaceRoot?: string;
}) => {
  const commands: Array<OrchestrationCommand> = [];
  const createdAgentActivities: Array<LinearAgentActivityInput> = [];
  const removedSessionIds: Array<string> = [];
  const registeredSessions: Array<LinearSessionRow> = [];
  const issueSessions = [...(input.issueSessions ?? [])];
  const sessionLookup = input.sessionLookup ?? null;
  const issueDetails = input.issueDetails ?? defaultIssueDetails;
  const issueComments = [...(input.issueComments ?? [])];
  const issueState = input.issueState ?? {
    id: "state-started",
    name: "Started",
    type: "started",
  };

  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    linear: {
      ...DEFAULT_SERVER_SETTINGS.linear,
      enabled: true,
      webhookSecret: "linear-secret",
      verificationMode: "proxy" as const,
    },
    linearProjectMappings: {
      mappings: [
        ...(input.mappings ?? [
          {
            teamKey: "ENG",
            workspaceRoot: "/tmp/linear-project",
            baseBranch: "main",
          },
        ]),
      ],
      defaultWorkspaceRoot: input.defaultWorkspaceRoot ?? "",
    },
  };

  const layer = LinearWebhookHandlerLive.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.mock(ServerSettingsService)({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.succeed(settings),
        updateSettings: () => Effect.succeed(settings),
        applyRuntimeOverrides: () => Effect.succeed(settings),
        streamChanges: Stream.empty,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ServerRuntimeStartup)({
        awaitCommandReady: Effect.void,
        markHttpListening: Effect.void,
        enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) => effect,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(BootstrapTurnService)({
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        getSnapshot: () => Effect.succeed(input.readModel),
        getCounts: () =>
          Effect.succeed({ projectCount: 1, threadCount: input.readModel.threads.length }),
        getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
          Effect.sync(() => {
            const project =
              input.readModel.projects.find((entry) => entry.workspaceRoot === workspaceRoot) ??
              null;
            return project === null ? Option.none() : Option.some(project);
          }),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(LinearSessionRegistry)({
        register: (entry) =>
          Effect.sync(() => {
            registeredSessions.push(entry);
          }),
        lookupBySessionId: () =>
          Effect.succeed(
            sessionLookup === null ? Option.none<LinearSessionRow>() : Option.some(sessionLookup),
          ),
        listByThreadId: (threadId) =>
          Effect.succeed(issueSessions.filter((session) => session.threadId === threadId)),
        listByIssueId: (issueId) =>
          Effect.succeed(issueSessions.filter((session) => session.issueId === issueId)),
        remove: (linearSessionId) =>
          Effect.sync(() => {
            removedSessionIds.push(linearSessionId);
          }),
        removeByIssueId: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(OrchestrationEngineService)({
        getReadModel: () => Effect.succeed(input.readModel),
        readEvents: () => Stream.empty,
        dispatch: () => Effect.die("unused"),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(LinearClient)({
        createAgentActivity: (activity) =>
          Effect.sync(() => {
            createdAgentActivities.push(activity);
            return { activityId: `activity-${createdAgentActivities.length}` };
          }),
        fetchIssue: () => Effect.succeed(issueDetails),
        fetchIssueComments: () => Effect.succeed(issueComments),
        fetchIssueState: () => Effect.succeed(issueState),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(LinearPromptAssembler)({
        assembleNewSessionPrompt: (assemblerInput) =>
          Effect.succeed({
            // Keep the prompt mock structured enough that tests can assert the
            // handler passes enriched context into the provider turn payload.
            prompt: `new-session:${assemblerInput.issue.identifier}:${assemblerInput.worktreePath}`,
            systemPromptPrefix: "SYSTEM:builder",
            promptType: assemblerInput.promptType ?? "builder",
          }),
        assembleContinuationPrompt: (assemblerInput) =>
          Effect.succeed({
            prompt: `continuation:${assemblerInput.comment.author}:${assemblerInput.comment.timestamp}:${assemblerInput.comment.body}`,
            promptType: assemblerInput.promptType ?? "builder",
          }),
        assembleIssueUpdatePrompt: (assemblerInput) =>
          Effect.succeed({
            prompt: `issue-update:${assemblerInput.issue.identifier}`,
            systemPromptPrefix: "SYSTEM:builder",
            promptType: assemblerInput.promptType ?? "builder",
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ThreadRelationshipRegistry)({
        registerFromMcp: () => Effect.void,
        attachChildThread: () => Effect.void,
        listChildren: () => Effect.succeed([]),
        findParent: () => Effect.succeed(Option.none()),
        findParentByLinearSession: () => Effect.succeed(Option.none()),
        markResumed: () => Effect.succeed(true),
        updateChildWorktree: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ToolPolicyResolver)({
        resolve: () => Effect.succeed({}),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectOnboarding)({
        addRepository: () => Effect.die("unused"),
        ensureProjectForWorkspaceRoot: (workspaceRoot) =>
          Effect.succeed({
            projectId: defaultProjectId,
            projectCreated: false,
            title: "Linear Project",
            workspaceRoot,
            defaultModelSelection,
          }),
      }),
    ),
  );

  return {
    commands,
    createdAgentActivities,
    removedSessionIds,
    registeredSessions,
    layer,
  };
};

const runWebhook = (layer: Layer.Layer<LinearWebhookHandler>, payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    const handler = yield* LinearWebhookHandler;
    yield* handler.handleWebhook({
      rawBody: new TextEncoder().encode(JSON.stringify(payload)),
      authorization: "Bearer linear-secret",
    });
  }).pipe(Effect.provide(layer));

const runWebhookSequence = (
  layer: Layer.Layer<LinearWebhookHandler>,
  payloads: ReadonlyArray<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const handler = yield* LinearWebhookHandler;
    for (const payload of payloads) {
      yield* handler.handleWebhook({
        rawBody: new TextEncoder().encode(JSON.stringify(payload)),
        authorization: "Bearer linear-secret",
      });
    }
  }).pipe(Effect.provide(layer));

it.layer(NodeServices.layer)("linear webhook handler", (it) => {
  it.effect("drops stale issue session mappings before bootstrapping a new created session", () =>
    Effect.gen(function* () {
      const staleSession: LinearSessionRow = {
        linearSessionId: "linear-session-stale",
        threadId: staleThreadId,
        projectId: defaultProjectId,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        createdAt: "2026-04-05T12:05:00.000Z",
      };

      const harness = makeHandlerLayer({
        readModel: makeReadModel([
          makeThread(staleThreadId, {
            archivedAt: "2026-04-05T12:06:00.000Z",
          }),
        ]),
        issueSessions: [staleSession],
      });

      yield* runWebhook(harness.layer, makeCreatedPayload("linear-session-new"));

      assert.deepEqual(harness.removedSessionIds, ["linear-session-stale"]);
      assert.equal(harness.commands.length, 1);
      assert.equal(harness.commands[0]?.type, "thread.turn.start");

      const command = harness.commands[0];
      if (command?.type !== "thread.turn.start") {
        throw new Error("Expected thread.turn.start command");
      }

      if (!command.bootstrap?.prepareWorktree) {
        throw new Error("Expected bootstrap prepareWorktree metadata");
      }

      assert.equal(command.bootstrap.prepareWorktree.projectCwd, "/tmp/linear-project");
      assert.equal(command.bootstrap.prepareWorktree.writeLinearMcpConfig, true);
      assert.equal(
        command.message.text,
        "new-session:ENG-1:/tmp/linear-project/feature/eng-1-fix-linear-webhook-parity",
      );
      assert.equal(command.systemPromptPrefix, "SYSTEM:builder");
      assert.equal(harness.registeredSessions.length, 1);
      assert.equal(harness.registeredSessions[0]?.linearSessionId, "linear-session-new");
      assert.notEqual(harness.registeredSessions[0]?.threadId, staleThreadId);
    }),
  );

  it.effect("accepts created webhooks that include nullable Linear SDK fields", () =>
    Effect.gen(function* () {
      const harness = makeHandlerLayer({
        readModel: makeReadModel([]),
      });

      yield* runWebhook(harness.layer, makeCreatedPayloadWithNullables("linear-session-nullable"));

      assert.equal(harness.commands.length, 1);
      const command = harness.commands[0];
      if (command?.type !== "thread.turn.start") {
        throw new Error("Expected thread.turn.start command");
      }

      assert.equal(
        command.message.text,
        "new-session:ENG-1:/tmp/linear-project/feature/eng-1-fix-linear-webhook-parity",
      );
      assert.equal(harness.registeredSessions[0]?.linearSessionId, "linear-session-nullable");
    }),
  );

  it.effect("only inherits blocker branch lineage for graphite orchestrator sessions", () =>
    Effect.gen(function* () {
      const blockerThreadId = ThreadId.makeUnsafe("thread-blocker");
      const blockerSession: LinearSessionRow = {
        linearSessionId: "linear-session-blocker",
        threadId: blockerThreadId,
        projectId: defaultProjectId,
        issueId: "issue-blocker",
        issueIdentifier: "ENG-2",
        createdAt: "2026-04-05T11:30:00.000Z",
      };

      const harness = makeHandlerLayer({
        readModel: makeReadModel([
          makeThread(blockerThreadId, {
            branch: "feature/eng-2-parent-lineage",
          }),
        ]),
        issueSessions: [blockerSession],
        issueDetails: {
          ...defaultIssueDetails,
          blockedByIssueIds: ["issue-blocker"],
        },
      });

      yield* runWebhook(harness.layer, makeCreatedPayload("linear-session-new"));

      const command = harness.commands[0];
      if (command?.type !== "thread.turn.start" || !command.bootstrap?.prepareWorktree) {
        throw new Error("Expected bootstrap prepareWorktree metadata");
      }

      assert.equal(command.bootstrap.prepareWorktree.baseBranch, "main");
    }),
  );

  it.effect("asks the user which repository to use when configured mappings do not match", () =>
    Effect.gen(function* () {
      const harness = makeHandlerLayer({
        readModel: makeReadModel([]),
        mappings: [
          {
            workspaceRoot: "/tmp/frontend",
            routeKey: "frontend",
            teamKey: "ENG",
          },
          {
            workspaceRoot: "/tmp/backend",
            routeKey: "backend",
            teamKey: "ENG",
          },
        ],
      });

      yield* runWebhook(harness.layer, makeCreatedPayload("linear-session-select"));

      assert.equal(harness.commands.length, 0);
      assert.equal(harness.createdAgentActivities.length, 1);
      assert.deepEqual(harness.createdAgentActivities[0], {
        agentSessionId: "linear-session-select",
        content: {
          type: "elicitation",
          body: "Which repository should I work in for this issue?",
        },
        signal: "select",
        signalMetadata: {
          options: [{ value: "frontend" }, { value: "backend" }],
        },
      });
      assert.equal(harness.registeredSessions.length, 0);
    }),
  );

  it.effect("includes the default workspace root as a selectable repository", () =>
    Effect.gen(function* () {
      const harness = makeHandlerLayer({
        readModel: makeReadModel([]),
        mappings: [
          {
            workspaceRoot: "/tmp/hello-world",
            routeKey: "hello-world",
            teamKey: "ENG",
          },
        ],
        defaultWorkspaceRoot: "/tmp/ai.code",
      });

      yield* runWebhook(harness.layer, makeCreatedPayload("linear-session-select-default"));

      assert.equal(harness.commands.length, 0);
      assert.deepEqual(harness.createdAgentActivities, [
        {
          agentSessionId: "linear-session-select-default",
          content: {
            type: "elicitation",
            body: "Which repository should I work in for this issue?",
          },
          signal: "select",
          signalMetadata: {
            options: [{ value: "hello-world" }, { value: "ai.code" }],
          },
        },
      ]);
    }),
  );

  it.effect("uses the prompted repository selection to bootstrap the chosen repo", () =>
    Effect.gen(function* () {
      const harness = makeHandlerLayer({
        readModel: makeReadModel([]),
        mappings: [
          {
            workspaceRoot: "/tmp/frontend",
            routeKey: "frontend",
            teamKey: "ENG",
            baseBranch: "main",
          },
          {
            workspaceRoot: "/tmp/backend",
            routeKey: "backend",
            teamKey: "ENG",
            baseBranch: "develop",
          },
        ],
      });

      yield* runWebhookSequence(harness.layer, [
        makeCreatedPayload("linear-session-select"),
        makePromptedPayload("backend", "linear-session-select"),
      ]);

      assert.equal(harness.createdAgentActivities.length, 1);
      assert.equal(harness.commands.length, 1);
      const command = harness.commands.find((entry) => entry.type === "thread.turn.start");
      if (command?.type !== "thread.turn.start" || !command.bootstrap?.prepareWorktree) {
        throw new Error("Expected thread.turn.start command with prepareWorktree");
      }

      assert.equal(command.bootstrap.prepareWorktree.projectCwd, "/tmp/backend");
      assert.equal(command.bootstrap.prepareWorktree.baseBranch, "develop");
      assert.equal(
        command.message.text,
        "new-session:ENG-1:/tmp/backend/feature/eng-1-fix-linear-webhook-parity",
      );
      assert.equal(harness.registeredSessions[0]?.linearSessionId, "linear-session-select");
    }),
  );

  it.effect(
    "falls back to the first configured repository when the prompted reply ignores selection",
    () =>
      Effect.gen(function* () {
        const harness = makeHandlerLayer({
          readModel: makeReadModel([]),
          mappings: [
            {
              workspaceRoot: "/tmp/frontend",
              routeKey: "frontend",
              teamKey: "ENG",
              baseBranch: "main",
            },
            {
              workspaceRoot: "/tmp/backend",
              routeKey: "backend",
              teamKey: "ENG",
              baseBranch: "develop",
            },
          ],
        });

        yield* runWebhookSequence(harness.layer, [
          makeCreatedPayload("linear-session-select"),
          makePromptedPayload("please just take a look", "linear-session-select"),
        ]);

        assert.equal(harness.commands.length, 1);
        const command = harness.commands.find((entry) => entry.type === "thread.turn.start");
        if (command?.type !== "thread.turn.start" || !command.bootstrap?.prepareWorktree) {
          throw new Error("Expected thread.turn.start command with prepareWorktree");
        }

        assert.equal(command.bootstrap.prepareWorktree.projectCwd, "/tmp/frontend");
        assert.equal(command.bootstrap.prepareWorktree.baseBranch, "main");
        assert.equal(
          command.message.text,
          "new-session:ENG-1:/tmp/frontend/feature/eng-1-fix-linear-webhook-parity",
        );
      }),
  );

  it.effect("prunes stale prompted mappings and continues the newest live thread", () =>
    Effect.gen(function* () {
      const staleSession: LinearSessionRow = {
        linearSessionId: "linear-session-stale",
        threadId: staleThreadId,
        projectId: defaultProjectId,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        createdAt: "2026-04-05T12:10:00.000Z",
      };
      const liveSession: LinearSessionRow = {
        linearSessionId: "linear-session-live",
        threadId: activeThreadId,
        projectId: defaultProjectId,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        createdAt: "2026-04-05T12:00:00.000Z",
      };

      const harness = makeHandlerLayer({
        readModel: makeReadModel([makeThread(activeThreadId)]),
        issueSessions: [staleSession, liveSession],
      });

      yield* runWebhook(harness.layer, makePromptedPayload("continue working"));

      assert.deepEqual(harness.removedSessionIds, ["linear-session-stale"]);
      assert.equal(harness.commands.length, 1);
      assert.equal(harness.commands[0]?.type, "thread.turn.start");

      const command = harness.commands[0];
      if (command?.type !== "thread.turn.start") {
        throw new Error("Expected thread.turn.start command");
      }

      assert.equal(command.threadId, activeThreadId);
      assert.equal(
        command.message.text,
        "continuation:Bob Jones:2026-04-05T12:00:00.000Z:continue working",
      );
      assert.equal(command.systemPromptPrefix, undefined);
    }),
  );

  it.effect("treats plain-text prompted stop requests as stop commands", () =>
    Effect.gen(function* () {
      const liveSession: LinearSessionRow = {
        linearSessionId: "linear-session-active",
        threadId: activeThreadId,
        projectId: defaultProjectId,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        createdAt: "2026-04-05T12:00:00.000Z",
      };

      const harness = makeHandlerLayer({
        readModel: makeReadModel([makeThread(activeThreadId)]),
        issueSessions: [liveSession],
        sessionLookup: liveSession,
      });

      yield* runWebhook(harness.layer, makePromptedPayload("stop working"));

      assert.deepEqual(harness.createdAgentActivities, [
        {
          agentSessionId: "linear-session-active",
          content: {
            type: "response",
            body: "Stopping work on this issue at your request.",
          },
          ephemeral: false,
        },
      ]);
      assert.deepEqual(
        harness.commands.map((command) => command.type),
        ["thread.turn.interrupt", "thread.session.stop"],
      );
    }),
  );

  it.effect("stops active sessions when Linear moves the issue into a terminal state", () =>
    Effect.gen(function* () {
      const liveSession: LinearSessionRow = {
        linearSessionId: "linear-session-active",
        threadId: activeThreadId,
        projectId: defaultProjectId,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        createdAt: "2026-04-05T12:00:00.000Z",
      };

      const harness = makeHandlerLayer({
        readModel: makeReadModel([makeThread(activeThreadId)]),
        issueSessions: [liveSession],
        issueState: {
          id: "state-done",
          name: "Done",
          type: "completed",
        },
      });

      yield* runWebhook(
        harness.layer,
        makeIssueUpdatePayload({
          updatedFrom: {
            stateId: "state-started",
          },
        }),
      );

      assert.deepEqual(harness.createdAgentActivities, [
        {
          agentSessionId: "linear-session-active",
          content: {
            type: "response",
            body: "Stopping work because the issue moved to 'Done'.",
          },
          ephemeral: false,
        },
      ]);
      assert.deepEqual(
        harness.commands.map((command) => command.type),
        ["thread.turn.interrupt", "thread.session.stop"],
      );
    }),
  );

  it.effect("posts a final response before stopping unassigned sessions", () =>
    Effect.gen(function* () {
      const liveSession: LinearSessionRow = {
        linearSessionId: "linear-session-active",
        threadId: activeThreadId,
        projectId: defaultProjectId,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        createdAt: "2026-04-05T12:00:00.000Z",
      };

      const harness = makeHandlerLayer({
        readModel: makeReadModel([makeThread(activeThreadId)]),
        issueSessions: [liveSession],
      });

      yield* runWebhook(harness.layer, makeUnassignedPayload());

      assert.deepEqual(harness.createdAgentActivities, [
        {
          agentSessionId: "linear-session-active",
          content: {
            type: "response",
            body: "Stopping work because this issue was unassigned from me.",
          },
          ephemeral: false,
        },
      ]);
      assert.deepEqual(
        harness.commands.map((command) => command.type),
        ["thread.turn.interrupt", "thread.session.stop"],
      );
    }),
  );

  it.effect("turns issue description edits into a follow-up prompt for the live thread", () =>
    Effect.gen(function* () {
      const liveSession: LinearSessionRow = {
        linearSessionId: "linear-session-active",
        threadId: activeThreadId,
        projectId: defaultProjectId,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        createdAt: "2026-04-05T12:00:00.000Z",
      };

      const harness = makeHandlerLayer({
        readModel: makeReadModel([makeThread(activeThreadId)]),
        issueSessions: [liveSession],
      });

      yield* runWebhook(
        harness.layer,
        makeIssueUpdatePayload({
          updatedFrom: {
            description: "Old description",
          },
        }),
      );

      assert.equal(harness.commands.length, 1);
      const command = harness.commands[0];
      if (command?.type !== "thread.turn.start") {
        throw new Error("Expected thread.turn.start command");
      }

      assert.equal(command.threadId, activeThreadId);
      assert.equal(command.message.text, "issue-update:ENG-1");
      assert.equal(command.systemPromptPrefix, "SYSTEM:builder");
    }),
  );
});
