import { describe, expect, it } from "vitest";

import {
  getThreadStatusVisual,
  hasUnseenCompletion,
  resolveThreadStatusKind,
  resolveThreadStatusVisual,
  resolveWorktreeStatusKind,
  type ThreadStatusSnapshot,
} from "./threadStatus";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
  state?: "running" | "interrupted" | "completed" | "error";
}) {
  return {
    turnId: "turn-1" as never,
    state: overrides?.state ?? ("completed" as const),
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

function makeThread(overrides?: Partial<ThreadStatusSnapshot>): ThreadStatusSnapshot {
  return {
    interactionMode: "default",
    latestTurn: null,
    lastVisitedAt: undefined,
    proposedPlans: [],
    session: {
      provider: "codex",
      status: "ready",
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "ready",
    },
    activities: [],
    ...overrides,
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("resolveThreadStatusKind", () => {
  it("returns pendingApproval", () => {
    expect(
      resolveThreadStatusKind(
        makeThread({
          activities: [
            {
              id: "activity-1" as never,
              turnId: null,
              tone: "approval",
              kind: "approval.requested",
              summary: "Approval requested",
              createdAt: "2026-03-09T10:00:00.000Z",
              sequence: 1,
              payload: { requestId: "req-1", requestKind: "command" },
            },
          ],
        }),
      ),
    ).toBe("pendingApproval");
  });

  it("returns awaitingInput", () => {
    expect(
      resolveThreadStatusKind(
        makeThread({
          activities: [
            {
              id: "activity-1" as never,
              turnId: null,
              tone: "approval",
              kind: "user-input.requested",
              summary: "Input requested",
              createdAt: "2026-03-09T10:00:00.000Z",
              sequence: 1,
              payload: {
                requestId: "req-1",
                questions: [
                  {
                    id: "q1",
                    header: "Pick",
                    question: "Choose",
                    options: [{ label: "A", description: "Option A" }],
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toBe("awaitingInput");
  });

  it("returns working", () => {
    expect(
      resolveThreadStatusKind(
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-09T10:00:00.000Z",
            updatedAt: "2026-03-09T10:00:00.000Z",
            orchestrationStatus: "running",
          },
        }),
      ),
    ).toBe("working");
  });

  it("returns connecting", () => {
    expect(
      resolveThreadStatusKind(
        makeThread({
          session: {
            provider: "codex",
            status: "connecting",
            createdAt: "2026-03-09T10:00:00.000Z",
            updatedAt: "2026-03-09T10:00:00.000Z",
            orchestrationStatus: "starting",
          },
        }),
      ),
    ).toBe("connecting");
  });

  it("returns planReady", () => {
    expect(
      resolveThreadStatusKind(
        makeThread({
          interactionMode: "plan",
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
            },
          ],
        }),
      ),
    ).toBe("planReady");
  });

  it("returns completed", () => {
    expect(
      resolveThreadStatusKind(
        makeThread({
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
        }),
      ),
    ).toBe("completed");
  });

  it("returns failed for an errored latest turn", () => {
    expect(
      resolveThreadStatusKind(
        makeThread({
          latestTurn: makeLatestTurn({ state: "error" }),
        }),
      ),
    ).toBe("failed");
  });

  it("returns interrupted for an interrupted latest turn", () => {
    expect(
      resolveThreadStatusKind(
        makeThread({
          latestTurn: makeLatestTurn({ state: "interrupted" }),
        }),
      ),
    ).toBe("interrupted");
  });

  it("returns null", () => {
    expect(resolveThreadStatusKind(makeThread())).toBeNull();
  });

  it("prioritizes pendingApproval over awaitingInput", () => {
    expect(
      resolveThreadStatusKind(
        makeThread({
          activities: [
            {
              id: "activity-1" as never,
              turnId: null,
              tone: "approval",
              kind: "approval.requested",
              summary: "Approval requested",
              createdAt: "2026-03-09T10:00:00.000Z",
              sequence: 1,
              payload: { requestId: "req-1", requestKind: "command" },
            },
            {
              id: "activity-2" as never,
              turnId: null,
              tone: "approval",
              kind: "user-input.requested",
              summary: "Input requested",
              createdAt: "2026-03-09T10:00:01.000Z",
              sequence: 2,
              payload: {
                requestId: "req-2",
                questions: [
                  {
                    id: "q1",
                    header: "Pick",
                    question: "Choose",
                    options: [{ label: "A", description: "Option A" }],
                  },
                ],
              },
            },
          ],
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-09T10:00:00.000Z",
            updatedAt: "2026-03-09T10:00:00.000Z",
            orchestrationStatus: "running",
          },
        }),
      ),
    ).toBe("pendingApproval");
  });

  it("prioritizes awaitingInput over working", () => {
    expect(
      resolveThreadStatusKind(
        makeThread({
          activities: [
            {
              id: "activity-1" as never,
              turnId: null,
              tone: "approval",
              kind: "user-input.requested",
              summary: "Input requested",
              createdAt: "2026-03-09T10:00:00.000Z",
              sequence: 1,
              payload: {
                requestId: "req-1",
                questions: [
                  {
                    id: "q1",
                    header: "Pick",
                    question: "Choose",
                    options: [{ label: "A", description: "Option A" }],
                  },
                ],
              },
            },
          ],
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-09T10:00:00.000Z",
            updatedAt: "2026-03-09T10:00:00.000Z",
            orchestrationStatus: "running",
          },
        }),
      ),
    ).toBe("awaitingInput");
  });

  it("prioritizes working over connecting", () => {
    expect(
      resolveWorktreeStatusKind([
        makeThread({
          session: {
            provider: "codex",
            status: "connecting",
            createdAt: "2026-03-09T10:00:00.000Z",
            updatedAt: "2026-03-09T10:00:00.000Z",
            orchestrationStatus: "starting",
          },
        }),
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-09T10:00:00.000Z",
            updatedAt: "2026-03-09T10:00:00.000Z",
            orchestrationStatus: "running",
          },
        }),
      ]),
    ).toBe("working");
  });

  it("prioritizes connecting over planReady", () => {
    expect(
      resolveWorktreeStatusKind([
        makeThread({
          interactionMode: "plan",
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
            },
          ],
        }),
        makeThread({
          session: {
            provider: "codex",
            status: "connecting",
            createdAt: "2026-03-09T10:00:00.000Z",
            updatedAt: "2026-03-09T10:00:00.000Z",
            orchestrationStatus: "starting",
          },
        }),
      ]),
    ).toBe("connecting");
  });

  it("prioritizes planReady over completed", () => {
    expect(
      resolveWorktreeStatusKind([
        makeThread({
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
        }),
        makeThread({
          interactionMode: "plan",
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
            },
          ],
        }),
      ]),
    ).toBe("planReady");
  });
});

describe("resolveThreadStatusVisual", () => {
  it("returns the visual metadata for a resolved status", () => {
    expect(
      resolveThreadStatusVisual(
        makeThread({
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
        }),
      ),
    ).toEqual(getThreadStatusVisual("completed"));
  });
});

describe("resolveWorktreeStatusKind", () => {
  it("returns the highest-priority status across mixed threads", () => {
    expect(
      resolveWorktreeStatusKind([
        makeThread({
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
        }),
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-09T10:00:00.000Z",
            updatedAt: "2026-03-09T10:00:00.000Z",
            orchestrationStatus: "running",
          },
        }),
      ]),
    ).toBe("working");
  });

  it("returns null when every thread is idle", () => {
    expect(resolveWorktreeStatusKind([makeThread(), makeThread()])).toBeNull();
  });

  it("returns null for an empty worktree", () => {
    expect(resolveWorktreeStatusKind([])).toBeNull();
  });

  it("prioritizes failed over completed", () => {
    expect(
      resolveWorktreeStatusKind([
        makeThread({
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
        }),
        makeThread({
          latestTurn: makeLatestTurn({ state: "error" }),
        }),
      ]),
    ).toBe("failed");
  });
});
