import fs from "node:fs/promises";

import {
  type CanUseTool,
  type ElicitationRequest,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  query,
  type SDKAssistantMessage,
  type SDKElicitationCompleteMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderUserInputAnswers,
  ProviderItemId,
  type UserInputQuestion,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@repo/contracts";
import { DateTime, Deferred, Effect, Exit, Layer, Queue, Random, Ref, Scope, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  resolveClaudeRuntimeModel,
  shouldEnableClaudeFineGrainedToolStreaming,
} from "../claudeRuntimeModel.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";

const PROVIDER = "claudeCode" as const;

type PromptQueueItem = { readonly type: "message"; readonly message: SDKUserMessage };

interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly assistantItemId: string;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  fallbackAssistantText: string;
  emittedTextDelta: boolean;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly mode?: "form" | "url";
  readonly decision: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: Query;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  turnState: ClaudeTurnState | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  stopped: boolean;
}

export interface ClaudeCodeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => Query;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly stateDir?: string;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }

  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId = threadIdCandidate ? ThreadId.makeUnsafe(threadIdCandidate) : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCount =
    typeof cursor.turnCount === "number" &&
    Number.isInteger(cursor.turnCount) &&
    cursor.turnCount >= 0
      ? cursor.turnCount
      : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
  };
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  const normalized = toolName.toLowerCase();
  if (normalized === "read" || normalized.includes("read file") || normalized.includes("view")) {
    return "file_read_approval";
  }
  return classifyToolItemType(toolName) === "command_execution"
    ? "command_execution_approval"
    : "file_change_approval";
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  return serialized.length <= 400
    ? `${toolName}: ${serialized}`
    : `${toolName}: ${serialized.slice(0, 397)}...`;
}

function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

function turnStatusFromResult(
  result: SDKResultMessage,
): "completed" | "failed" | "interrupted" | "cancelled" {
  if (result.subtype === "success") {
    return "completed";
  }

  const errorText = result.errors.join(" ").toLowerCase();
  if (errorText.includes("interrupt")) {
    return "interrupted";
  }
  if (errorText.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function streamKindFromDeltaType(deltaType: string): "assistant_text" | "reasoning_text" {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function providerThreadRef(_context: ClaudeSessionContext): {} {
  return {};
}

function extractAssistantText(message: SDKAssistantMessage | SDKUserMessageReplay): string {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return "";
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      fragments.push(candidate.text);
    }
  }
  return fragments.join("");
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("session not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }
  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType === "content_block_delta") {
      const deltaType = sdkMessageType((message.event as { delta?: unknown }).delta);
      return deltaType
        ? `claude/${message.type}/${streamType}/${deltaType}`
        : `claude/${message.type}/${streamType}`;
    }
    if (streamType) {
      return `claude/${message.type}/${streamType}`;
    }
  }
  return `claude/${message.type}`;
}

function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    return typeof maybeId === "string" ? maybeId : undefined;
  }
  if (message.type === "stream_event") {
    const event = message.event as { type?: unknown; content_block?: { id?: unknown } };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }
  return undefined;
}

function toPermissionMode(runtimeMode: ProviderSession["runtimeMode"]): PermissionMode {
  return runtimeMode === "full-access" ? "bypassPermissions" : "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toQuestionHeader(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 40) : "Input";
}

function toQuestionOptions(value: unknown): ReadonlyArray<{ label: string; description: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, 9)
    .map((entry) => ({
      label: entry.trim(),
      description: `Use '${entry.trim()}'.`,
    }));
}

function questionsFromElicitation(request: ElicitationRequest): ReadonlyArray<UserInputQuestion> {
  if (request.mode === "url") {
    return [
      {
        id: "action",
        header: toQuestionHeader(request.serverName),
        question: request.message.trim() || `Continue ${request.serverName} authentication?`,
        options: [
          {
            label: "Continue",
            description: "Continue this authentication flow.",
          },
          {
            label: "Cancel",
            description: "Cancel this authentication flow.",
          },
        ],
      },
    ];
  }

  const properties = isRecord(request.requestedSchema)
    ? (request.requestedSchema.properties as Record<string, unknown> | undefined)
    : undefined;
  if (properties) {
    const questions = Object.entries(properties)
      .map(([id, value]) => {
        if (!isRecord(value)) {
          return null;
        }
        const title =
          typeof value.title === "string" && value.title.trim().length > 0
            ? value.title.trim()
            : id;
        const question =
          typeof value.description === "string" && value.description.trim().length > 0
            ? value.description.trim()
            : request.message.trim() || `Provide ${title}.`;
        return {
          id,
          header: toQuestionHeader(title),
          question,
          options: toQuestionOptions(value.enum),
        } satisfies UserInputQuestion;
      })
      .filter((question): question is UserInputQuestion => question !== null);
    if (questions.length > 0) {
      return questions;
    }
  }

  return [
    {
      id: "response",
      header: toQuestionHeader(request.serverName),
      question: request.message.trim() || "Provide the requested input.",
      options: [],
    },
  ];
}

function isAcceptedAnswer(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "cancel" && normalized !== "decline";
}

function buildElicitationResult(
  request: ElicitationRequest,
  answers: ProviderUserInputAnswers,
): { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } {
  if (request.mode === "url") {
    return isAcceptedAnswer(typeof answers.action === "string" ? answers.action : undefined)
      ? { action: "accept" }
      : { action: "cancel" };
  }

  if (Object.keys(answers).length === 0) {
    return { action: "cancel" };
  }

  return {
    action: "accept",
    content: answers,
  };
}

function makeClaudeCodeAdapter(options?: ClaudeCodeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const createQuery =
      options?.createQuery ??
      ((input: {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }) => query({ prompt: input.prompt, options: input.options }));

    const stateDir = options?.stateDir;
    const driverScope = yield* Scope.make();
    const sessions = new Map<ThreadId, ClaudeSessionContext>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (value) => EventId.makeUnsafe(value));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const logNativeSdkMessage = (context: ClaudeSessionContext, message: SDKMessage) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) {
          return;
        }
        const itemId = sdkNativeItemId(message);
        yield* nativeEventLogger.write(
          {
            observedAt: yield* nowIso,
            event: {
              id:
                "uuid" in message && typeof message.uuid === "string"
                  ? message.uuid
                  : crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: yield* nowIso,
              method: sdkNativeMethod(message),
              ...(context.resumeSessionId ? { providerThreadId: context.resumeSessionId } : {}),
              ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
              payload: message,
            },
          },
          context.session.threadId,
        );
      });

    const snapshotThread = (context: ClaudeSessionContext) =>
      Effect.succeed({
        threadId: context.session.threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      });

    const updateResumeCursor = (context: ClaudeSessionContext) =>
      Effect.gen(function* () {
        context.session = {
          ...context.session,
          resumeCursor: {
            threadId: context.session.threadId,
            ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
            ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
            turnCount: context.turns.length,
          },
          updatedAt: yield* nowIso,
        };
      });

    const ensureThreadStarted = (context: ClaudeSessionContext, message: SDKMessage) =>
      Effect.gen(function* () {
        if (typeof message.session_id !== "string" || message.session_id.length === 0) {
          return;
        }
        context.resumeSessionId = message.session_id;
        yield* updateResumeCursor(context);

        if (context.lastThreadStartedId === message.session_id) {
          return;
        }
        context.lastThreadStartedId = message.session_id;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "thread.started",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          payload: {
            providerThreadId: message.session_id,
          },
          providerRefs: providerThreadRef(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/thread/started",
            payload: { session_id: message.session_id },
          },
        });
      });

    const emitRuntimeWarning = (context: ClaudeSessionContext, message: string, detail?: unknown) =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.warning",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          payload: {
            message,
            ...(detail !== undefined ? { detail } : {}),
          },
          providerRefs: {
            ...providerThreadRef(context),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
          },
        });
      });

    const emitRuntimeError = (context: ClaudeSessionContext, message: string, detail?: unknown) =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.error",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          payload: {
            message,
            class: "provider_error",
            ...(detail !== undefined ? { detail } : {}),
          },
          providerRefs: {
            ...providerThreadRef(context),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
          },
        });
      });

    const completeTurn = (
      context: ClaudeSessionContext,
      status: "completed" | "failed" | "interrupted" | "cancelled",
      errorMessage?: string,
      result?: SDKResultMessage,
    ) =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();

        if (turnState) {
          if (!turnState.emittedTextDelta && turnState.fallbackAssistantText.length > 0) {
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              turnId: turnState.turnId,
              itemId: asRuntimeItemId(turnState.assistantItemId),
              payload: {
                streamKind: "assistant_text",
                delta: turnState.fallbackAssistantText,
              },
              providerRefs: {
                ...providerThreadRef(context),
                providerTurnId: turnState.turnId,
                providerItemId: ProviderItemId.makeUnsafe(turnState.assistantItemId),
              },
            });
          }

          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            provider: PROVIDER,
            createdAt: yield* nowIso,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            itemId: asRuntimeItemId(turnState.assistantItemId),
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
            },
            providerRefs: {
              ...providerThreadRef(context),
              providerTurnId: turnState.turnId,
              providerItemId: ProviderItemId.makeUnsafe(turnState.assistantItemId),
            },
          });

          context.turns.push({
            id: turnState.turnId,
            items: [...turnState.items],
          });
        }

        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
          provider: PROVIDER,
          createdAt: yield* nowIso,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: turnState.turnId } : {}),
          payload: {
            state: status,
            ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
            ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
            ...(typeof result?.total_cost_usd === "number"
              ? { totalCostUsd: result.total_cost_usd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
          providerRefs: {
            ...providerThreadRef(context),
            ...(turnState ? { providerTurnId: turnState.turnId } : {}),
          },
        });

        context.turnState = undefined;
        context.session = {
          ...context.session,
          status: status === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
          ...(errorMessage ? { lastError: errorMessage } : {}),
        };
        yield* updateResumeCursor(context);
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
          provider: PROVIDER,
          createdAt: yield* nowIso,
          threadId: context.session.threadId,
          payload: {
            state: status === "failed" ? "error" : "ready",
            ...(errorMessage ? { reason: errorMessage } : {}),
          },
          providerRefs: providerThreadRef(context),
        });
      });

    const requireSession = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const buildUserMessage = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const content: Array<Record<string, unknown>> = [];

        if (input.input && input.input.trim().length > 0) {
          content.push({
            type: "text",
            text: input.input.trim(),
          });
        }

        for (const attachment of input.attachments ?? []) {
          if (!stateDir) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Claude attachments require a configured server state directory.",
            });
          }
          const attachmentPath = resolveAttachmentPath({
            stateDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Attachment path could not be resolved for '${attachment.name}'.`,
            });
          }

          if (attachment.type === "text") {
            const text = yield* Effect.tryPromise({
              try: () => fs.readFile(attachmentPath, "utf8"),
              catch: (cause) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: `Failed to read attachment '${attachment.name}': ${toMessage(cause, "unknown error")}`,
                  cause,
                }),
            });
            content.push({
              type: "text",
              text: `Attachment: ${attachment.name}\n\n${text}`,
            });
            continue;
          }

          const bytes = yield* Effect.tryPromise({
            try: () => fs.readFile(attachmentPath),
            catch: (cause) =>
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Failed to read image attachment '${attachment.name}': ${toMessage(cause, "unknown error")}`,
                cause,
              }),
          });
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: attachment.mimeType,
              data: bytes.toString("base64"),
            },
          });
        }

        if (content.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Claude turns require input text or at least one attachment.",
          });
        }

        return {
          type: "user",
          session_id: "",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content,
          } as SDKUserMessage["message"],
        } satisfies SDKUserMessage;
      });

    const stopSessionInternal = (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ) =>
      Effect.gen(function* () {
        if (context.stopped) {
          return;
        }
        context.stopped = true;

        for (const [requestId, pending] of context.pendingApprovals) {
          yield* Deferred.succeed(pending.decision, "cancel");
          yield* offerRuntimeEvent({
            type: "request.resolved",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            provider: PROVIDER,
            createdAt: yield* nowIso,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType: pending.requestType,
              decision: "cancel",
            },
            providerRefs: {
              ...providerThreadRef(context),
              ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
              providerRequestId: requestId,
            },
          });
        }
        context.pendingApprovals.clear();

        for (const [, pending] of context.pendingUserInputs) {
          yield* Deferred.succeed(pending.decision, {});
        }
        context.pendingUserInputs.clear();

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.");
        }

        context.query.close();
        yield* Queue.shutdown(context.promptQueue);

        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
        };

        if (options?.emitExitEvent !== false) {
          yield* offerRuntimeEvent({
            type: "session.exited",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            provider: PROVIDER,
            createdAt: yield* nowIso,
            threadId: context.session.threadId,
            payload: {
              reason: "Session stopped",
              exitKind: "graceful",
            },
            providerRefs: providerThreadRef(context),
          });
        }

        sessions.delete(context.session.threadId);
      });

    const handleToolUsePermission = (
      contextRef: Ref.Ref<ClaudeSessionContext | undefined>,
      runtimeMode: ProviderSession["runtimeMode"],
    ): CanUseTool => {
      return (toolName, toolInput, callbackOptions) =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (runtimeMode === "full-access") {
              return {
                behavior: "allow",
                updatedInput: toolInput,
              } satisfies PermissionResult;
            }

            const context = yield* Ref.get(contextRef);
            if (!context) {
              return {
                behavior: "deny",
                message: "Claude session context is unavailable.",
              } satisfies PermissionResult;
            }

            const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
            const requestType = classifyRequestType(toolName);
            const detail = summarizeToolRequest(toolName, toolInput);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();

            context.pendingApprovals.set(requestId, {
              requestType,
              detail,
              ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
              decision,
            });

            yield* offerRuntimeEvent({
              type: "request.opened",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              provider: PROVIDER,
              createdAt: yield* nowIso,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: {
                requestType,
                detail,
                args: {
                  toolName,
                  input: toolInput,
                  ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
                },
              },
              providerRefs: {
                ...providerThreadRef(context),
                ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
                providerRequestId: requestId,
              },
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/request",
                payload: {
                  toolName,
                  input: toolInput,
                },
              },
            });

            const resolved = yield* Deferred.await(decision);
            context.pendingApprovals.delete(requestId);

            yield* offerRuntimeEvent({
              type: "request.resolved",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              provider: PROVIDER,
              createdAt: yield* nowIso,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: {
                requestType,
                decision: resolved,
              },
              providerRefs: {
                ...providerThreadRef(context),
                ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
                providerRequestId: requestId,
              },
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/decision",
                payload: {
                  decision: resolved,
                },
              },
            });

            if (resolved === "accept" || resolved === "acceptForSession") {
              return {
                behavior: "allow",
                updatedInput: toolInput,
                ...(resolved === "acceptForSession" && callbackOptions.suggestions
                  ? { updatedPermissions: [...callbackOptions.suggestions] }
                  : {}),
              } satisfies PermissionResult;
            }

            return {
              behavior: "deny",
              message:
                resolved === "cancel"
                  ? "User cancelled tool execution."
                  : "User declined tool execution.",
            } satisfies PermissionResult;
          }),
        );
    };

    const handleElicitation = (contextRef: Ref.Ref<ClaudeSessionContext | undefined>) => {
      return (request: ElicitationRequest, _options: { signal: AbortSignal }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const context = yield* Ref.get(contextRef);
            if (!context) {
              return { action: "cancel" } as const;
            }

            const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
            const questions = questionsFromElicitation(request);
            const decision = yield* Deferred.make<ProviderUserInputAnswers>();

            context.pendingUserInputs.set(requestId, {
              questions,
              ...(request.mode ? { mode: request.mode } : {}),
              decision,
            });

            yield* offerRuntimeEvent({
              type: "user-input.requested",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              provider: PROVIDER,
              createdAt: yield* nowIso,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: {
                questions,
              },
              providerRefs: {
                ...providerThreadRef(context),
                ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
                providerRequestId: requestId,
              },
            });

            const answers = yield* Deferred.await(decision);
            context.pendingUserInputs.delete(requestId);

            yield* offerRuntimeEvent({
              type: "user-input.resolved",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              provider: PROVIDER,
              createdAt: yield* nowIso,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: {
                answers,
              },
              providerRefs: {
                ...providerThreadRef(context),
                ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
                providerRequestId: requestId,
              },
            });

            return buildElicitationResult(request, answers);
          }),
        );
    };

    const handleStreamEvent = (context: ClaudeSessionContext, message: SDKMessage) =>
      Effect.gen(function* () {
        if (message.type !== "stream_event") {
          return;
        }

        const event = message.event as {
          type?: string;
          delta?: { type?: string; text?: string };
          index?: number;
          content_block?: {
            type?: string;
            name?: string;
            id?: string;
            input?: unknown;
          };
        };

        if (
          event.type === "content_block_delta" &&
          event.delta?.type &&
          typeof event.delta.text === "string" &&
          event.delta.text.length > 0 &&
          context.turnState
        ) {
          context.turnState.emittedTextDelta = true;
          yield* offerRuntimeEvent({
            type: "content.delta",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            provider: PROVIDER,
            createdAt: yield* nowIso,
            threadId: context.session.threadId,
            turnId: context.turnState.turnId,
            itemId: asRuntimeItemId(context.turnState.assistantItemId),
            payload: {
              streamKind: streamKindFromDeltaType(event.delta.type),
              delta: event.delta.text,
            },
            providerRefs: {
              ...providerThreadRef(context),
              providerTurnId: context.turnState.turnId,
              providerItemId: ProviderItemId.makeUnsafe(context.turnState.assistantItemId),
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_delta",
              payload: message,
            },
          });
          return;
        }

        if (
          event.type === "content_block_start" &&
          typeof event.index === "number" &&
          event.content_block &&
          typeof event.content_block.name === "string" &&
          typeof event.content_block.id === "string" &&
          (event.content_block.type === "tool_use" ||
            event.content_block.type === "server_tool_use" ||
            event.content_block.type === "mcp_tool_use")
        ) {
          const toolInput = isRecord(event.content_block.input) ? event.content_block.input : {};
          const itemType = classifyToolItemType(event.content_block.name);
          const tool: ToolInFlight = {
            itemId: event.content_block.id,
            itemType,
            toolName: event.content_block.name,
            title: titleForTool(itemType),
            detail: summarizeToolRequest(event.content_block.name, toolInput),
          };
          context.inFlightTools.set(event.index, tool);

          yield* offerRuntimeEvent({
            type: "item.started",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            provider: PROVIDER,
            createdAt: yield* nowIso,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: {
                toolName: tool.toolName,
                input: toolInput,
              },
            },
            providerRefs: {
              ...providerThreadRef(context),
              ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
              providerItemId: ProviderItemId.makeUnsafe(tool.itemId),
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_start",
              payload: message,
            },
          });
          return;
        }

        if (event.type === "content_block_stop" && typeof event.index === "number") {
          const tool = context.inFlightTools.get(event.index);
          if (!tool) {
            return;
          }
          context.inFlightTools.delete(event.index);
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            provider: PROVIDER,
            createdAt: yield* nowIso,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: "completed",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
            },
            providerRefs: {
              ...providerThreadRef(context),
              ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
              providerItemId: ProviderItemId.makeUnsafe(tool.itemId),
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_stop",
              payload: message,
            },
          });
        }
      });

    const handleAssistantMessage = (context: ClaudeSessionContext, message: SDKMessage) =>
      Effect.gen(function* () {
        if (message.type !== "assistant") {
          return;
        }
        if (context.turnState) {
          context.turnState.items.push(message.message);
          const fallbackAssistantText = extractAssistantText(message);
          if (
            fallbackAssistantText.length > 0 &&
            fallbackAssistantText !== context.turnState.fallbackAssistantText
          ) {
            context.turnState.fallbackAssistantText = fallbackAssistantText;
          }

          yield* offerRuntimeEvent({
            type: "item.updated",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            provider: PROVIDER,
            createdAt: yield* nowIso,
            threadId: context.session.threadId,
            turnId: context.turnState.turnId,
            itemId: asRuntimeItemId(context.turnState.assistantItemId),
            payload: {
              itemType: "assistant_message",
              status: "inProgress",
              title: "Assistant message",
              data: message.message,
            },
            providerRefs: {
              ...providerThreadRef(context),
              providerTurnId: context.turnState.turnId,
              providerItemId: ProviderItemId.makeUnsafe(context.turnState.assistantItemId),
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/assistant",
              payload: message,
            },
          });
        }
        context.lastAssistantUuid = message.uuid;
        yield* updateResumeCursor(context);
      });

    const handleSystemMessage = (context: ClaudeSessionContext, message: SDKMessage) =>
      Effect.gen(function* () {
        if (message.type !== "system") {
          return;
        }

        const base = {
          provider: PROVIDER,
          createdAt: yield* nowIso,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          providerRefs: {
            ...providerThreadRef(context),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
          },
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          },
        };

        switch (message.subtype) {
          case "init":
            yield* offerRuntimeEvent({
              ...base,
              type: "session.configured",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              payload: {
                config: message as Record<string, unknown>,
              },
            });
            return;
          case "status":
            yield* offerRuntimeEvent({
              ...base,
              type: "session.state.changed",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              payload: {
                state: message.status === "compacting" ? "waiting" : "running",
                reason: `status:${message.status ?? "active"}`,
                detail: message,
              },
            });
            return;
          case "compact_boundary":
            yield* offerRuntimeEvent({
              ...base,
              type: "thread.state.changed",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              payload: {
                state: "compacted",
                detail: message,
              },
            });
            return;
          case "task_started":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.started",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.task_type ? { taskType: message.task_type } : {}),
              },
            });
            return;
          case "task_progress":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.progress",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
              },
            });
            return;
          case "task_notification":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.completed",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                status: message.status,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
              },
            });
            return;
          case "files_persisted":
            yield* offerRuntimeEvent({
              ...base,
              type: "files.persisted",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              payload: {
                files: Array.isArray(message.files)
                  ? message.files.map((file) => ({
                      filename: file.filename,
                      fileId: file.file_id,
                    }))
                  : [],
                ...(Array.isArray(message.failed)
                  ? {
                      failed: message.failed.map((entry) => ({
                        filename: entry.filename,
                        error: entry.error,
                      })),
                    }
                  : {}),
              },
            });
            return;
          default:
            if (message.subtype === "elicitation_complete") {
              const elicitationComplete = message as SDKElicitationCompleteMessage;
              yield* emitRuntimeWarning(
                context,
                `Claude elicitation '${elicitationComplete.elicitation_id}' completed.`,
                message,
              );
              return;
            }
            yield* emitRuntimeWarning(
              context,
              `Unhandled Claude system message subtype '${message.subtype}'.`,
              message,
            );
        }
      });

    const handleTelemetryMessage = (context: ClaudeSessionContext, message: SDKMessage) =>
      Effect.gen(function* () {
        const base = {
          provider: PROVIDER,
          createdAt: yield* nowIso,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          providerRefs: {
            ...providerThreadRef(context),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
          },
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: message.type,
            payload: message,
          },
        };

        if (message.type === "tool_progress") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.progress",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            payload: {
              toolUseId: message.tool_use_id,
              toolName: message.tool_name,
              elapsedSeconds: message.elapsed_time_seconds,
              ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
            },
          });
          return;
        }

        if (message.type === "tool_use_summary") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.summary",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            payload: {
              summary: message.summary,
              ...(message.preceding_tool_use_ids.length > 0
                ? { precedingToolUseIds: message.preceding_tool_use_ids }
                : {}),
            },
          });
          return;
        }

        if (message.type === "auth_status") {
          yield* offerRuntimeEvent({
            ...base,
            type: "auth.status",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            payload: {
              isAuthenticating: message.isAuthenticating,
              output: message.output,
              ...(message.error ? { error: message.error } : {}),
            },
          });
          return;
        }

        if (message.type === "rate_limit_event") {
          yield* offerRuntimeEvent({
            ...base,
            type: "account.rate-limits.updated",
            eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
            payload: {
              rateLimits: message.rate_limit_info,
            },
          });
          return;
        }
      });

    const handleSdkMessage = (context: ClaudeSessionContext, message: SDKMessage) =>
      Effect.gen(function* () {
        yield* logNativeSdkMessage(context, message);
        yield* ensureThreadStarted(context, message);

        switch (message.type) {
          case "stream_event":
            yield* handleStreamEvent(context, message);
            return;
          case "assistant":
            yield* handleAssistantMessage(context, message);
            return;
          case "result":
            yield* completeTurn(
              context,
              turnStatusFromResult(message),
              message.subtype === "success" ? undefined : message.errors[0],
              message,
            );
            return;
          case "system":
            yield* handleSystemMessage(context, message);
            return;
          case "tool_progress":
          case "tool_use_summary":
          case "auth_status":
          case "rate_limit_event":
            yield* handleTelemetryMessage(context, message);
            return;
          case "user":
            return;
          default:
            yield* emitRuntimeWarning(
              context,
              `Unhandled Claude SDK message type '${message.type}'.`,
              message,
            );
        }
      });

    const runSdkStream = (context: ClaudeSessionContext) =>
      Stream.fromAsyncIterable(context.query, (cause) => cause).pipe(
        Stream.takeWhile(() => !context.stopped),
        Stream.runForEach((message) => handleSdkMessage(context, message)),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (context.stopped) {
              return;
            }
            const message = toMessage(cause, "Claude runtime stream failed.");
            context.session = {
              ...context.session,
              status: "error",
              activeTurnId: undefined,
              updatedAt: yield* nowIso,
              lastError: message,
            };
            yield* emitRuntimeError(context, message, cause);
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
              provider: PROVIDER,
              createdAt: yield* nowIso,
              threadId: context.session.threadId,
              payload: {
                state: "error",
                reason: message,
              },
              providerRefs: providerThreadRef(context),
            });
            yield* completeTurn(context, "failed", message);
          }),
        ),
      );

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = yield* nowIso;
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.map((entry) => entry.message),
          Stream.toAsyncIterable,
        );
        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);
        const providerOptions = input.providerOptions?.claudeCode;
        const permissionMode = toPermissionMode(input.runtimeMode);
        const mergedEnv = {
          ...process.env,
          ...providerOptions?.env,
        };
        const enableFineGrainedToolStreaming =
          shouldEnableClaudeFineGrainedToolStreaming(mergedEnv);
        const sdkEnv = enableFineGrainedToolStreaming
          ? mergedEnv
          : {
              ...mergedEnv,
              // Bedrock rejects the eager_input_streaming tool field that Claude Code
              // emits when fine-grained tool streaming is enabled.
              CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "0",
            };
        const runtimeModel = resolveClaudeRuntimeModel(input.model, sdkEnv);

        const queryOptions: ClaudeQueryOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(runtimeModel ? { model: runtimeModel } : {}),
          ...(providerOptions?.binaryPath
            ? { pathToClaudeCodeExecutable: providerOptions.binaryPath }
            : {}),
          permissionMode,
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(resumeState?.resume ? { resume: resumeState.resume } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          includePartialMessages: enableFineGrainedToolStreaming,
          canUseTool: handleToolUsePermission(contextRef, input.runtimeMode),
          onElicitation: handleElicitation(contextRef),
          env: sdkEnv,
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        };

        const runtime = yield* Effect.try({
          try: () => createQuery({ prompt, options: queryOptions }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start Claude runtime session."),
              cause,
            }),
        });

        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          threadId: input.threadId,
          resumeCursor: {
            threadId: input.threadId,
            ...(resumeState?.resume ? { resume: resumeState.resume } : {}),
            ...(resumeState?.resumeSessionAt
              ? { resumeSessionAt: resumeState.resumeSessionAt }
              : {}),
            turnCount: resumeState?.turnCount ?? 0,
          },
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        const context: ClaudeSessionContext = {
          session,
          promptQueue,
          query: runtime,
          resumeSessionId: resumeState?.resume,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          turns: [],
          inFlightTools: new Map(),
          turnState: undefined,
          lastAssistantUuid: resumeState?.resumeSessionAt,
          lastThreadStartedId: undefined,
          stopped: false,
        };
        yield* Ref.set(contextRef, context);
        sessions.set(input.threadId, context);

        yield* offerRuntimeEvent({
          type: "session.started",
          eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
          provider: PROVIDER,
          createdAt: yield* nowIso,
          threadId: input.threadId,
          payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
          providerRefs: providerThreadRef(context),
        });
        yield* offerRuntimeEvent({
          type: "session.configured",
          eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
          provider: PROVIDER,
          createdAt: yield* nowIso,
          threadId: input.threadId,
          payload: {
            config: {
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(input.model ? { model: input.model } : {}),
              permissionMode,
            },
          },
          providerRefs: providerThreadRef(context),
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
          provider: PROVIDER,
          createdAt: yield* nowIso,
          threadId: input.threadId,
          payload: {
            state: "ready",
          },
          providerRefs: providerThreadRef(context),
        });

        yield* runSdkStream(context).pipe(Effect.forkIn(driverScope), Effect.asVoid);

        return { ...session };
      });

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.turnState) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Thread '${input.threadId}' already has an active turn '${context.turnState.turnId}'.`,
          });
        }

        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const turnState: ClaudeTurnState = {
          turnId,
          assistantItemId: yield* Random.nextUUIDv4,
          startedAt: yield* nowIso,
          items: [],
          fallbackAssistantText: "",
          emittedTextDelta: false,
        };
        context.turnState = turnState;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
          provider: PROVIDER,
          createdAt: yield* nowIso,
          threadId: context.session.threadId,
          turnId,
          payload: input.model ? { model: input.model } : {},
          providerRefs: {
            ...providerThreadRef(context),
            providerTurnId: turnId,
          },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: EventId.makeUnsafe(yield* Random.nextUUIDv4),
          provider: PROVIDER,
          createdAt: yield* nowIso,
          threadId: context.session.threadId,
          turnId,
          payload: {
            state: "running",
          },
          providerRefs: {
            ...providerThreadRef(context),
            providerTurnId: turnId,
          },
        });

        const message = yield* buildUserMessage(input);
        yield* Queue.offer(context.promptQueue, { type: "message", message }).pipe(
          Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)),
        );

        return {
          threadId: context.session.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => context.query.interrupt(),
          catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
        });
      });

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return yield* snapshotThread(context);
      });

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: `Claude Code does not support conversation rollback for thread '${threadId}'.`,
        }),
      );

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/requestUserInput",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        context.pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.decision, answers);
      });

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopSessionInternal(context, { emitExitEvent: true });
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions, ([, context]) => stopSessionInternal(context), { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions,
        ([, context]) => stopSessionInternal(context, { emitExitEvent: false }),
        {
          discard: true,
        },
      ).pipe(
        Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
        Effect.tap(() => Scope.close(driverScope, Exit.void)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        conversationRollback: "unsupported",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeCodeAdapterShape;
  });
}

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}
