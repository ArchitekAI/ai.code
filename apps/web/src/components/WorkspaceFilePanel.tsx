import type { IDockviewPanelProps } from "dockview";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { useTheme } from "../hooks/useTheme";
import { projectQueryKeys, projectReadFileQueryOptions } from "../lib/projectReactQuery";
import { readNativeApi } from "../nativeApi";
import { preferredTerminalEditor, resolvePathLinkTarget } from "../terminal-links";
import { useWorkspaceDockPanelStore } from "../workspaceDockPanelStore";
import type { WorktreeDockFilePanelParams } from "../worktreeChatLayoutStore";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

const WorkspaceCodeEditorSurface = lazy(() => import("./WorkspaceCodeEditorSurface"));

interface WorkspaceFilePanelProps extends IDockviewPanelProps<WorktreeDockFilePanelParams> {
  cwd: string | null;
}

function renderUnsupportedState(input: {
  kind: "binary" | "too_large";
  relativePath: string;
  sizeBytes: number;
  onOpenExternal: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          {input.kind === "binary"
            ? "Binary file preview is unavailable."
            : "File is too large to edit here."}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {input.relativePath} · {input.sizeBytes.toLocaleString()} bytes
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={input.onOpenExternal}>
        Open in editor
      </Button>
    </div>
  );
}

export default function WorkspaceFilePanel({ api, params, cwd }: WorkspaceFilePanelProps) {
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const setPanelMeta = useWorkspaceDockPanelStore((state) => state.setMeta);
  const clearPanelMeta = useWorkspaceDockPanelStore((state) => state.clearMeta);
  const [draftText, setDraftText] = useState("");
  const [loadedSha, setLoadedSha] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const fileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd,
      relativePath: params.relativePath,
      enabled: cwd !== null,
    }),
  );

  const fileResult = fileQuery.data;
  const theme = resolvedTheme === "dark" ? "vs-dark" : "light";
  const isTextFile = fileResult?.kind === "text";
  const dirty = isTextFile ? draftText !== fileResult.contents : false;

  useEffect(() => {
    api.setTitle(params.title ?? params.relativePath.split("/").at(-1) ?? params.relativePath);
  }, [api, params.relativePath, params.title]);

  useEffect(() => {
    if (!isTextFile) {
      setDraftText("");
      setLoadedSha(null);
      setConflictMessage(null);
      return;
    }

    if (loadedSha === null || (!dirty && loadedSha !== fileResult.sha256)) {
      setDraftText(fileResult.contents);
      setLoadedSha(fileResult.sha256);
      setConflictMessage(null);
    }
  }, [dirty, fileResult, isTextFile, loadedSha]);

  useEffect(() => {
    setPanelMeta(api.id, { dirty });
    return () => {
      clearPanelMeta(api.id);
    };
  }, [api.id, clearPanelMeta, dirty, setPanelMeta]);

  const openExternal = useCallback(() => {
    const nativeApi = readNativeApi();
    if (!nativeApi || !cwd) {
      return;
    }
    void nativeApi.shell
      .openInEditor(resolvePathLinkTarget(params.relativePath, cwd), preferredTerminalEditor())
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An unknown error occurred.",
        });
      });
  }, [cwd, params.relativePath]);

  const saveMutation = useMutation({
    mutationFn: async (overwrite: boolean) => {
      const nativeApi = readNativeApi();
      if (!nativeApi || !cwd || !isTextFile) {
        throw new Error("File saving is unavailable.");
      }
      return nativeApi.projects.writeFile({
        cwd,
        relativePath: params.relativePath,
        contents: draftText,
        ...(overwrite || !loadedSha ? {} : { expectedSha256: loadedSha }),
      });
    },
    onSuccess: (result) => {
      if (!isTextFile) {
        return;
      }
      setLoadedSha(result.sha256);
      setConflictMessage(null);
      queryClient.setQueryData(projectQueryKeys.readFile(cwd, params.relativePath), {
        kind: "text",
        relativePath: params.relativePath,
        sizeBytes: new TextEncoder().encode(draftText).byteLength,
        isBinary: false,
        tooLarge: false,
        contents: draftText,
        sha256: result.sha256,
      });
    },
    onError: (error) => {
      const description = error instanceof Error ? error.message : "An unknown error occurred.";
      const isConflict = description.includes("Reload it before saving again");
      setConflictMessage(isConflict ? description : null);
      toastManager.add({
        type: "error",
        title: isConflict ? "Save conflict" : "Unable to save file",
        description,
      });
    },
  });

  const reloadFromDisk = useCallback(async () => {
    const result = await fileQuery.refetch();
    if (result.data?.kind === "text") {
      setDraftText(result.data.contents);
      setLoadedSha(result.data.sha256);
      setConflictMessage(null);
    }
  }, [fileQuery]);

  const editorValue = useMemo(() => (isTextFile ? draftText : ""), [draftText, isTextFile]);

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      onPointerDownCapture={() => api.setActive()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{params.relativePath}</div>
          <div className="text-[11px] text-muted-foreground">
            {dirty ? "Unsaved changes" : "Saved"}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={fileQuery.isFetching}
            onClick={() => {
              void reloadFromDisk();
            }}
          >
            <RefreshCwIcon className="mr-1.5 size-3.5" />
            Reload
          </Button>
          <Button size="sm" variant="outline" onClick={openExternal}>
            Open in editor
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saveMutation.isPending || !isTextFile}
            onClick={() => {
              void saveMutation.mutateAsync(false);
            }}
          >
            {saveMutation.isPending ? (
              <LoaderIcon className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <SaveIcon className="mr-1.5 size-3.5" />
            )}
            Save
          </Button>
        </div>
      </div>
      {conflictMessage ? (
        <div className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="min-w-0">{conflictMessage}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void reloadFromDisk()}>
              Reload from disk
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void saveMutation.mutateAsync(true)}
            >
              Overwrite anyway
            </Button>
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {fileQuery.isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <LoaderIcon className="mr-2 size-4 animate-spin" />
            Loading file…
          </div>
        ) : fileResult?.kind === "binary" || fileResult?.kind === "too_large" ? (
          renderUnsupportedState({
            kind: fileResult.kind,
            relativePath: fileResult.relativePath,
            sizeBytes: fileResult.sizeBytes,
            onOpenExternal: openExternal,
          })
        ) : isTextFile ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <LoaderIcon className="mr-2 size-4 animate-spin" />
                Loading editor…
              </div>
            }
          >
            <WorkspaceCodeEditorSurface
              mode="file"
              path={params.relativePath}
              theme={theme}
              value={editorValue}
              onChange={setDraftText}
              onSave={() => {
                if (!dirty || saveMutation.isPending) {
                  return;
                }
                void saveMutation.mutateAsync(false);
              }}
            />
          </Suspense>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            File preview is unavailable.
          </div>
        )}
      </div>
    </div>
  );
}
