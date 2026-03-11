import { ProjectId, WorktreeId, type OrchestrationReadModel } from "@repo/contracts";
import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { expect } from "vitest";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WorktreeArchiveMetadataRepository,
  type WorktreeArchiveMetadataRepositoryShape,
} from "../../persistence/Services/WorktreeArchiveMetadata.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { WorktreeArchiveError } from "../Errors.ts";
import { GitCore } from "../Services/GitCore.ts";
import { GitService, type GitServiceShape } from "../Services/GitService.ts";
import { WorktreeArchiveService } from "../Services/WorktreeArchive.ts";
import { WorktreeArchiveServiceLive } from "./WorktreeArchive.ts";

const now = "2026-03-11T12:00:00.000Z";
const projectId = ProjectId.makeUnsafe("project-archive");
const worktreeId = WorktreeId.makeUnsafe("worktree-archive");

const snapshot: OrchestrationReadModel = {
  snapshotSequence: 1,
  projects: [],
  worktrees: [
    {
      id: worktreeId,
      projectId,
      workspacePath: "/repo/worktrees/feature",
      branch: "feature/archive",
      isRoot: false,
      branchRenamePending: false,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    },
  ],
  threads: [],
  updatedAt: now,
};

function makeMetadataRepository(): WorktreeArchiveMetadataRepositoryShape {
  return {
    upsert: () => Effect.void,
    getById: () => Effect.succeed(Option.none()),
    deleteById: () => Effect.void,
    deleteByProjectId: () => Effect.void,
  };
}

function makeLayer(gitService: GitServiceShape) {
  return WorktreeArchiveServiceLive.pipe(
    Layer.provideMerge(Layer.succeed(GitService, gitService)),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getSnapshot: () => Effect.succeed(snapshot),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(TerminalManager, {
        hasRunningSubprocessForThreads: () => Effect.succeed(false),
        dispose: Effect.void,
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(GitCore, {
        removeWorktree: () => Effect.void,
      } as never),
    ),
    Layer.provideMerge(Layer.succeed(WorktreeArchiveMetadataRepository, makeMetadataRepository())),
  );
}

it.effect(
  "returns a concrete archive error when git reports dirt but does not create a stash",
  () => {
    let visibleStashLookups = 0;
    const gitService: GitServiceShape = {
      execute: (input) => {
        switch (input.operation) {
          case "WorktreeArchive.resolveHeadBranch":
            return Effect.succeed({ code: 0, stdout: "feature/archive\n", stderr: "" });
          case "WorktreeArchive.resolveHeadCommit":
            return Effect.succeed({ code: 0, stdout: "abc123\n", stderr: "" });
          case "WorktreeArchive.hasWorkingTreeChanges":
            return Effect.succeed({ code: 0, stdout: " M deps/submodule\n", stderr: "" });
          case "WorktreeArchive.resolveVisibleStashCommit":
            visibleStashLookups += 1;
            return Effect.succeed({
              code: 0,
              stdout: "existing-stash\n",
              stderr: "",
            });
          case "WorktreeArchive.stashPush":
            return Effect.succeed({
              code: 0,
              stdout: "No local changes to save\n",
              stderr: "",
            });
          default:
            throw new Error(`unexpected git operation: ${input.operation}`);
        }
      },
    };

    return Effect.gen(function* () {
      const service = yield* WorktreeArchiveService;
      const error = yield* service
        .archiveWorktree({
          cwd: "/repo",
          worktreeId,
          path: "/repo/worktrees/feature",
        })
        .pipe(Effect.flip);

      expect(visibleStashLookups).toBe(2);
      expect(error).toBeInstanceOf(WorktreeArchiveError);
      expect(error.message).toContain("Failed to capture the worktree snapshot for archive.");
      expect(error.message).toContain("No local changes to save");
    }).pipe(Effect.provide(makeLayer(gitService)));
  },
);
