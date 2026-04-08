/**
 * LinearIssueLifecycle - Shared utility functions for transitioning Linear
 * issue workflow states during agent session lifecycle events.
 *
 * Mirrors Cyrus's `moveIssueToStartedState` behavior by resolving the target
 * state from the team's workflow state taxonomy rather than hard-coding state
 * names, so it works with any team's custom workflow configuration.
 *
 * Linear workflow state types:
 *   triage → backlog → unstarted → started → completed → canceled
 *
 * Within the "started" type, teams typically define:
 *   - "In Progress" (lower position) — agent is actively working
 *   - "In Review" (higher position) — work is done, awaiting review
 *
 * @module LinearIssueLifecycle
 */
import { Effect } from "effect";

import type { LinearClientShape, LinearWorkflowState } from "../Services/LinearClient.ts";

/**
 * Find the lowest-position "started" state for a team (typically "In Progress").
 */
function findLowestStartedState(
  states: ReadonlyArray<LinearWorkflowState>,
): LinearWorkflowState | null {
  const startedStates = states.filter((state) => state.type === "started");
  if (startedStates.length === 0) {
    return null;
  }
  return startedStates.toSorted((a, b) => a.position - b.position)[0] ?? null;
}

/**
 * Find the highest-position "started" state for a team (typically "In Review").
 */
function findHighestStartedState(
  states: ReadonlyArray<LinearWorkflowState>,
): LinearWorkflowState | null {
  const startedStates = states.filter((state) => state.type === "started");
  if (startedStates.length === 0) {
    return null;
  }
  return startedStates.toSorted((a, b) => b.position - a.position)[0] ?? null;
}

/**
 * Move an issue to the "In Progress" state (lowest-position "started" state).
 *
 * Mirrors Cyrus's `moveIssueToStartedState` which picks the lowest-position
 * state with type "started". This ensures "In Progress" is preferred over
 * "In Review" when both have type "started".
 *
 * The function is fire-and-forget safe: it catches all errors internally and
 * logs a warning instead of failing the caller's flow.
 */
export const moveIssueToInProgress = (input: {
  readonly linearClient: LinearClientShape;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly teamId: string;
  readonly currentState?: string;
}) =>
  Effect.gen(function* () {
    // Accept the client from callers so this helper does not leak a hidden
    // LinearClient requirement back into webhook and reactor effects.
    const states = yield* input.linearClient.fetchTeamWorkflowStates(input.teamId);
    const targetState = findLowestStartedState(states);
    if (!targetState) {
      yield* Effect.logWarning("no started workflow state found for team", {
        issueIdentifier: input.issueIdentifier,
        teamId: input.teamId,
      });
      return;
    }

    // Skip if the issue is already in a "started" state (avoid unnecessary API calls)
    if (input.currentState) {
      const currentStateEntry = states.find(
        (state) => state.name.toLowerCase() === input.currentState!.toLowerCase(),
      );
      if (currentStateEntry?.type === "started") {
        yield* Effect.logDebug("issue already in a started state, skipping transition", {
          issueIdentifier: input.issueIdentifier,
          currentState: input.currentState,
        });
        return;
      }
    }

    yield* input.linearClient.updateIssueState(input.issueId, targetState.id);
    yield* Effect.logDebug("moved issue to started state", {
      issueIdentifier: input.issueIdentifier,
      targetState: targetState.name,
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to move issue to in-progress state", {
        issueIdentifier: input.issueIdentifier,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );

/**
 * Move an issue to the "In Review" state (highest-position "started" state).
 *
 * Called after the agent creates a PR so the issue moves from "In Progress"
 * to "In Review" in the team's workflow. This goes beyond Cyrus parity
 * (Cyrus only moves to "In Progress") and provides a more complete lifecycle.
 *
 * The function is fire-and-forget safe: it catches all errors internally and
 * logs a warning instead of failing the caller's flow.
 */
export const moveIssueToReviewState = (input: {
  readonly linearClient: LinearClientShape;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly teamId: string;
}) =>
  Effect.gen(function* () {
    // Keep the helper environment-free so post-PR transitions can run from
    // background fibers without depending on a service lookup.
    const states = yield* input.linearClient.fetchTeamWorkflowStates(input.teamId);
    const lowestStarted = findLowestStartedState(states);
    const highestStarted = findHighestStartedState(states);

    // Only transition when there are at least two distinct "started" states
    // (e.g., "In Progress" and "In Review"). If only one exists, leave the
    // issue where it is — the team has no "review" bucket.
    if (!lowestStarted || !highestStarted || lowestStarted.id === highestStarted.id) {
      yield* Effect.logDebug(
        "team does not have a distinct review state, skipping In Review transition",
        {
          issueIdentifier: input.issueIdentifier,
          teamId: input.teamId,
        },
      );
      return;
    }

    yield* input.linearClient.updateIssueState(input.issueId, highestStarted.id);
    yield* Effect.logDebug("moved issue to review state", {
      issueIdentifier: input.issueIdentifier,
      targetState: highestStarted.name,
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to move issue to review state", {
        issueIdentifier: input.issueIdentifier,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
