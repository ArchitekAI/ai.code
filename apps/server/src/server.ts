import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./config";
import {
  attachmentsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  staticAndDevRouteLayer,
} from "./http";
import { linearWebhookRouteLayer } from "./linear/Layers/LinearWebhookRoute";
import { fixPath } from "./os-jank";
import { websocketRpcRouteLayer } from "./ws";
import { OpenLive } from "./open";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { makeClaudeAdapterLive } from "./provider/Layers/ClaudeAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { RoutingTextGenerationLive } from "./git/Layers/RoutingTextGeneration";
import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { GitManagerLive } from "./git/Layers/GitManager";
import { KeybindingsLive } from "./keybindings";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { BootstrapTurnServiceLive } from "./orchestration/Layers/BootstrapTurnService";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry";
import { ServerSettingsLive } from "./serverSettings";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths";
import { ProjectSetupScriptRunnerLive } from "./project/Layers/ProjectSetupScriptRunner";
import { LinearActivitySinkLive } from "./linear/Layers/LinearActivitySink";
import { LinearClientLive } from "./linear/Layers/LinearClient";
import { LinearPromptAssemblerLive } from "./linear/Layers/LinearPromptAssembler";
import { LinearSessionRegistryLive } from "./linear/Layers/LinearSessionRegistry";
import { LinearWebhookHandlerLive } from "./linear/Layers/LinearWebhookHandler";
import { ObservabilityLive } from "./observability/Layers/Observability";
import { McpContextRegistryLive } from "./mcp/Layers/McpContextRegistry";
import { ThreadRelationshipRegistryLive } from "./mcp/Layers/ThreadRelationshipRegistry";
import { ChildCompletionReactorLive } from "./mcp/Layers/ChildCompletionReactor";
import { mcpToolsRouteLayer } from "./mcp/Layers/McpToolsRoute";
import { mcpDocsRouteLayer } from "./mcp/Layers/McpDocsRoute";
import { ToolPolicyResolverLive } from "./provider/Layers/ToolPolicyResolver";

const PtyAdapterLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const BunPTY = yield* Effect.promise(() => import("./terminal/Layers/BunPTY"));
      return BunPTY.layer;
    } else {
      const NodePTY = yield* Effect.promise(() => import("./terminal/Layers/NodePTY"));
      return NodePTY.layer;
    }
  }),
);

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        ...(config.host ? { hostname: config.host } : {}),
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      return NodeHttpServer.layer(NodeHttp.createServer, {
        host: config.host,
        port: config.port,
      });
    }
  }),
);

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(LinearActivitySinkLive),
  Layer.provideMerge(ChildCompletionReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
);

const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(CheckpointStoreLive),
);

const ProviderLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig;
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    return makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(providerSessionDirectoryLayer));
  }),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const OrchestrationRuntimeLive = OrchestrationLayerLive.pipe(
  // Projection repositories and event storage are all SQLite-backed.
  Layer.provide(PersistenceLayerLive),
);

const CheckpointingRuntimeLive = CheckpointingLayerLive.pipe(
  // Checkpoint queries and stores persist through SQLite as well.
  Layer.provide(PersistenceLayerLive),
);

const LinearSessionRegistryRuntimeLive = LinearSessionRegistryLive.pipe(
  // Linear session mappings live in the same SQLite database as the rest of the server state.
  Layer.provide(PersistenceLayerLive),
);

const ThreadRelationshipRegistryRuntimeLive = ThreadRelationshipRegistryLive.pipe(
  // Parent-child relationships are persisted so webhook delivery can reconnect sessions.
  Layer.provide(PersistenceLayerLive),
);

const TerminalLayerLive = TerminalManagerLive.pipe(Layer.provide(PtyAdapterLive));

const ProjectSetupScriptRuntimeLive = ProjectSetupScriptRunnerLive.pipe(
  // The setup runner needs both thread/project state and a live terminal to launch scripts.
  Layer.provide(TerminalLayerLive),
  Layer.provide(OrchestrationRuntimeLive),
);

const GitManagerRuntimeLive = GitManagerLive.pipe(
  // Build GitManager against the fully provisioned git/setup services instead of leaking them.
  Layer.provide(ProjectSetupScriptRuntimeLive),
  Layer.provide(GitCoreLive),
  Layer.provide(GitHubCliLive),
  Layer.provide(RoutingTextGenerationLive),
  Layer.provide(ServerSettingsLive),
);

const GitLayerLive = Layer.mergeAll(
  GitCoreLive,
  GitHubCliLive,
  RoutingTextGenerationLive,
  ProjectSetupScriptRuntimeLive,
  GitManagerRuntimeLive,
);

const BootstrapTurnRuntimeLive = BootstrapTurnServiceLive.pipe(
  // Bootstrap dispatch depends on git worktrees, setup scripts, and orchestration dispatch.
  Layer.provide(Layer.mergeAll(GitLayerLive, OrchestrationRuntimeLive)),
);

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive)),
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  ),
);

const RuntimeDependenciesLive = ReactorLayerLive.pipe(
  // Core Services
  Layer.provideMerge(CheckpointingRuntimeLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(OrchestrationRuntimeLive),
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(TerminalLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(KeybindingsLive),
  Layer.provideMerge(BootstrapTurnRuntimeLive),
  Layer.provideMerge(LinearClientLive),
  Layer.provideMerge(LinearPromptAssemblerLive),
  Layer.provideMerge(LinearSessionRegistryRuntimeLive),
  Layer.provideMerge(McpContextRegistryLive),
  Layer.provideMerge(ThreadRelationshipRegistryRuntimeLive),
  Layer.provideMerge(ToolPolicyResolverLive),
  Layer.provideMerge(ProviderRegistryLive),
  Layer.provideMerge(ServerSettingsLive),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
).pipe(
  // Misc.
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
);

const RuntimeServicesBaseLive = ServerRuntimeStartupLive.pipe(
  Layer.provideMerge(RuntimeDependenciesLive),
);

const RuntimeServicesLive = Layer.mergeAll(
  RuntimeServicesBaseLive,
  // Build the webhook handler only after the startup/runtime services exist to avoid leaking its deps.
  LinearWebhookHandlerLive.pipe(Layer.provide(RuntimeServicesBaseLive)),
);

export const makeRoutesLayer = Layer.mergeAll(
  attachmentsRouteLayer,
  linearWebhookRouteLayer,
  mcpDocsRouteLayer,
  mcpToolsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  websocketRpcRouteLayer,
  staticAndDevRouteLayer,
);

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    fixPath();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );

    const serverApplicationLayer = Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
      }),
      httpListeningLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provide(RuntimeServicesLive),
      Layer.provide(HttpServerLive),
      Layer.provide(ObservabilityLive),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(PlatformServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = Layer.launch(makeServerLayer) satisfies Effect.Effect<
  never,
  any,
  ServerConfig
>;
