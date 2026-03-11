import { ProjectId } from "@repo/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { gitBranchesQueryOptions } from "../lib/gitReactQuery";
import { newCommandId } from "../lib/utils";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
} from "../components/BranchToolbar.logic";
import { SidebarInset } from "../components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import { Separator } from "../components/ui/separator";
import { isElectron } from "../env";

const UNSET_BRANCH_VALUE = "__unset__";

interface BranchOption {
  value: string;
  label: string;
  unavailable?: boolean;
}

function ReadOnlyPathField(props: { label: string; description: string; value: string }) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="text-sm font-medium text-foreground">{props.label}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{props.description}</p>
      </div>
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
        {props.value}
      </div>
    </div>
  );
}

function appendUnavailableOption(
  options: readonly BranchOption[],
  value: string | null,
): readonly BranchOption[] {
  if (!value || options.some((option) => option.value === value)) {
    return options;
  }

  return [...options, { value, label: `${value} (Unavailable)`, unavailable: true }];
}

function RepoSettingsRouteView() {
  const navigate = useNavigate();
  const projectId = Route.useParams({
    select: (params) => ProjectId.makeUnsafe(params.projectId),
  });
  const projects = useStore((store) => store.projects);
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  const branchesQuery = useQuery(gitBranchesQueryOptions(project?.cwd ?? null));
  const [savingField, setSavingField] = useState<"worktree" | "pr" | null>(null);

  useEffect(() => {
    if (project) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [navigate, project]);

  const gitBranches = useMemo(
    () => dedupeRemoteBranchesWithLocalMatches(branchesQuery.data?.branches ?? []),
    [branchesQuery.data?.branches],
  );

  const worktreeBranchOptions = useMemo(
    () =>
      appendUnavailableOption(
        gitBranches.map((branch) => ({
          value: branch.name,
          label: branch.name,
        })),
        project?.defaultWorktreeBaseBranch ?? null,
      ),
    [gitBranches, project?.defaultWorktreeBaseBranch],
  );

  const prBranchOptions = useMemo(() => {
    const deduped = new Map<string, BranchOption>();
    for (const branch of gitBranches) {
      const normalizedValue = branch.isRemote
        ? deriveLocalBranchNameFromRemoteRef(branch.name)
        : branch.name;
      if (deduped.has(normalizedValue)) {
        continue;
      }
      deduped.set(normalizedValue, {
        value: normalizedValue,
        label:
          branch.isRemote && normalizedValue !== branch.name
            ? `${normalizedValue} (from ${branch.name})`
            : normalizedValue,
      });
    }
    return appendUnavailableOption(
      [...deduped.values()],
      project?.defaultPullRequestBaseBranch ?? null,
    );
  }, [gitBranches, project?.defaultPullRequestBaseBranch]);

  const updateProjectSettings = useCallback(
    async (
      field: "worktree" | "pr",
      patch: {
        defaultWorktreeBaseBranch?: string | null;
        defaultPullRequestBaseBranch?: string | null;
      },
    ) => {
      if (!project) {
        return;
      }

      setSavingField(field);
      try {
        await ensureNativeApi().orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: project.id,
          ...patch,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to update repo settings",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      } finally {
        setSavingField((current) => (current === field ? null : current));
      }
    },
    [project],
  );

  if (!project) {
    return null;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Repo Settings
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {project.name}
              </h1>
              <p className="text-sm text-muted-foreground">
                Configure repo defaults for worktree creation and pull requests.
              </p>
            </header>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="space-y-5">
                <ReadOnlyPathField
                  label="Root path"
                  description="The main repository root for this project."
                  value={project.cwd}
                />

                <ReadOnlyPathField
                  label="Worktrees path"
                  description="Managed worktrees for this repo are created under this directory."
                  value={project.managedWorktreeRoot}
                />

                <Separator />

                <div className="space-y-2">
                  <div>
                    <h2 className="text-sm font-medium text-foreground">
                      Branch new worktrees from
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Used by the sidebar worktree button and as the default base branch for new
                      worktree threads.
                    </p>
                  </div>
                  <Select
                    value={project.defaultWorktreeBaseBranch ?? UNSET_BRANCH_VALUE}
                    onValueChange={(value) => {
                      void updateProjectSettings("worktree", {
                        defaultWorktreeBaseBranch: value === UNSET_BRANCH_VALUE ? null : value,
                      });
                    }}
                  >
                    <SelectTrigger disabled={savingField === "worktree"}>
                      <SelectValue>
                        {project.defaultWorktreeBaseBranch ?? "Use current checked-out branch"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNSET_BRANCH_VALUE}>
                        Use current checked-out branch
                      </SelectItem>
                      {worktreeBranchOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                <div className="space-y-2">
                  <div>
                    <h2 className="text-sm font-medium text-foreground">Create PRs to</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Default base branch used by this app when creating pull requests.
                    </p>
                  </div>
                  <Select
                    value={project.defaultPullRequestBaseBranch ?? UNSET_BRANCH_VALUE}
                    onValueChange={(value) => {
                      void updateProjectSettings("pr", {
                        defaultPullRequestBaseBranch: value === UNSET_BRANCH_VALUE ? null : value,
                      });
                    }}
                  >
                    <SelectTrigger disabled={savingField === "pr"}>
                      <SelectValue>
                        {project.defaultPullRequestBaseBranch ?? "Use inferred default branch"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNSET_BRANCH_VALUE}>
                        Use inferred default branch
                      </SelectItem>
                      {prBranchOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/projects/$projectId/settings")({
  component: RepoSettingsRouteView,
});
