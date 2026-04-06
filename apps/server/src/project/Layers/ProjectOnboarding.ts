import {
  CommandId,
  LinearProjectMapping,
  ProjectAddError,
  ProjectId,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import type { ProjectAddInput, ProjectAddResult } from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { BootstrapTurnService } from "../../orchestration/Services/BootstrapTurnService.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectOnboarding, type ProjectOnboardingShape } from "../Services/ProjectOnboarding.ts";

const DEFAULT_PROJECT_MODEL_SELECTION = {
  provider: "codex" as const,
  model: "gpt-5-codex" as const,
};

function normalizeStringList(values: ReadonlyArray<string> | undefined): Array<string> | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  const next = Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  );
  return next.length > 0 ? next : undefined;
}

function deriveRepositoryName(repositoryUrl: string): string | null {
  const trimmedUrl = repositoryUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const segments = trimmedUrl.split(/[/:]/g).filter((segment) => segment.length > 0);
  const rawName = segments.at(-1)?.trim();
  if (!rawName) {
    return null;
  }

  const sanitized = rawName.replace(/[^a-zA-Z0-9._-]/g, "-");
  return sanitized.length > 0 ? sanitized : null;
}

function compactLinearProjectMapping(
  mapping: LinearProjectMapping | Record<string, unknown>,
): LinearProjectMapping {
  const record = mapping as Partial<LinearProjectMapping>;
  return {
    workspaceRoot: record.workspaceRoot ?? "",
    ...(record.baseBranch ? { baseBranch: record.baseBranch } : {}),
    ...(record.organizationId ? { organizationId: record.organizationId } : {}),
    ...(record.teamKey ? { teamKey: record.teamKey } : {}),
    ...(record.labelName ? { labelName: record.labelName } : {}),
    ...(record.routeKey ? { routeKey: record.routeKey } : {}),
    ...(record.routeAliases ? { routeAliases: record.routeAliases } : {}),
    ...(record.routingLabels ? { routingLabels: record.routingLabels } : {}),
    ...(record.projectKeys ? { projectKeys: record.projectKeys } : {}),
    ...(record.promptLabels ? { promptLabels: record.promptLabels } : {}),
    ...(record.toolPolicy ? { toolPolicy: record.toolPolicy } : {}),
  };
}

const makeProjectOnboarding = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const git = yield* GitCore;
  const bootstrapTurnService = yield* BootstrapTurnService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const startup = yield* ServerRuntimeStartup;

  const dispatchProjectCreate = Effect.fn("ProjectOnboarding.dispatchProjectCreate")(function* (
    command: Parameters<typeof bootstrapTurnService.dispatch>[0],
  ) {
    return yield* startup
      .enqueueCommand(bootstrapTurnService.dispatch(command))
      .pipe(Effect.mapError((cause) => new Error(`Failed to create project: ${String(cause)}`)));
  });

  const detectBaseBranch = Effect.fn("ProjectOnboarding.detectBaseBranch")(function* (
    workspaceRoot: string,
  ) {
    const symbolicRef = yield* git.execute({
      operation: "detect remote HEAD",
      cwd: workspaceRoot,
      args: ["symbolic-ref", "refs/remotes/origin/HEAD"],
      allowNonZeroExit: true,
    });
    if (symbolicRef.code === 0) {
      const branch = symbolicRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "");
      if (branch.length > 0) {
        return branch;
      }
    }

    const remoteShow = yield* git.execute({
      operation: "read remote metadata",
      cwd: workspaceRoot,
      args: ["remote", "show", "origin"],
      allowNonZeroExit: true,
      maxOutputBytes: 256_000,
      truncateOutputAtMaxBytes: true,
    });
    if (remoteShow.code === 0) {
      const match = remoteShow.stdout.match(/HEAD branch:\s*(.+)/);
      const branch = match?.[1]?.trim();
      if (branch) {
        return branch;
      }
    }

    // Keep repo onboarding deterministic even when the remote does not advertise HEAD.
    return "main";
  });

  const ensureRepositoryCheckout = Effect.fn("ProjectOnboarding.ensureRepositoryCheckout")(
    function* (repositoryUrl: string, workspaceRoot: string) {
      if (yield* fs.exists(workspaceRoot)) {
        const isGitRepository = yield* git.isInsideWorkTree(workspaceRoot);
        if (!isGitRepository) {
          return yield* Effect.fail(
            new Error(
              `Repository target already exists and is not a git checkout: ${workspaceRoot}`,
            ),
          );
        }
        return false;
      }

      const reposDir = path.dirname(workspaceRoot);
      yield* fs.makeDirectory(reposDir, { recursive: true });
      // Clone into the managed repos directory so settings-based routing and server projects agree.
      yield* git.execute({
        operation: "clone repository",
        cwd: reposDir,
        args: ["clone", repositoryUrl, workspaceRoot],
        maxOutputBytes: 512_000,
        truncateOutputAtMaxBytes: true,
      });
      return true;
    },
  );

  const ensureProjectForWorkspaceRoot: ProjectOnboardingShape["ensureProjectForWorkspaceRoot"] =
    Effect.fn("ProjectOnboarding.ensureProjectForWorkspaceRoot")(function* (workspaceRoot) {
      const existingProject =
        yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(workspaceRoot);
      if (Option.isSome(existingProject)) {
        return {
          projectId: existingProject.value.id,
          projectCreated: false,
          title: existingProject.value.title,
          workspaceRoot,
          defaultModelSelection:
            existingProject.value.defaultModelSelection ?? DEFAULT_PROJECT_MODEL_SELECTION,
        };
      }

      const createdAt = new Date().toISOString();
      const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
      const title = path.basename(workspaceRoot) || "project";

      yield* dispatchProjectCreate({
        type: "project.create",
        commandId: CommandId.makeUnsafe(`project-onboarding:${crypto.randomUUID()}`),
        projectId,
        title,
        workspaceRoot,
        defaultModelSelection: DEFAULT_PROJECT_MODEL_SELECTION,
        createdAt,
      });

      return {
        projectId,
        projectCreated: true,
        title,
        workspaceRoot,
        defaultModelSelection: DEFAULT_PROJECT_MODEL_SELECTION,
      };
    });

  const persistLinearMapping = Effect.fn("ProjectOnboarding.persistLinearMapping")(
    function* (input: {
      readonly repositoryName: string;
      readonly workspaceRoot: string;
      readonly baseBranch: string;
      readonly projectAddInput: ProjectAddInput;
    }) {
      const settings = yield* serverSettings.getSettings;
      const existingIndex = settings.linearProjectMappings.mappings.findIndex(
        (mapping) => mapping.workspaceRoot === input.workspaceRoot,
      );
      const existingMapping =
        existingIndex >= 0 ? settings.linearProjectMappings.mappings[existingIndex] : null;

      const nextRoutingLabels = normalizeStringList(input.projectAddInput.routingLabels) ??
        existingMapping?.routingLabels ?? [input.repositoryName];
      const nextRouteAliases = normalizeStringList(input.projectAddInput.routeAliases);
      const nextProjectKeys = normalizeStringList(input.projectAddInput.projectKeys);
      const resolvedBaseBranch =
        // Prefer an explicit override, otherwise keep the saved mapping aligned with the
        // repository's advertised default branch instead of preserving a stale feature branch.
        input.projectAddInput.baseBranch?.trim() || input.baseBranch || existingMapping?.baseBranch;
      const resolvedRouteKey =
        input.projectAddInput.routeKey?.trim() || existingMapping?.routeKey || input.repositoryName;
      const resolvedRouteAliases = nextRouteAliases ?? existingMapping?.routeAliases;
      const resolvedOrganizationId =
        input.projectAddInput.organizationId || existingMapping?.organizationId;
      const resolvedTeamKey = input.projectAddInput.teamKey || existingMapping?.teamKey;
      const resolvedLabelName = input.projectAddInput.labelName || existingMapping?.labelName;
      const resolvedProjectKeys = nextProjectKeys ?? existingMapping?.projectKeys;
      const nextMapping = {
        workspaceRoot: input.workspaceRoot,
        // Persist the resolved base branch so future Linear sessions stay deterministic.
        ...(resolvedBaseBranch ? { baseBranch: resolvedBaseBranch } : {}),
        ...(resolvedRouteKey ? { routeKey: resolvedRouteKey } : {}),
        ...(nextRoutingLabels.length > 0 ? { routingLabels: nextRoutingLabels } : {}),
        ...(resolvedRouteAliases ? { routeAliases: resolvedRouteAliases } : {}),
        ...(resolvedOrganizationId ? { organizationId: resolvedOrganizationId } : {}),
        ...(resolvedTeamKey ? { teamKey: resolvedTeamKey } : {}),
        ...(resolvedLabelName ? { labelName: resolvedLabelName } : {}),
        ...(resolvedProjectKeys ? { projectKeys: resolvedProjectKeys } : {}),
        ...(existingMapping?.promptLabels ? { promptLabels: existingMapping.promptLabels } : {}),
        ...(existingMapping?.toolPolicy ? { toolPolicy: existingMapping.toolPolicy } : {}),
      } satisfies LinearProjectMapping;

      const nextMappings = Schema.decodeUnknownSync(Schema.Array(LinearProjectMapping))(
        existingIndex >= 0
          ? settings.linearProjectMappings.mappings.map((mapping, index) =>
              index === existingIndex ? nextMapping : compactLinearProjectMapping(mapping),
            )
          : [
              ...settings.linearProjectMappings.mappings.map((mapping) =>
                compactLinearProjectMapping(mapping),
              ),
              nextMapping,
            ],
      );

      const settingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch)({
        linearProjectMappings: {
          mappings: nextMappings,
          defaultWorkspaceRoot:
            settings.linearProjectMappings.defaultWorkspaceRoot || input.workspaceRoot,
        },
      });
      yield* serverSettings.updateSettings(settingsPatch);

      return {
        mappingAdded: existingIndex < 0,
        baseBranch: nextMapping.baseBranch ?? input.baseBranch,
      };
    },
  );

  const addRepository: ProjectOnboardingShape["addRepository"] = (projectAddInput) =>
    Effect.gen(function* () {
      const repositoryName = deriveRepositoryName(projectAddInput.repositoryUrl);
      if (!repositoryName) {
        return yield* new ProjectAddError({
          message: "Could not determine a repository name from the provided URL.",
        });
      }

      const workspaceRoot = path.join(config.baseDir, "repos", repositoryName);
      const cloned = yield* ensureRepositoryCheckout(
        projectAddInput.repositoryUrl,
        workspaceRoot,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectAddError({
              message:
                cause instanceof Error ? cause.message : "Failed to prepare repository checkout.",
              cause,
            }),
        ),
      );
      const detectedBaseBranch =
        projectAddInput.baseBranch?.trim() ||
        (yield* detectBaseBranch(workspaceRoot).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectAddError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Failed to detect the repository base branch.",
                cause,
              }),
          ),
        ));

      const { mappingAdded, baseBranch } = yield* persistLinearMapping({
        repositoryName,
        workspaceRoot,
        baseBranch: detectedBaseBranch,
        projectAddInput,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectAddError({
              message:
                cause instanceof Error ? cause.message : "Failed to persist repository mapping.",
              cause,
            }),
        ),
      );

      const project = yield* ensureProjectForWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectAddError({
              message: cause instanceof Error ? cause.message : "Failed to create project.",
              cause,
            }),
        ),
      );

      return {
        projectId: project.projectId,
        title: project.title,
        workspaceRoot,
        baseBranch,
        cloned,
        mappingAdded,
        projectCreated: project.projectCreated,
      } satisfies ProjectAddResult;
    });

  return {
    addRepository,
    ensureProjectForWorkspaceRoot,
  } satisfies ProjectOnboardingShape;
});

export const ProjectOnboardingLive = Layer.effect(ProjectOnboarding, makeProjectOnboarding);
