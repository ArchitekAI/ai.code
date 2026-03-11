import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@repo/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  listWorktreesByProjectId,
  requireActiveWorktree,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadAbsent,
  requireWorktree,
  requireWorktreeAbsent,
} from "./commandInvariants.ts";
import { deriveWorktreeIdFromLegacyThread, rootWorktreeIdForProject } from "./worktrees.ts";

const nowIso = () => new Date().toISOString();
const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered" as const;

const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      const rootWorktreeId = rootWorktreeIdForProject(command.projectId);
      return [
        {
          ...withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "project.created",
          payload: {
            projectId: command.projectId,
            title: command.title,
            workspaceRoot: command.workspaceRoot,
            defaultModel: command.defaultModel ?? null,
            defaultWorktreeBaseBranch: null,
            defaultPullRequestBaseBranch: null,
            pullRequestPromptTemplate: null,
            scripts: [],
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "worktree",
            aggregateId: rootWorktreeId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "worktree.created",
          payload: {
            worktreeId: rootWorktreeId,
            projectId: command.projectId,
            workspacePath: command.workspaceRoot,
            branch: null,
            isRoot: true,
            branchRenamePending: false,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
      ];
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [
        {
          ...withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "project.meta-updated",
          payload: {
            projectId: command.projectId,
            ...(command.title !== undefined ? { title: command.title } : {}),
            ...(command.workspaceRoot !== undefined
              ? { workspaceRoot: command.workspaceRoot }
              : {}),
            ...(command.defaultModel !== undefined ? { defaultModel: command.defaultModel } : {}),
            ...(command.defaultWorktreeBaseBranch !== undefined
              ? { defaultWorktreeBaseBranch: command.defaultWorktreeBaseBranch }
              : {}),
            ...(command.defaultPullRequestBaseBranch !== undefined
              ? { defaultPullRequestBaseBranch: command.defaultPullRequestBaseBranch }
              : {}),
            ...(command.pullRequestPromptTemplate !== undefined
              ? { pullRequestPromptTemplate: command.pullRequestPromptTemplate }
              : {}),
            ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
            updatedAt: occurredAt,
          },
        },
      ];
      if (command.workspaceRoot !== undefined) {
        events.push({
          ...withEventBase({
            aggregateKind: "worktree",
            aggregateId: rootWorktreeIdForProject(command.projectId),
            occurredAt,
            commandId: command.commandId,
          }),
          type: "worktree.meta-updated",
          payload: {
            worktreeId: rootWorktreeIdForProject(command.projectId),
            workspacePath: command.workspaceRoot,
            updatedAt: occurredAt,
          },
        });
      }
      return events.length === 1 ? events[0]! : events;
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const projectWorktrees = listWorktreesByProjectId(readModel, command.projectId);
      const remainingThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) =>
          thread.deletedAt === null &&
          projectWorktrees.find((worktree) => worktree.id === thread.worktreeId)?.archivedAt ===
            null,
      );
      if (remainingThreads.length > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' still has threads and cannot be deleted.`,
        });
      }
      const remainingWorktrees = projectWorktrees.filter(
        (worktree) =>
          worktree.deletedAt === null && worktree.archivedAt === null && !worktree.isRoot,
      );
      if (remainingWorktrees.length > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' still has secondary worktrees and cannot be deleted.`,
        });
      }
      const occurredAt = nowIso();
      const archivedThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) =>
          thread.deletedAt === null &&
          projectWorktrees.find((worktree) => worktree.id === thread.worktreeId)?.archivedAt !==
            null,
      );
      const archivedWorktrees = projectWorktrees.filter(
        (worktree) =>
          worktree.deletedAt === null && worktree.archivedAt !== null && !worktree.isRoot,
      );
      return [
        ...archivedThreads.map((thread) =>
          Object.assign(
            withEventBase({
              aggregateKind: "thread" as const,
              aggregateId: thread.id,
              occurredAt,
              commandId: command.commandId,
            }),
            {
              type: "thread.deleted" as const,
              payload: {
                threadId: thread.id,
                deletedAt: occurredAt,
              },
            },
          ),
        ),
        ...archivedWorktrees.map((worktree) =>
          Object.assign(
            withEventBase({
              aggregateKind: "worktree" as const,
              aggregateId: worktree.id,
              occurredAt,
              commandId: command.commandId,
            }),
            {
              type: "worktree.deleted" as const,
              payload: {
                worktreeId: worktree.id,
                deletedAt: occurredAt,
              },
            },
          ),
        ),
        {
          ...withEventBase({
            aggregateKind: "worktree",
            aggregateId: rootWorktreeIdForProject(command.projectId),
            occurredAt,
            commandId: command.commandId,
          }),
          type: "worktree.deleted",
          payload: {
            worktreeId: rootWorktreeIdForProject(command.projectId),
            deletedAt: occurredAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "project.deleted",
          payload: {
            projectId: command.projectId,
            deletedAt: occurredAt,
          },
        },
      ];
    }

    case "worktree.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireWorktreeAbsent({
        readModel,
        command,
        worktreeId: command.worktreeId,
      });
      return {
        ...withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreeId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "worktree.created",
        payload: {
          worktreeId: command.worktreeId,
          projectId: command.projectId,
          workspacePath: command.workspacePath,
          branch: command.branch,
          isRoot: command.isRoot,
          branchRenamePending: command.branchRenamePending,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "worktree.meta.update": {
      yield* requireWorktree({
        readModel,
        command,
        worktreeId: command.worktreeId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreeId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "worktree.meta-updated",
        payload: {
          worktreeId: command.worktreeId,
          ...(command.workspacePath !== undefined ? { workspacePath: command.workspacePath } : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.branchRenamePending !== undefined
            ? { branchRenamePending: command.branchRenamePending }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "worktree.archive": {
      const worktree = yield* requireWorktree({
        readModel,
        command,
        worktreeId: command.worktreeId,
      });
      if (worktree.isRoot) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Root worktree '${command.worktreeId}' cannot be archived.`,
        });
      }
      if (worktree.archivedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Worktree '${command.worktreeId}' is already archived.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreeId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "worktree.archived",
        payload: {
          worktreeId: command.worktreeId,
          archivedAt: occurredAt,
        },
      };
    }

    case "worktree.unarchive": {
      const worktree = yield* requireWorktree({
        readModel,
        command,
        worktreeId: command.worktreeId,
      });
      if (worktree.archivedAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Worktree '${command.worktreeId}' is not archived.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreeId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "worktree.unarchived",
        payload: {
          worktreeId: command.worktreeId,
          updatedAt: occurredAt,
        },
      };
    }

    case "worktree.delete": {
      const worktree = yield* requireWorktree({
        readModel,
        command,
        worktreeId: command.worktreeId,
      });
      if (worktree.isRoot) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Root worktree '${command.worktreeId}' cannot be deleted directly.`,
        });
      }
      const worktreeThreads = readModel.threads.filter(
        (thread) => thread.worktreeId === command.worktreeId && thread.deletedAt === null,
      );
      if (worktreeThreads.length > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Worktree '${command.worktreeId}' still has threads and cannot be deleted.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreeId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "worktree.deleted",
        payload: {
          worktreeId: command.worktreeId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      const worktreeId =
        command.worktreeId ??
        (command.projectId
          ? deriveWorktreeIdFromLegacyThread({
              projectId: command.projectId,
              worktreePath: command.worktreePath,
            })
          : null);
      if (!worktreeId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Thread creation requires a worktree.",
        });
      }
      yield* requireActiveWorktree({
        readModel,
        command,
        worktreeId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          worktreeId,
          ...(command.projectId !== undefined ? { projectId: command.projectId } : {}),
          title: command.title,
          model: command.model,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.worktreeId !== undefined) {
        yield* requireActiveWorktree({
          readModel,
          command,
          worktreeId: command.worktreeId,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.worktreeId !== undefined ? { worktreeId: command.worktreeId } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireActiveWorktree({
        readModel,
        command,
        worktreeId: thread.worktreeId,
      });
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.provider !== undefined ? { provider: command.provider } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.modelOptions !== undefined ? { modelOptions: command.modelOptions } : {}),
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
          runtimeMode:
            readModel.threads.find((entry) => entry.id === command.threadId)?.runtimeMode ??
            command.runtimeMode,
          interactionMode:
            readModel.threads.find((entry) => entry.id === command.threadId)?.interactionMode ??
            command.interactionMode,
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
