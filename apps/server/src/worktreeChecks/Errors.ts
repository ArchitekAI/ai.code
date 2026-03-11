import { Schema } from "effect";

export class WorktreeChecksError extends Schema.TaggedErrorClass<WorktreeChecksError>()(
  "WorktreeChecksError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Worktree checks failed in ${this.operation}: ${this.detail}`;
  }
}
