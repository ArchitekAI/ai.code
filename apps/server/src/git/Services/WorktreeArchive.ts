import type {
  GitArchiveWorktreeInput,
  GitArchiveWorktreeResult,
  GitUnarchiveWorktreeInput,
  GitUnarchiveWorktreeResult,
} from "@repo/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { WorktreeArchiveServiceError } from "../Errors.ts";

export interface WorktreeArchiveServiceShape {
  readonly archiveWorktree: (
    input: GitArchiveWorktreeInput,
  ) => Effect.Effect<GitArchiveWorktreeResult, WorktreeArchiveServiceError>;
  readonly unarchiveWorktree: (
    input: GitUnarchiveWorktreeInput,
  ) => Effect.Effect<GitUnarchiveWorktreeResult, WorktreeArchiveServiceError>;
}

export class WorktreeArchiveService extends ServiceMap.Service<
  WorktreeArchiveService,
  WorktreeArchiveServiceShape
>()("t3/git/Services/WorktreeArchive/WorktreeArchiveService") {}
