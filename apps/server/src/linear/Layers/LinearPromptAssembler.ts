import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LinearWebhookHandlerError, type PromptType } from "@t3tools/contracts";
import { Effect, FileSystem, Layer } from "effect";

import {
  LinearPromptAssembler,
  type LinearPromptAssemblerCommentContext,
  type LinearPromptAssemblerGuidanceRule,
  type LinearPromptAssemblerShape,
} from "../Services/LinearPromptAssembler.ts";
import type { LinearIssueComment, LinearIssueDetails } from "../Services/LinearClient.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const DEBUGGER_LABELS = new Set(["bug", "debugger"]);
const ORCHESTRATOR_LABELS = new Set(["orchestrator"]);
const GRAPHITE_LABELS = new Set(["graphite", "graphite-orchestrator"]);
const SCOPER_LABELS = new Set(["scoper"]);

function determineFallbackPromptTypeFromLabels(labelNames: ReadonlyArray<string>): PromptType {
  const normalizedLabels = new Set(labelNames.map((label) => label.trim().toLowerCase()));
  if (
    [...GRAPHITE_LABELS].some((label) => normalizedLabels.has(label)) &&
    [...ORCHESTRATOR_LABELS].some((label) => normalizedLabels.has(label))
  ) {
    return "graphite-orchestrator";
  }
  if ([...SCOPER_LABELS].some((label) => normalizedLabels.has(label))) {
    return "scoper";
  }
  if ([...ORCHESTRATOR_LABELS].some((label) => normalizedLabels.has(label))) {
    return "orchestrator";
  }
  for (const label of normalizedLabels) {
    if (DEBUGGER_LABELS.has(label)) {
      return "debugger";
    }
  }
  return "builder";
}

function formatCommentThreads(comments: ReadonlyArray<LinearIssueComment>): string {
  if (comments.length === 0) {
    return "No comments yet.";
  }

  const sortedComments = comments.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const threads = new Map<
    string,
    { readonly root: LinearIssueComment; readonly replies: Array<LinearIssueComment> }
  >();
  const rootComments: Array<LinearIssueComment> = [];

  // Mirror Cyrus's two-pass threading logic so the rendered Linear prompt
  // follows the same root-comment and reply ordering semantics.
  for (const comment of sortedComments) {
    if (comment.parentId) {
      continue;
    }
    rootComments.push(comment);
    threads.set(comment.id, { root: comment, replies: [] });
  }

  for (const comment of sortedComments) {
    if (!comment.parentId) {
      continue;
    }
    const thread = threads.get(comment.parentId);
    if (thread) {
      thread.replies.push(comment);
    }
  }

  return rootComments
    .map((rootComment) => {
      const thread = threads.get(rootComment.id);
      if (!thread) {
        return "";
      }

      const { root, replies } = thread;
      const rootTimestamp = new Date(root.createdAt).toLocaleString();
      const formattedReplies =
        replies.length === 0
          ? ""
          : `\n  <replies>${replies
              .map((reply) => {
                const replyTimestamp = new Date(reply.createdAt).toLocaleString();
                return `
    <reply>
      <author>@${reply.author}</author>
      <timestamp>${replyTimestamp}</timestamp>
      <content>
${reply.body}
      </content>
    </reply>`;
              })
              .join("")}
  </replies>`;

      return `<comment_thread>
  <root_comment>
    <author>@${root.author}</author>
    <timestamp>${rootTimestamp}</timestamp>
    <content>
${root.body}
    </content>
  </root_comment>${formattedReplies}
</comment_thread>`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function formatAgentGuidance(guidance?: ReadonlyArray<LinearPromptAssemblerGuidanceRule>): string {
  if (!guidance || guidance.length === 0) {
    return "";
  }

  let formatted =
    "\n\n<agent_guidance>\nThe following guidance has been configured for this workspace/team in Linear. Team-specific guidance takes precedence over workspace-level guidance.\n";

  for (const rule of guidance) {
    let origin = "Global";
    if (rule.origin) {
      if (rule.origin.__typename === "TeamOriginWebhookPayload") {
        origin = `Team (${rule.origin.team?.displayName ?? "Unknown"})`;
      } else {
        origin = "Organization";
      }
    }
    formatted += `\n## Guidance from ${origin}\n${rule.body}\n`;
  }

  formatted += "\n</agent_guidance>";
  return formatted;
}

function formatRepositoryRoutingContext(repositoryRoutingContext?: string): string {
  const normalized = repositoryRoutingContext?.trim();
  if (!normalized) {
    return "";
  }
  return `<repository_routing_context>\n${normalized}\n</repository_routing_context>`;
}

function shouldAppendTodoExtension(promptType: PromptType): boolean {
  return (
    promptType === "scoper" ||
    promptType === "orchestrator" ||
    promptType === "graphite-orchestrator"
  );
}

function shouldAppendVerifyAndShipExtension(promptType: PromptType): boolean {
  return (
    promptType === "builder" ||
    promptType === "debugger" ||
    promptType === "orchestrator" ||
    promptType === "graphite-orchestrator"
  );
}

function promptAssetCandidates(filename: string): ReadonlyArray<string> {
  return [
    // Source-mode and unbundled builds keep prompts one directory above the layer.
    join(MODULE_DIR, "../prompts", filename),
    // The production bundle runs from dist/bin.mjs, so prompt assets live under dist/linear/prompts.
    join(MODULE_DIR, "linear/prompts", filename),
    // Keep a flat dist/prompts fallback for future packaging changes.
    join(MODULE_DIR, "prompts", filename),
  ];
}

function buildIssueUpdatePromptText(input: {
  readonly issue: LinearIssueDetails;
  readonly previousTitle?: string;
  readonly previousDescription?: string;
}): string {
  const sections = [
    `<issue_update>`,
    `  <identifier>${input.issue.identifier}</identifier>`,
    `  <timestamp>${new Date().toISOString()}</timestamp>`,
  ];

  if (input.previousTitle !== undefined) {
    sections.push(`  <title_change>`);
    sections.push(`    <old_title>${input.previousTitle}</old_title>`);
    sections.push(`    <new_title>${input.issue.title}</new_title>`);
    sections.push(`  </title_change>`);
  }

  if (input.previousDescription !== undefined) {
    sections.push(`  <description_change>`);
    sections.push(`    <old_description>`);
    sections.push(input.previousDescription);
    sections.push(`    </old_description>`);
    sections.push(`    <new_description>`);
    sections.push(input.issue.description);
    sections.push(`    </new_description>`);
    sections.push(`  </description_change>`);
  }

  sections.push(`</issue_update>`);
  sections.push("");
  sections.push(`<guidance>`);
  sections.push(
    `  The issue has been updated while you are working on it. Please evaluate whether these changes`,
  );
  sections.push(`  affect your current implementation or action plan. Consider the following:`);
  sections.push(`  - Does the updated content change the requirements or scope of your work?`);
  sections.push(
    `  - Are there new details, clarifications, or attachments that should inform your approach?`,
  );
  sections.push(`  - Should you adjust your implementation strategy based on this update?`);
  sections.push(
    `  If the changes are relevant, incorporate them into your work. If not, you may continue as planned.`,
  );
  sections.push(`</guidance>`);

  return sections.join("\n");
}

function buildContinuationPromptText(input: {
  readonly comment: LinearPromptAssemblerCommentContext;
}): string {
  return `<new_comment>
  <author>${input.comment.author}</author>
  <timestamp>${input.comment.timestamp}</timestamp>
  <content>
${input.comment.body}
  </content>
</new_comment>`;
}

const makeLinearPromptAssembler = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const resolvePromptAssetPath = Effect.fn("resolvePromptAssetPath")(function* (
    filename: string,
    detail: string,
  ) {
    for (const candidatePath of promptAssetCandidates(filename)) {
      const exists = yield* fileSystem.exists(candidatePath).pipe(
        Effect.mapError(
          (cause) =>
            new LinearWebhookHandlerError({
              detail,
              cause,
            }),
        ),
      );
      if (exists) {
        return candidatePath;
      }
    }

    return yield* new LinearWebhookHandlerError({
      detail,
    });
  });

  const readSystemPromptTemplate = Effect.fn("readSystemPromptTemplate")(function* (
    promptType: PromptType,
  ) {
    const templatePath = yield* resolvePromptAssetPath(
      `${promptType}.md`,
      `Failed to load Linear prompt template '${promptType}'.`,
    );
    const promptTemplate = yield* fileSystem.readFileString(templatePath).pipe(
      Effect.mapError(
        (cause) =>
          new LinearWebhookHandlerError({
            detail: `Failed to read Linear prompt template '${promptType}'.`,
            cause,
          }),
      ),
    );

    if (!shouldAppendTodoExtension(promptType)) {
      if (!shouldAppendVerifyAndShipExtension(promptType)) {
        return promptTemplate;
      }
    }

    let enrichedPrompt = promptTemplate.trimEnd();

    if (shouldAppendTodoExtension(promptType)) {
      const todoExtensionPath = yield* resolvePromptAssetPath(
        "todolist-system-prompt-extension.md",
        "Failed to load shared Linear todo instructions.",
      );
      const todoExtension = yield* fileSystem.readFileString(todoExtensionPath).pipe(
        Effect.mapError(
          (cause) =>
            new LinearWebhookHandlerError({
              detail: "Failed to read shared Linear todo instructions.",
              cause,
            }),
        ),
      );

      // Keep the shared planning instructions colocated with the prompt type that needs them.
      enrichedPrompt = `${enrichedPrompt}\n\n${todoExtension.trim()}`;
    }

    if (!shouldAppendVerifyAndShipExtension(promptType)) {
      return `${enrichedPrompt}\n`;
    }

    const workflowExtensionPath = yield* resolvePromptAssetPath(
      "verify-and-ship-system-prompt-extension.md",
      "Failed to load shared Linear verify-and-ship instructions.",
    );
    const workflowExtension = yield* fileSystem.readFileString(workflowExtensionPath).pipe(
      Effect.mapError(
        (cause) =>
          new LinearWebhookHandlerError({
            detail: "Failed to read shared Linear verify-and-ship instructions.",
            cause,
          }),
      ),
    );

    // Mirror Cyrus by keeping shipping/final-summary requirements in a shared
    // prompt extension rather than re-copying the workflow into each template.
    return `${enrichedPrompt}\n\n${workflowExtension.trim()}\n`;
  });

  const readStandardIssuePromptTemplate = Effect.gen(function* () {
    const templatePath = yield* resolvePromptAssetPath(
      "standard-issue-assigned-user-prompt.md",
      "Failed to load Linear issue-context prompt template.",
    );
    return yield* fileSystem.readFileString(templatePath).pipe(
      Effect.mapError(
        (cause) =>
          new LinearWebhookHandlerError({
            detail: "Failed to read Linear issue-context prompt template.",
            cause,
          }),
      ),
    );
  });

  const buildIssueContextPromptText = (input: {
    readonly issue: LinearIssueDetails;
    readonly comments: ReadonlyArray<LinearIssueComment>;
    readonly workspaceRoot: string;
    readonly worktreePath: string;
    readonly baseBranch: string;
    readonly newComment?: LinearPromptAssemblerCommentContext;
    readonly template: string;
    readonly repositoryRoutingContext?: string;
  }) => {
    let prompt = input.template
      .replace(/{{repository_name}}/g, basename(input.workspaceRoot) || input.workspaceRoot)
      .replace(/{{working_directory}}/g, input.worktreePath)
      .replace(/{{base_branch}}/g, input.baseBranch)
      .replace(/{{issue_id}}/g, input.issue.id)
      .replace(/{{issue_identifier}}/g, input.issue.identifier)
      .replace(/{{issue_title}}/g, input.issue.title)
      .replace(/{{issue_description}}/g, input.issue.description || "No description provided")
      .replace(/{{issue_state}}/g, input.issue.state || "Unknown")
      .replace(/{{issue_priority}}/g, String(input.issue.priority ?? "None"))
      .replace(/{{issue_url}}/g, input.issue.url || "")
      .replace(/{{comment_threads}}/g, formatCommentThreads(input.comments))
      .replace(/{{assignee_name}}/g, "")
      .replace(/{{assignee_linear_profile_url}}/g, "")
      .replace(/{{assignee_github_username}}/g, "")
      .replace(/{{assignee_github_user_id}}/g, "")
      .replace(/{{assignee_github_noreply_email}}/g, "")
      .replace(
        /{{repository_routing_context}}/g,
        formatRepositoryRoutingContext(input.repositoryRoutingContext),
      );

    if (input.newComment) {
      const newCommentSection = `<new_comment_to_address>
  <author>{{new_comment_author}}</author>
  <timestamp>{{new_comment_timestamp}}</timestamp>
  <content>
{{new_comment_content}}
  </content>
</new_comment_to_address>

IMPORTANT: Focus specifically on addressing the new comment above. This is a new request that requires your attention.`;

      prompt = prompt
        .replace(/{{#if new_comment}}[\s\S]*?{{\/if}}/g, newCommentSection)
        .replace(/{{new_comment_author}}/g, input.newComment.author)
        .replace(/{{new_comment_timestamp}}/g, input.newComment.timestamp)
        .replace(/{{new_comment_content}}/g, input.newComment.body || "");
    } else {
      prompt = prompt.replace(/\n*{{#if new_comment}}[\s\S]*?{{\/if}}/g, "");
    }

    return prompt;
  };

  const assembleNewSessionPrompt: LinearPromptAssemblerShape["assembleNewSessionPrompt"] =
    Effect.fn("assembleNewSessionPrompt")(function* (input) {
      const promptType =
        input.promptType ?? determineFallbackPromptTypeFromLabels(input.issue.labelNames);
      const systemPromptPrefix = yield* readSystemPromptTemplate(promptType);
      const template = yield* readStandardIssuePromptTemplate;
      let prompt = buildIssueContextPromptText({
        ...input,
        template,
      });
      prompt += formatAgentGuidance(input.guidance);

      // Cyrus appends the attachment manifest after all other prompt sections
      // so the agent knows about available images/files from the issue.
      if (input.attachmentManifest?.trim()) {
        prompt += `\n\n${input.attachmentManifest}`;
      }

      return {
        prompt,
        systemPromptPrefix,
        promptType,
      };
    });

  const assembleContinuationPrompt: LinearPromptAssemblerShape["assembleContinuationPrompt"] =
    Effect.fn("assembleContinuationPrompt")(function* (input) {
      const promptType = input.promptType ?? "builder";
      const systemPromptPrefix = yield* readSystemPromptTemplate(promptType);
      let prompt = buildContinuationPromptText(input);

      if (input.attachmentManifest?.trim()) {
        prompt += `\n\n${input.attachmentManifest}`;
      }

      return {
        prompt,
        systemPromptPrefix,
        promptType,
      };
    });

  const assembleIssueUpdatePrompt: LinearPromptAssemblerShape["assembleIssueUpdatePrompt"] =
    Effect.fn("assembleIssueUpdatePrompt")(function* (input) {
      const promptType =
        input.promptType ?? determineFallbackPromptTypeFromLabels(input.issue.labelNames);
      const systemPromptPrefix = yield* readSystemPromptTemplate(promptType);
      return {
        prompt: buildIssueUpdatePromptText(input),
        systemPromptPrefix,
        promptType,
      };
    });

  return {
    assembleNewSessionPrompt,
    assembleContinuationPrompt,
    assembleIssueUpdatePrompt,
  } satisfies LinearPromptAssemblerShape;
});

export const LinearPromptAssemblerLive = Layer.effect(
  LinearPromptAssembler,
  makeLinearPromptAssembler,
);
