import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { LinearPromptAssembler } from "../Services/LinearPromptAssembler.ts";
import { LinearPromptAssemblerLive } from "./LinearPromptAssembler.ts";

const defaultIssue = {
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
} as const;

it.layer(NodeServices.layer)("linear prompt assembler", (it) => {
  it.effect("matches Cyrus issue-context structure for new sessions", () =>
    Effect.gen(function* () {
      const assembler = yield* LinearPromptAssembler;
      const result = yield* assembler.assembleNewSessionPrompt({
        issue: defaultIssue,
        comments: [
          {
            id: "comment-1",
            body: "Should we use JWT or sessions?",
            createdAt: "2026-04-05T10:00:00.000Z",
            author: "Alice",
          },
          {
            id: "comment-2",
            body: "JWT for API auth.",
            createdAt: "2026-04-05T10:05:00.000Z",
            author: "Bob",
            parentId: "comment-1",
          },
        ],
        workspaceRoot: "/tmp/linear-project",
        worktreePath: "/tmp/linear-project/eng-1-fix-linear-webhook-parity",
        baseBranch: "main",
        repositoryRoutingContext: `<repository>\n  <route_key>linear-project</route_key>\n</repository>`,
        newComment: {
          author: "Carol",
          body: "Please prioritize the middleware path.",
          timestamp: "2026-04-05T12:00:00.000Z",
        },
        guidance: [
          {
            body: "Always add tests for API changes.",
            origin: {
              __typename: "TeamOriginWebhookPayload",
              team: {
                displayName: "Engineering",
              },
            },
          },
        ],
      });

      assert.include(result.prompt, "<context>");
      assert.include(result.prompt, "<repository>linear-project</repository>");
      assert.include(
        result.prompt,
        "<working_directory>/tmp/linear-project/eng-1-fix-linear-webhook-parity</working_directory>",
      );
      assert.include(result.prompt, "<repository_routing_context>");
      assert.include(result.prompt, "<assignee>");
      assert.include(result.prompt, "<linear_display_name></linear_display_name>");
      assert.include(result.prompt, "<comment_thread>");
      assert.include(result.prompt, "<author>@Alice</author>");
      assert.include(result.prompt, "<author>@Bob</author>");
      assert.include(result.prompt, "<new_comment_to_address>");
      assert.include(result.prompt, "<author>Carol</author>");
      assert.include(result.prompt, "<timestamp>2026-04-05T12:00:00.000Z</timestamp>");
      assert.include(result.prompt, "<agent_guidance>");
      assert.include(result.prompt, "## Guidance from Team (Engineering)");
      assert.include(result.systemPromptPrefix ?? "", '<version-tag value="builder-v1.4.0-t3" />');
      assert.include(result.systemPromptPrefix ?? "", "Task tool as your PRIMARY interface");
      assert.include(result.systemPromptPrefix ?? "", "TodoWrite and TodoRead");
      assert.include(
        result.systemPromptPrefix ?? "",
        "When the Task tool is available, prefer patterns like",
      );
      assert.include(result.systemPromptPrefix ?? "", "YOUR EXECUTION FLOW SHOULD LOOK LIKE THIS");
      assert.equal(result.promptType, "builder");
    }).pipe(Effect.provide(LinearPromptAssemblerLive)),
  );

  it.effect("matches Cyrus continuation prompt shape", () =>
    Effect.gen(function* () {
      const assembler = yield* LinearPromptAssembler;
      const result = yield* assembler.assembleContinuationPrompt({
        comment: {
          author: "Charlie Brown",
          body: "Follow-up comment",
          timestamp: "2026-04-05T16:00:00.000Z",
        },
        promptType: "debugger",
      });

      assert.equal(
        result.prompt,
        `<new_comment>
  <author>Charlie Brown</author>
  <timestamp>2026-04-05T16:00:00.000Z</timestamp>
  <content>
Follow-up comment
  </content>
</new_comment>`,
      );
      assert.include(result.systemPromptPrefix ?? "", '<version-tag value="debugger-v1.4.0-t3" />');
      assert.include(result.systemPromptPrefix ?? "", "Task tool as your PRIMARY interface");
      assert.include(result.systemPromptPrefix ?? "", "TodoWrite and TodoRead");
      assert.include(
        result.systemPromptPrefix ?? "",
        "When the Task tool is available, prefer patterns like",
      );
      assert.include(
        result.systemPromptPrefix ?? "",
        "DEBUGGING EXECUTION FLOW SHOULD LOOK LIKE THIS",
      );
      assert.equal(result.promptType, "debugger");
    }).pipe(Effect.provide(LinearPromptAssemblerLive)),
  );

  it.effect("appends shared todo instructions for scoper sessions", () =>
    Effect.gen(function* () {
      const assembler = yield* LinearPromptAssembler;
      const result = yield* assembler.assembleNewSessionPrompt({
        issue: {
          ...defaultIssue,
          labelNames: ["scoper"],
        },
        comments: [],
        workspaceRoot: "/tmp/linear-project",
        worktreePath: "/tmp/linear-project/eng-1-fix-linear-webhook-parity",
        baseBranch: "main",
        promptType: "scoper",
      });

      assert.include(result.systemPromptPrefix ?? "", '<version-tag value="scoper-v1.0.0-t3" />');
      assert.include(result.systemPromptPrefix ?? "", "<task_management_instructions>");
      assert.include(result.systemPromptPrefix ?? "", "TodoWrite and TodoRead");
      assert.include(result.systemPromptPrefix ?? "", "Linear document workflow");
      assert.include(result.systemPromptPrefix ?? "", "prefer a structure like");
      assert.include(
        result.systemPromptPrefix ?? "",
        "do not implement production code in scoper mode",
      );
      assert.equal(result.promptType, "scoper");
    }).pipe(Effect.provide(LinearPromptAssemblerLive)),
  );
});
