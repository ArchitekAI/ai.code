import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  WorktreeId,
} from "./baseSchemas";
import { GitStatusResult } from "./git";

export const WorktreeChecksGetInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  worktreeId: WorktreeId,
});
export type WorktreeChecksGetInput = typeof WorktreeChecksGetInput.Type;

export const WorktreeChecksTodoId = TrimmedNonEmptyString;
export type WorktreeChecksTodoId = typeof WorktreeChecksTodoId.Type;

export const WorktreeChecksState = Schema.Literals([
  "pending",
  "in_progress",
  "success",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
  "unknown",
]);
export type WorktreeChecksState = typeof WorktreeChecksState.Type;

export const WorktreeChecksPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  reviewUrl: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  reviewDecision: Schema.NullOr(TrimmedNonEmptyString),
  isDraft: Schema.Boolean,
});
export type WorktreeChecksPullRequest = typeof WorktreeChecksPullRequest.Type;

export const WorktreeChecksDeployment = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  environment: Schema.NullOr(TrimmedNonEmptyString),
  state: WorktreeChecksState,
  previewUrl: Schema.NullOr(TrimmedNonEmptyString),
  detailsUrl: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type WorktreeChecksDeployment = typeof WorktreeChecksDeployment.Type;

export const WorktreeChecksItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  source: Schema.NullOr(TrimmedNonEmptyString),
  state: WorktreeChecksState,
  runtimeSeconds: Schema.NullOr(NonNegativeInt),
  linkUrl: Schema.NullOr(TrimmedNonEmptyString),
  description: Schema.NullOr(Schema.String),
});
export type WorktreeChecksItem = typeof WorktreeChecksItem.Type;

export const WorktreeChecksComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["comment", "review"]),
  author: TrimmedNonEmptyString,
  bodyPreview: Schema.String,
  createdAt: IsoDateTime,
  url: TrimmedNonEmptyString,
});
export type WorktreeChecksComment = typeof WorktreeChecksComment.Type;

export const WorktreeChecksTodo = Schema.Struct({
  todoId: WorktreeChecksTodoId,
  worktreeId: WorktreeId,
  text: TrimmedNonEmptyString,
  completed: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorktreeChecksTodo = typeof WorktreeChecksTodo.Type;

export const WorktreeChecksGetResult = Schema.Struct({
  gitStatus: GitStatusResult,
  pr: Schema.NullOr(WorktreeChecksPullRequest),
  deployments: Schema.Array(WorktreeChecksDeployment),
  checks: Schema.Array(WorktreeChecksItem),
  comments: Schema.Array(WorktreeChecksComment),
  todos: Schema.Array(WorktreeChecksTodo),
  githubUnavailableReason: Schema.NullOr(Schema.String),
});
export type WorktreeChecksGetResult = typeof WorktreeChecksGetResult.Type;

export const WorktreeChecksAddTodoInput = Schema.Struct({
  worktreeId: WorktreeId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type WorktreeChecksAddTodoInput = typeof WorktreeChecksAddTodoInput.Type;

export const WorktreeChecksAddTodoResult = Schema.Struct({
  todo: WorktreeChecksTodo,
});
export type WorktreeChecksAddTodoResult = typeof WorktreeChecksAddTodoResult.Type;

export const WorktreeChecksUpdateTodoInput = Schema.Struct({
  worktreeId: WorktreeId,
  todoId: WorktreeChecksTodoId,
  text: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  completed: Schema.optional(Schema.Boolean),
});
export type WorktreeChecksUpdateTodoInput = typeof WorktreeChecksUpdateTodoInput.Type;

export const WorktreeChecksUpdateTodoResult = Schema.Struct({
  todo: WorktreeChecksTodo,
});
export type WorktreeChecksUpdateTodoResult = typeof WorktreeChecksUpdateTodoResult.Type;

export const WorktreeChecksDeleteTodoInput = Schema.Struct({
  worktreeId: WorktreeId,
  todoId: WorktreeChecksTodoId,
});
export type WorktreeChecksDeleteTodoInput = typeof WorktreeChecksDeleteTodoInput.Type;

export const WorktreeChecksDeleteTodoResult = Schema.Struct({
  deletedTodoId: WorktreeChecksTodoId,
});
export type WorktreeChecksDeleteTodoResult = typeof WorktreeChecksDeleteTodoResult.Type;
