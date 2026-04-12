import { CheckIcon, FolderGit2Icon, PencilIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import type { LinearProjectMapping } from "@t3tools/contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { AddRepositoryDialog } from "../AddRepositoryDialog";

function SettingsPageContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">{children}</div>
    </div>
  );
}

function SettingsSection({
  title,
  headerAction,
  children,
}: {
  title: string;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h2>
        {headerAction}
      </div>
      <div className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        {children}
      </div>
    </section>
  );
}

export function RepositoriesSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editBaseBranch, setEditBaseBranch] = useState("");
  const [editTeamKey, setEditTeamKey] = useState("");
  const [editRoutingLabels, setEditRoutingLabels] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const mappings = settings.linearProjectMappings.mappings;

  const startEditing = useCallback(
    (index: number) => {
      const mapping = mappings[index];
      if (!mapping) return;
      setEditingIndex(index);
      setEditBaseBranch(mapping.baseBranch ?? "");
      setEditTeamKey(mapping.teamKey ?? "");
      setEditRoutingLabels(mapping.routingLabels?.join(", ") ?? "");
    },
    [mappings],
  );

  const cancelEditing = useCallback(() => {
    setEditingIndex(null);
  }, []);

  const saveEditing = useCallback(() => {
    if (editingIndex === null) return;
    const updated = mappings.map((mapping, index) => {
      if (index !== editingIndex) return mapping;
      const labels = editRoutingLabels
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean);
      return {
        ...mapping,
        ...(editBaseBranch.trim() ? { baseBranch: editBaseBranch.trim() } : {}),
        ...(editTeamKey.trim() ? { teamKey: editTeamKey.trim() } : {}),
        ...(labels.length > 0 ? { routingLabels: labels } : {}),
      };
    });
    updateSettings({
      linearProjectMappings: {
        ...settings.linearProjectMappings,
        mappings: updated,
      },
    });
    setEditingIndex(null);
  }, [
    editBaseBranch,
    editRoutingLabels,
    editTeamKey,
    editingIndex,
    mappings,
    settings.linearProjectMappings,
    updateSettings,
  ]);

  const removeMapping = useCallback(
    (index: number) => {
      const updated = mappings.filter((_, i) => i !== index);
      updateSettings({
        linearProjectMappings: {
          ...settings.linearProjectMappings,
          mappings: updated,
        },
      });
      toastManager.add({
        type: "success",
        title: "Repository mapping removed",
      });
    },
    [mappings, settings.linearProjectMappings, updateSettings],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Repository Mappings"
        headerAction={
          <Button size="xs" variant="outline" onClick={() => setAddDialogOpen(true)}>
            <PlusIcon className="size-3.5" />
            Add Repository
          </Button>
        }
      >
        {mappings.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <FolderGit2Icon className="size-10 text-muted-foreground/30" />
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-foreground">No repositories configured</h3>
              <p className="max-w-sm text-xs text-muted-foreground">
                Add a Git repository to configure its Linear integration mapping, including team
                routing, base branch, and labels.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => setAddDialogOpen(true)}
            >
              <PlusIcon className="size-3.5" />
              Add Repository
            </Button>
          </div>
        ) : (
          mappings.map((mapping, index) => (
            <MappingRow
              key={mapping.workspaceRoot}
              mapping={mapping}
              isEditing={editingIndex === index}
              editBaseBranch={editBaseBranch}
              editTeamKey={editTeamKey}
              editRoutingLabels={editRoutingLabels}
              onEditBaseBranchChange={setEditBaseBranch}
              onEditTeamKeyChange={setEditTeamKey}
              onEditRoutingLabelsChange={setEditRoutingLabels}
              onStartEditing={() => startEditing(index)}
              onCancelEditing={cancelEditing}
              onSaveEditing={saveEditing}
              onRemove={() => removeMapping(index)}
            />
          ))
        )}
      </SettingsSection>

      <AddRepositoryDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
    </SettingsPageContainer>
  );
}

function MappingRow({
  mapping,
  isEditing,
  editBaseBranch,
  editTeamKey,
  editRoutingLabels,
  onEditBaseBranchChange,
  onEditTeamKeyChange,
  onEditRoutingLabelsChange,
  onStartEditing,
  onCancelEditing,
  onSaveEditing,
  onRemove,
}: {
  mapping: LinearProjectMapping;
  isEditing: boolean;
  editBaseBranch: string;
  editTeamKey: string;
  editRoutingLabels: string;
  onEditBaseBranchChange: (value: string) => void;
  onEditTeamKeyChange: (value: string) => void;
  onEditRoutingLabelsChange: (value: string) => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onSaveEditing: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="truncate font-mono text-sm font-medium text-foreground">
            {mapping.workspaceRoot}
          </h3>
          {!isEditing && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {mapping.baseBranch ? (
                <span>
                  Branch: <code className="text-foreground/80">{mapping.baseBranch}</code>
                </span>
              ) : null}
              {mapping.teamKey ? (
                <span>
                  Team: <code className="text-foreground/80">{mapping.teamKey}</code>
                </span>
              ) : null}
              {mapping.routingLabels && mapping.routingLabels.length > 0 ? (
                <span>
                  Labels:{" "}
                  <code className="text-foreground/80">{mapping.routingLabels.join(", ")}</code>
                </span>
              ) : null}
              {mapping.organizationId ? (
                <span>
                  Org: <code className="text-foreground/80">{mapping.organizationId}</code>
                </span>
              ) : null}
            </div>
          )}
        </div>
        {!isEditing && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="icon-xs" variant="ghost" onClick={onStartEditing} aria-label="Edit">
              <PencilIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onRemove}
              aria-label="Remove"
              className="text-muted-foreground hover:text-destructive"
            >
              <TrashIcon className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {isEditing && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="edit-base-branch" className="text-xs font-medium text-foreground">
                Base Branch
              </label>
              <Input
                id="edit-base-branch"
                value={editBaseBranch}
                onChange={(event) => onEditBaseBranchChange(event.target.value)}
                placeholder="auto-detect"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-team-key" className="text-xs font-medium text-foreground">
                Team Key
              </label>
              <Input
                id="edit-team-key"
                value={editTeamKey}
                onChange={(event) => onEditTeamKeyChange(event.target.value)}
                placeholder="AFF"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor="edit-routing-labels" className="text-xs font-medium text-foreground">
              Routing Labels
            </label>
            <Input
              id="edit-routing-labels"
              value={editRoutingLabels}
              onChange={(event) => onEditRoutingLabelsChange(event.target.value)}
              placeholder="label1, label2"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">Comma-separated.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="xs" onClick={onSaveEditing}>
              <CheckIcon className="size-3.5" />
              Save
            </Button>
            <Button size="xs" variant="outline" onClick={onCancelEditing}>
              <XIcon className="size-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
