import { LinearClient as SdkLinearClient } from "@linear/sdk";
import { LinearActivitySinkError } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { LinearClient, type LinearClientShape } from "../Services/LinearClient.ts";

const makeLinearClient = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;

  const loadSdkClient = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new LinearActivitySinkError({
            detail: "Failed to load Linear settings.",
            cause,
          }),
      ),
    );
    const token = settings.linear.apiToken.trim();
    if (!token) {
      return yield* new LinearActivitySinkError({
        detail: "Linear API token is not configured.",
      });
    }
    return new SdkLinearClient({ apiKey: token });
  });

  const createAgentActivity: LinearClientShape["createAgentActivity"] = (input) =>
    loadSdkClient.pipe(
      Effect.flatMap((client) =>
        Effect.tryPromise({
          try: async () => {
            const payload = await client.createAgentActivity({
              agentSessionId: input.agentSessionId,
              content: input.content,
              ...(input.ephemeral !== undefined ? { ephemeral: input.ephemeral } : {}),
              ...(input.signal ? { signal: input.signal as any } : {}),
              ...(input.signalMetadata ? { signalMetadata: input.signalMetadata as any } : {}),
            });
            const agentActivity = payload.agentActivity ? await payload.agentActivity : null;
            return { activityId: payload.success ? (agentActivity?.id ?? "") : "" };
          },
          catch: (cause) =>
            new LinearActivitySinkError({
              detail: "Failed to create Linear agent activity.",
              cause,
            }),
        }),
      ),
      Effect.flatMap((result) =>
        result.activityId
          ? Effect.succeed(result)
          : Effect.fail(
              new LinearActivitySinkError({
                detail: "Linear did not return an agent activity id.",
              }),
            ),
      ),
    );

  const fetchIssue: LinearClientShape["fetchIssue"] = (issueId) =>
    loadSdkClient.pipe(
      Effect.flatMap((client) =>
        Effect.tryPromise({
          try: async () => {
            const issue = await client.issue(issueId);
            const labelsConnection = await issue.labels();
            const team = issue.team ? await issue.team : null;
            const labels = labelsConnection.nodes;
            return {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description ?? "",
              teamKey: team?.key ?? "",
              labelNames: labels.map((label) => label.name),
            };
          },
          catch: (cause) =>
            new LinearActivitySinkError({
              detail: `Failed to fetch Linear issue ${issueId}.`,
              cause,
            }),
        }),
      ),
    );

  return {
    createAgentActivity,
    fetchIssue,
  } satisfies LinearClientShape;
});

export const LinearClientLive = Layer.effect(LinearClient, makeLinearClient);
