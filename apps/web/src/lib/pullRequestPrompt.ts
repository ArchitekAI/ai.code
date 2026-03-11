import type { GitBranch, GitStatusResult, ProjectId, ThreadId, WorktreeId } from "@repo/contracts";
import type { QueryClient } from "@tanstack/react-query";

import type { DraftThreadState } from "../composerDraftStore";
import { gitBranchesQueryOptions, gitStatusQueryOptions } from "./gitReactQuery";
import { sendWorktreeThreadPrompt } from "./sendWorktreeThreadPrompt";

export const DEFAULT_PULL_REQUEST_PROMPT_MESSAGE = "Create a PR";
export const DEFAULT_PULL_REQUEST_ATTACHMENT_NAME = "PR instructions.md";
export const DEFAULT_PULL_REQUEST_PROMPT_TEMPLATE = `The user likes the current state of the code.

{{change_summary}}
The current branch is {{current_branch}}.
The target branch is {{target_branch_ref}}.

{{upstream_summary}}
The user requested a PR.

Follow these steps to create a PR:

If you have any skills related to creating PRs, invoke them now. Instructions there should take precedence over these instructions.
Run git diff to review uncommitted changes
Commit them. Follow any instructions the user gave you about writing commit messages.
Push to origin.
Use git diff {{target_branch_ref}}... to review the PR diff
Use gh pr create --base {{target_branch_name}} to create a PR onto the target branch. Keep the title under 80 characters. Keep the description under five sentences, unless the user instructed you otherwise. Describe not just changes made in this session but ALL changes in the workspace diff.
If any of these steps fail, ask the user for help.`;

export const PULL_REQUEST_PROMPT_PLACEHOLDERS = [
  "{{change_summary}}",
  "{{current_branch}}",
  "{{target_branch_ref}}",
  "{{target_branch_name}}",
  "{{upstream_summary}}",
] as const;

interface PullRequestPromptContext {
  change_summary: string;
  current_branch: string;
  target_branch_ref: string;
  target_branch_name: string;
  upstream_summary: string;
}

interface BuildPullRequestPromptInput {
  gitStatus: GitStatusResult;
  branches: ReadonlyArray<GitBranch>;
  hasOriginRemote: boolean;
  defaultPullRequestBaseBranch: string | null;
  promptTemplate: string | null;
}

interface SendCreatePullRequestPromptInput {
  queryClient: QueryClient;
  cwd: string;
  worktreeId: WorktreeId;
  projectId: ProjectId;
  projectModel: string;
  targetThreadId: ThreadId;
  isServerThread: boolean;
  draftThread: DraftThreadState | null;
  defaultPullRequestBaseBranch: string | null;
  promptTemplate: string | null;
}

function normalizePullRequestPromptTemplate(template: string | null | undefined): string {
  const normalized = template?.trim();
  return normalized && normalized.length > 0 ? normalized : DEFAULT_PULL_REQUEST_PROMPT_TEMPLATE;
}

function resolveRepoDefaultBranch(branches: ReadonlyArray<GitBranch>): string | null {
  const localDefault = branches.find((branch) => branch.isDefault && !branch.isRemote)?.name;
  if (localDefault) {
    return localDefault;
  }

  const anyDefault = branches.find((branch) => branch.isDefault)?.name;
  if (anyDefault) {
    return anyDefault.startsWith("origin/") ? anyDefault.slice("origin/".length) : anyDefault;
  }

  return null;
}

function fallbackBaseBranch(branches: ReadonlyArray<GitBranch>): string {
  const localBranchNames = new Set(
    branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
  );
  if (localBranchNames.has("main")) {
    return "main";
  }
  if (localBranchNames.has("master")) {
    return "master";
  }
  return "main";
}

function resolveBaseBranchName(input: {
  branches: ReadonlyArray<GitBranch>;
  defaultPullRequestBaseBranch: string | null;
}): string {
  const configured = input.defaultPullRequestBaseBranch?.trim();
  if (configured) {
    return configured;
  }

  return resolveRepoDefaultBranch(input.branches) ?? fallbackBaseBranch(input.branches);
}

function buildChangeSummary(gitStatus: GitStatusResult): string {
  if (!gitStatus.hasWorkingTreeChanges) {
    return "The worktree is clean.";
  }

  const changeCount = gitStatus.workingTree.files.length;
  return `There ${changeCount === 1 ? "is" : "are"} ${changeCount} uncommitted change${
    changeCount === 1 ? "" : "s"
  }.`;
}

function buildUpstreamSummary(gitStatus: GitStatusResult): string {
  if (!gitStatus.hasUpstream || !gitStatus.upstreamBranch) {
    return "There is no upstream branch yet.";
  }
  return `The upstream branch is ${gitStatus.upstreamBranch}.`;
}

function renderPullRequestPromptTemplate(
  template: string,
  context: PullRequestPromptContext,
): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (placeholder, key) => {
    if (key in context) {
      return context[key as keyof PullRequestPromptContext];
    }
    return placeholder;
  });
}

export function buildCreatePullRequestPrompt(input: BuildPullRequestPromptInput): {
  markdown: string;
  targetBranchName: string;
  targetBranchRef: string;
} {
  const currentBranch = input.gitStatus.branch ?? "HEAD";
  const targetBranchName = resolveBaseBranchName({
    branches: input.branches,
    defaultPullRequestBaseBranch: input.defaultPullRequestBaseBranch,
  });
  const targetBranchRef = input.hasOriginRemote ? `origin/${targetBranchName}` : targetBranchName;
  const markdown = renderPullRequestPromptTemplate(
    normalizePullRequestPromptTemplate(input.promptTemplate),
    {
      change_summary: buildChangeSummary(input.gitStatus),
      current_branch: currentBranch,
      target_branch_ref: targetBranchRef,
      target_branch_name: targetBranchName,
      upstream_summary: buildUpstreamSummary(input.gitStatus),
    },
  );

  return {
    markdown,
    targetBranchName,
    targetBranchRef,
  };
}

export async function sendCreatePullRequestPrompt(input: SendCreatePullRequestPromptInput) {
  const [gitStatus, branchList] = await Promise.all([
    input.queryClient.fetchQuery(gitStatusQueryOptions(input.cwd)),
    input.queryClient.fetchQuery(gitBranchesQueryOptions(input.cwd)),
  ]);

  const prompt = buildCreatePullRequestPrompt({
    gitStatus,
    branches: branchList.branches,
    hasOriginRemote: branchList.hasOriginRemote,
    defaultPullRequestBaseBranch: input.defaultPullRequestBaseBranch,
    promptTemplate: input.promptTemplate,
  });

  await sendWorktreeThreadPrompt({
    targetThreadId: input.targetThreadId,
    worktreeId: input.worktreeId,
    projectId: input.projectId,
    projectModel: input.projectModel,
    prompt: DEFAULT_PULL_REQUEST_PROMPT_MESSAGE,
    attachments: [
      {
        type: "text",
        name: DEFAULT_PULL_REQUEST_ATTACHMENT_NAME,
        mimeType: "text/markdown",
        text: prompt.markdown,
      },
    ],
    isServerThread: input.isServerThread,
    draftThread: input.draftThread,
  });

  return prompt;
}
