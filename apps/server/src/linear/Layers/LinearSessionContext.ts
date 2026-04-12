import { type LinearSessionRow, type ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { LinearSessionRegistryError } from "../Services/LinearSessionRegistry.ts";

export const dedupeLinearSessions = (sessions: ReadonlyArray<LinearSessionRow>) => [
  ...new Map(sessions.map((session) => [session.linearSessionId, session])).values(),
];

export interface LiveLinearSessionContext<Thread> {
  readonly session: LinearSessionRow;
  readonly thread: Thread;
}

interface FindLatestLiveLinearSessionContextInput<Thread> {
  readonly sessions: ReadonlyArray<LinearSessionRow>;
  readonly lookupThreadContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<Thread>, ProjectionRepositoryError, never>;
  readonly removeSession: (
    linearSessionId: string,
  ) => Effect.Effect<void, LinearSessionRegistryError, never>;
}

export const findLatestLiveLinearSessionContext = <Thread>(
  input: FindLatestLiveLinearSessionContextInput<Thread>,
): Effect.Effect<
  LiveLinearSessionContext<Thread> | null,
  ProjectionRepositoryError | LinearSessionRegistryError,
  never
> =>
  Effect.gen(function* () {
    const sortedSessions = dedupeLinearSessions(input.sessions).toSorted((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );

    for (const session of sortedSessions) {
      const thread = yield* input.lookupThreadContext(session.threadId);
      if (Option.isSome(thread)) {
        return {
          session,
          thread: thread.value,
        } satisfies LiveLinearSessionContext<Thread>;
      }

      // Prune dead mappings eagerly so later Linear updates recover automatically.
      yield* input.removeSession(session.linearSessionId);
    }

    return null;
  });
