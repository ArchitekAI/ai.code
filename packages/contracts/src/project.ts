import { Schema } from "effect";
import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_REPOSITORY_URL_MAX_LENGTH = 2048;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectAddInput = Schema.Struct({
  repositoryUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_REPOSITORY_URL_MAX_LENGTH)),
  baseBranch: Schema.optional(TrimmedNonEmptyString),
  routeKey: Schema.optional(TrimmedNonEmptyString),
  routeAliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  routingLabels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  organizationId: Schema.optional(TrimmedNonEmptyString),
  teamKey: Schema.optional(TrimmedNonEmptyString),
  labelName: Schema.optional(TrimmedNonEmptyString),
  projectKeys: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type ProjectAddInput = typeof ProjectAddInput.Type;

export const ProjectAddResult = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  cloned: Schema.Boolean,
  mappingAdded: Schema.Boolean,
  projectCreated: Schema.Boolean,
});
export type ProjectAddResult = typeof ProjectAddResult.Type;

export class ProjectAddError extends Schema.TaggedErrorClass<ProjectAddError>()("ProjectAddError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
