import { type FormEvent, useCallback, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { toastManager } from "./ui/toast";

interface AddRepositoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (result: { projectId: string; title: string }) => void;
}

export function AddRepositoryDialog({ open, onOpenChange, onSuccess }: AddRepositoryDialogProps) {
  const [url, setUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [teamKey, setTeamKey] = useState("");
  const [routingLabelsInput, setRoutingLabelsInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const formId = "add-repository-form";

  const resetForm = useCallback(() => {
    setUrl("");
    setBaseBranch("");
    setTeamKey("");
    setRoutingLabelsInput("");
    setValidationError(null);
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        setValidationError("Repository URL is required.");
        return;
      }
      setValidationError(null);
      setIsSubmitting(true);
      try {
        const api = ensureNativeApi();
        const labels = routingLabelsInput
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean);
        const result = await api.projects.add({
          repositoryUrl: trimmedUrl,
          ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
          ...(teamKey.trim() ? { teamKey: teamKey.trim() } : {}),
          ...(labels.length > 0 ? { routingLabels: labels } : {}),
        });
        onOpenChange(false);
        onSuccess?.({ projectId: result.projectId, title: result.title });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "An error occurred while adding the repository.";
        toastManager.add({
          type: "error",
          title: "Failed to add repository",
          description: message,
        });
        setValidationError(message);
      } finally {
        setIsSubmitting(false);
      }
    },
    [baseBranch, onOpenChange, onSuccess, routingLabelsInput, teamKey, url],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          resetForm();
        }
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add Git Repository</DialogTitle>
          <DialogDescription>
            Clone a Git repository and configure its Linear integration mapping.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
            <div className="space-y-1.5">
              <Label htmlFor="repo-url">Repository URL</Label>
              <Input
                id="repo-url"
                autoFocus
                placeholder="https://github.com/org/repo.git"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (validationError) setValidationError(null);
                }}
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="repo-base-branch">Base Branch</Label>
              <Input
                id="repo-base-branch"
                placeholder="auto-detect"
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to auto-detect the default remote branch.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="repo-team-key">Team Key</Label>
              <Input
                id="repo-team-key"
                placeholder="AFF"
                value={teamKey}
                onChange={(event) => setTeamKey(event.target.value)}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Linear team key for issue routing (e.g. AFF, ENG).
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="repo-routing-labels">Routing Labels</Label>
              <Input
                id="repo-routing-labels"
                placeholder="label1, label2"
                value={routingLabelsInput}
                onChange={(event) => setRoutingLabelsInput(event.target.value)}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated labels for Linear issue routing.
              </p>
            </div>
            {validationError ? <p className="text-sm text-destructive">{validationError}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button form={formId} type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Adding..." : "Add Repository"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
