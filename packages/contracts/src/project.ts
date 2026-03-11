import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_FILE_SHA256_LENGTH = 64;
const ProjectSha256 = TrimmedNonEmptyString.check(
  Schema.isPattern(new RegExp(`^[a-f0-9]{${PROJECT_FILE_SHA256_LENGTH}}$`, "i")),
);

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

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

export const ProjectListEntriesResult = ProjectSearchEntriesResult;
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
  expectedSha256: Schema.optional(ProjectSha256),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  sha256: ProjectSha256,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

const ProjectReadFileBase = Schema.Struct({
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  sizeBytes: NonNegativeInt,
  isBinary: Schema.Boolean,
  tooLarge: Schema.Boolean,
});

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    relativePath: ProjectReadFileBase.fields.relativePath,
    sizeBytes: ProjectReadFileBase.fields.sizeBytes,
    isBinary: Schema.Literal(false),
    tooLarge: Schema.Literal(false),
    contents: Schema.String,
    sha256: ProjectSha256,
  }),
  Schema.Struct({
    kind: Schema.Literal("binary"),
    relativePath: ProjectReadFileBase.fields.relativePath,
    sizeBytes: ProjectReadFileBase.fields.sizeBytes,
    isBinary: Schema.Literal(true),
    tooLarge: Schema.Literal(false),
  }),
  Schema.Struct({
    kind: Schema.Literal("too_large"),
    relativePath: ProjectReadFileBase.fields.relativePath,
    sizeBytes: ProjectReadFileBase.fields.sizeBytes,
    isBinary: Schema.Boolean,
    tooLarge: Schema.Literal(true),
  }),
]);
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;
