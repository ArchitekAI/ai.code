import type {
  ModelSelection,
  ProjectAddInput,
  ProjectAddResult,
  ProjectId,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface EnsureProjectForWorkspaceRootResult {
  readonly projectId: ProjectId;
  readonly projectCreated: boolean;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection;
}

export interface ProjectOnboardingShape {
  readonly addRepository: (input: ProjectAddInput) => Effect.Effect<ProjectAddResult, Error>;
  readonly ensureProjectForWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<EnsureProjectForWorkspaceRootResult, Error>;
}

export class ProjectOnboarding extends ServiceMap.Service<
  ProjectOnboarding,
  ProjectOnboardingShape
>()("t3/project/ProjectOnboarding") {}
