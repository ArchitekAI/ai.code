import type { GitArchiveWorktreeResult, GitUnarchiveWorktreeResult } from "@repo/contracts";
import { Effect, Layer } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { normalizeWorktreeWorkspacePath } from "../../orchestration/worktrees.ts";
import { type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { WorktreeArchiveMetadataRepository } from "../../persistence/Services/WorktreeArchiveMetadata.ts";
import { TerminalManager, type TerminalError } from "../../terminal/Services/Manager.ts";
import { WorktreeArchiveError } from "../Errors.ts";
import { GitCore } from "../Services/GitCore.ts";
import { GitService } from "../Services/GitService.ts";
import {
  WorktreeArchiveService,
  type WorktreeArchiveServiceShape,
} from "../Services/WorktreeArchive.ts";

const ARCHIVE_REF_PREFIX = "refs/t3code/worktree-archives";

function archiveRefForWorktree(worktreeId: string): string {
  return `${ARCHIVE_REF_PREFIX}/${worktreeId}`;
}

function worktreeArchiveError(
  operation: string,
  detail: string,
  cause?: unknown,
): WorktreeArchiveError {
  return new WorktreeArchiveError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toArchiveServiceError(operation: string) {
  return (cause: ProjectionRepositoryError | TerminalError): WorktreeArchiveError =>
    worktreeArchiveError(operation, cause.message, cause);
}

const makeWorktreeArchiveService = Effect.gen(function* () {
  const gitService = yield* GitService;
  const gitCore = yield* GitCore;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager;
  const metadataRepository = yield* WorktreeArchiveMetadataRepository;

  const executeGit = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    },
  ) =>
    gitService.execute({
      operation,
      cwd,
      args,
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    });

  const resolveHeadBranch = (cwd: string) =>
    executeGit(
      "WorktreeArchive.resolveHeadBranch",
      cwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      {
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.flatMap((result) => {
        if (result.code !== 0) {
          return Effect.fail(
            worktreeArchiveError(
              "archiveWorktree",
              "Only branch-backed worktrees can be archived.",
            ),
          );
        }
        const branch = result.stdout.trim();
        if (branch.length === 0) {
          return Effect.fail(
            worktreeArchiveError(
              "archiveWorktree",
              "Only branch-backed worktrees can be archived.",
            ),
          );
        }
        return Effect.succeed(branch);
      }),
    );

  const resolveHeadCommit = (cwd: string) =>
    executeGit("WorktreeArchive.resolveHeadCommit", cwd, ["rev-parse", "HEAD"]).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((headCommit) =>
        headCommit.length > 0
          ? Effect.succeed(headCommit)
          : Effect.fail(
              worktreeArchiveError("archiveWorktree", "Failed to resolve the current HEAD commit."),
            ),
      ),
    );

  const hasWorkingTreeChanges = (cwd: string) =>
    executeGit(
      "WorktreeArchive.hasWorkingTreeChanges",
      cwd,
      ["status", "--porcelain", "--untracked-files=all"],
      { maxOutputBytes: 4_000_000 },
    ).pipe(Effect.map((result) => result.stdout.trim().length > 0));

  const localBranchExists = (cwd: string, branch: string) =>
    executeGit(
      "WorktreeArchive.localBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.code === 0));

  const deleteArchiveRef = (cwd: string, ref: string) =>
    executeGit("WorktreeArchive.deleteArchiveRef", cwd, ["update-ref", "-d", ref]).pipe(
      Effect.asVoid,
    );

  const prepareArchiveSnapshot = (input: {
    readonly repoCwd: string;
    readonly worktreePath: string;
    readonly worktreeId: string;
  }) =>
    Effect.gen(function* () {
      const archiveMessage = `t3code-worktree-archive:${input.worktreeId}`;
      yield* executeGit(
        "WorktreeArchive.stashPush",
        input.worktreePath,
        ["stash", "push", "-u", "-m", archiveMessage],
        { maxOutputBytes: 4_000_000 },
      );

      const [stashRefResult, stashSubjectResult] = yield* Effect.all([
        executeGit("WorktreeArchive.resolveStashCommit", input.repoCwd, [
          "rev-parse",
          "--verify",
          "refs/stash",
        ]),
        executeGit("WorktreeArchive.resolveStashSubject", input.repoCwd, [
          "log",
          "-1",
          "--format=%gs",
          "refs/stash",
        ]),
      ]);
      const stashCommit = stashRefResult.stdout.trim();
      const stashSubject = stashSubjectResult.stdout.trim();
      if (stashCommit.length === 0 || !stashSubject.includes(archiveMessage)) {
        return yield* worktreeArchiveError(
          "archiveWorktree",
          "Failed to capture the worktree snapshot for archive.",
        );
      }

      const stashRef = archiveRefForWorktree(input.worktreeId);
      yield* executeGit("WorktreeArchive.storeSnapshotRef", input.repoCwd, [
        "update-ref",
        stashRef,
        stashCommit,
      ]);
      yield* executeGit("WorktreeArchive.dropVisibleStash", input.repoCwd, [
        "stash",
        "drop",
        "stash@{0}",
      ]);

      return stashRef;
    });

  const archiveWorktree: WorktreeArchiveServiceShape["archiveWorktree"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery
        .getSnapshot()
        .pipe(Effect.mapError(toArchiveServiceError("archiveWorktree")));
      const worktree = snapshot.worktrees.find((entry) => entry.id === input.worktreeId);
      if (!worktree || worktree.deletedAt !== null) {
        return yield* worktreeArchiveError("archiveWorktree", "Worktree no longer exists.");
      }
      if (worktree.isRoot) {
        return yield* worktreeArchiveError("archiveWorktree", "Root worktrees cannot be archived.");
      }
      if (worktree.archivedAt !== null) {
        return yield* worktreeArchiveError("archiveWorktree", "Worktree is already archived.");
      }
      const requestedPath = normalizeWorktreeWorkspacePath(input.path);
      const worktreePath = normalizeWorktreeWorkspacePath(worktree.workspacePath);
      if (requestedPath !== worktreePath) {
        return yield* worktreeArchiveError(
          "archiveWorktree",
          "Worktree path is out of date. Refresh and retry.",
        );
      }

      const liveThreads = snapshot.threads.filter(
        (thread) => thread.worktreeId === input.worktreeId && thread.deletedAt === null,
      );
      if (
        liveThreads.some(
          (thread) => thread.session?.status === "starting" || thread.session?.status === "running",
        )
      ) {
        return yield* worktreeArchiveError(
          "archiveWorktree",
          "Stop the active agent session before archiving this worktree.",
        );
      }

      const hasRunningTerminalSubprocess = yield* terminalManager
        .hasRunningSubprocessForThreads(liveThreads.map((thread) => thread.id))
        .pipe(Effect.mapError(toArchiveServiceError("archiveWorktree")));
      if (hasRunningTerminalSubprocess) {
        return yield* worktreeArchiveError(
          "archiveWorktree",
          "Stop the active terminal process before archiving this worktree.",
        );
      }

      const branch = yield* resolveHeadBranch(worktree.workspacePath);
      const headCommit = yield* resolveHeadCommit(worktree.workspacePath);
      const dirty = yield* hasWorkingTreeChanges(worktree.workspacePath);

      let stashRef: string | null = null;
      if (dirty) {
        stashRef = yield* prepareArchiveSnapshot({
          repoCwd: input.cwd,
          worktreePath: worktree.workspacePath,
          worktreeId: input.worktreeId,
        });
      }

      yield* metadataRepository
        .upsert({
          worktreeId: worktree.id,
          projectId: worktree.projectId,
          repoCwd: input.cwd,
          workspacePath: worktree.workspacePath,
          branch,
          headCommit,
          stashRef,
          archivedAt: new Date().toISOString(),
        })
        .pipe(Effect.mapError(toArchiveServiceError("archiveWorktree")));

      yield* gitCore
        .removeWorktree({
          cwd: input.cwd,
          path: worktree.workspacePath,
          force: true,
        })
        .pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              yield* metadataRepository
                .deleteById({ worktreeId: worktree.id })
                .pipe(Effect.mapError(toArchiveServiceError("archiveWorktree")), Effect.ignore);
              if (stashRef) {
                yield* deleteArchiveRef(input.cwd, stashRef).pipe(Effect.ignore);
              }
            }),
          ),
        );

      return {
        worktree: {
          path: worktree.workspacePath,
          branch,
        },
      } satisfies GitArchiveWorktreeResult;
    });

  const unarchiveWorktree: WorktreeArchiveServiceShape["unarchiveWorktree"] = (input) =>
    Effect.gen(function* () {
      const metadata = yield* metadataRepository
        .getById({ worktreeId: input.worktreeId })
        .pipe(Effect.mapError(toArchiveServiceError("unarchiveWorktree")));
      if (metadata._tag === "None") {
        return yield* worktreeArchiveError(
          "unarchiveWorktree",
          "No archived worktree snapshot was found.",
        );
      }

      const archived = metadata.value;
      if (!archived.branch) {
        return yield* worktreeArchiveError(
          "unarchiveWorktree",
          "Archived worktree is missing its branch metadata.",
        );
      }

      const branchExists = yield* localBranchExists(input.cwd, archived.branch);
      yield* executeGit(
        "WorktreeArchive.restoreWorktree",
        input.cwd,
        branchExists
          ? ["worktree", "add", archived.workspacePath, archived.branch]
          : ["worktree", "add", "-b", archived.branch, archived.workspacePath, archived.headCommit],
        { timeoutMs: 45_000, maxOutputBytes: 4_000_000 },
      );

      let warning: string | null = null;
      if (archived.stashRef) {
        const applyResult = yield* executeGit(
          "WorktreeArchive.applySnapshot",
          archived.workspacePath,
          ["stash", "apply", "--index", archived.stashRef],
          {
            allowNonZeroExit: true,
            timeoutMs: 45_000,
            maxOutputBytes: 4_000_000,
          },
        );
        if (applyResult.code === 0) {
          yield* deleteArchiveRef(input.cwd, archived.stashRef);
          yield* metadataRepository
            .deleteById({ worktreeId: archived.worktreeId })
            .pipe(Effect.mapError(toArchiveServiceError("unarchiveWorktree")));
        } else {
          const detail = [applyResult.stderr.trim(), applyResult.stdout.trim()]
            .filter((value) => value.length > 0)
            .join("\n");
          warning =
            detail.length > 0
              ? `Restored the worktree, but replaying archived changes needs manual resolution.\n${detail}`
              : "Restored the worktree, but replaying archived changes needs manual resolution.";
        }
      } else {
        yield* metadataRepository
          .deleteById({ worktreeId: archived.worktreeId })
          .pipe(Effect.mapError(toArchiveServiceError("unarchiveWorktree")));
      }

      return {
        worktree: {
          path: archived.workspacePath,
          branch: archived.branch,
        },
        warning,
      } satisfies GitUnarchiveWorktreeResult;
    });

  return {
    archiveWorktree,
    unarchiveWorktree,
  } satisfies WorktreeArchiveServiceShape;
});

export const WorktreeArchiveServiceLive = Layer.effect(
  WorktreeArchiveService,
  makeWorktreeArchiveService,
);
