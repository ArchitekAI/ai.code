import { describe, expect, it } from "vitest";

import {
  buildLinearCompletionResponse,
  isLinearCompletionCandidateStatus,
  isLinearCompletionTriggerEvent,
  resolveLinearShippingAction,
} from "./LinearSessionCompletionReactor.ts";

describe("LinearSessionCompletionReactor", () => {
  it("ships dirty repositories by creating a commit, push, and PR", () => {
    expect(
      resolveLinearShippingAction({
        isRepo: true,
        hasWorkingTreeChanges: true,
        aheadCount: 0,
        pr: null,
      }),
    ).toBe("commit_push_pr");
  });

  it("creates a PR when a branch is ahead but no pull request exists yet", () => {
    expect(
      resolveLinearShippingAction({
        isRepo: true,
        hasWorkingTreeChanges: false,
        aheadCount: 2,
        pr: null,
      }),
    ).toBe("create_pr");
  });

  it("skips shipping when the repo is already clean and has a PR", () => {
    expect(
      resolveLinearShippingAction({
        isRepo: true,
        hasWorkingTreeChanges: false,
        aheadCount: 0,
        pr: {
          number: 42,
          url: "https://github.com/t3tools/t3/pull/42",
          title: "Ship parity work",
          state: "open",
          headBranch: "feature/parity",
          baseBranch: "main",
        },
      }),
    ).toBeNull();
  });

  it("treats ready and stopped sessions as completion candidates", () => {
    expect(isLinearCompletionCandidateStatus("ready")).toBe(true);
    expect(isLinearCompletionCandidateStatus("stopped")).toBe(true);
    expect(isLinearCompletionCandidateStatus("running")).toBe(false);
    expect(isLinearCompletionCandidateStatus("error")).toBe(false);
  });

  it("combines the assistant summary with the PR details for the final response", () => {
    expect(
      buildLinearCompletionResponse({
        assistantSummary: "Implemented the Linear parity flow.",
        status: {
          pr: null,
          branch: "feature/parity",
        },
        result: {
          pr: {
            status: "created",
            number: 42,
            url: "https://github.com/t3tools/t3/pull/42",
            title: "Ship parity work",
            headBranch: "feature/parity",
            baseBranch: "main",
          },
          push: {
            status: "skipped_not_requested",
          },
          branch: {
            status: "skipped_not_requested",
            name: "feature/parity",
          },
        },
      }),
    ).toBe(
      [
        "Implemented the Linear parity flow.",
        "",
        "Pull request: Ship parity work",
        "PR: https://github.com/t3tools/t3/pull/42",
        "Branch: feature/parity",
      ].join("\n"),
    );
  });

  it("falls back to a generic final response when there is no summary or PR", () => {
    expect(
      buildLinearCompletionResponse({
        assistantSummary: "",
        status: {
          pr: null,
          branch: "feature/parity",
        },
        result: null,
      }),
    ).toBe("Finished work on this issue.");
  });

  it("treats final assistant messages as completion retries", () => {
    expect(
      isLinearCompletionTriggerEvent({
        type: "thread.message-sent",
        payload: {
          role: "assistant",
          streaming: false,
          turnId: "turn-1",
          text: "Done",
        },
      } as any),
    ).toBe(true);
  });

  it("ignores streamed assistant chunks for completion", () => {
    expect(
      isLinearCompletionTriggerEvent({
        type: "thread.message-sent",
        payload: {
          role: "assistant",
          streaming: true,
          turnId: "turn-1",
          text: "Working",
        },
      } as any),
    ).toBe(false);
  });
});
