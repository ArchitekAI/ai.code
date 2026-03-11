import type { IDockviewPanelProps } from "dockview";
import { useQuery } from "@tanstack/react-query";
import { Columns2Icon, LoaderIcon, Rows3Icon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { useTheme } from "../hooks/useTheme";
import { gitWorkingTreeFileDiffQueryOptions } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { preferredTerminalEditor, resolvePathLinkTarget } from "../terminal-links";
import type { WorktreeDockDiffPanelParams } from "../worktreeChatLayoutStore";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle";
import { toastManager } from "./ui/toast";

const WorkspaceCodeEditorSurface = lazy(() => import("./WorkspaceCodeEditorSurface"));

interface WorkspaceDiffPanelProps extends IDockviewPanelProps<WorktreeDockDiffPanelParams> {
  cwd: string | null;
  onOpenFile: (relativePath: string) => void;
}

export default function WorkspaceDiffPanel({
  api,
  params,
  cwd,
  onOpenFile,
}: WorkspaceDiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const [splitView, setSplitView] = useState(false);
  const diffQuery = useQuery(
    gitWorkingTreeFileDiffQueryOptions({
      cwd,
      relativePath: params.relativePath,
      enabled: cwd !== null,
    }),
  );
  const diffResult = diffQuery.data;
  const theme = resolvedTheme === "dark" ? "vs-dark" : "light";

  useEffect(() => {
    api.setTitle(params.title ?? params.relativePath.split("/").at(-1) ?? params.relativePath);
  }, [api, params.relativePath, params.title]);

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
          title: "Unable to open diff file",
          description: error instanceof Error ? error.message : "An unknown error occurred.",
        });
      });
  }, [cwd, params.relativePath]);

  const canUseMonaco = useMemo(() => {
    if (!diffResult) {
      return false;
    }
    return !diffResult.isBinary && !diffResult.tooLarge;
  }, [diffResult]);

  const originalText = diffResult?.originalContents ?? "";
  const modifiedText = diffResult?.modifiedContents ?? "";

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      onPointerDownCapture={() => api.setActive()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{params.relativePath}</div>
          <div className="text-[11px] text-muted-foreground">
            {diffResult ? diffResult.changeKind : "Loading diff"}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1">
            <Toggle
              aria-label="Unified diff view"
              pressed={!splitView}
              size="sm"
              variant="outline"
              onPressedChange={() => setSplitView(false)}
            >
              <Rows3Icon className="size-3.5" />
            </Toggle>
            <Toggle
              aria-label="Split diff view"
              pressed={splitView}
              size="sm"
              variant="outline"
              onPressedChange={() => setSplitView(true)}
            >
              <Columns2Icon className="size-3.5" />
            </Toggle>
          </div>
          <Button size="sm" variant="outline" onClick={() => onOpenFile(params.relativePath)}>
            Open file
          </Button>
          <Button size="sm" variant="outline" onClick={openExternal}>
            Open in editor
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {diffQuery.isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <LoaderIcon className="mr-2 size-4 animate-spin" />
            Loading diff…
          </div>
        ) : diffResult && canUseMonaco ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <LoaderIcon className="mr-2 size-4 animate-spin" />
                Loading diff viewer…
              </div>
            }
          >
            <WorkspaceCodeEditorSurface
              mode="diff"
              path={params.relativePath}
              theme={theme}
              original={originalText}
              modified={modifiedText}
              splitView={splitView}
            />
          </Suspense>
        ) : diffResult ? (
          <div className="flex h-full flex-col gap-3 overflow-auto px-4 py-4">
            <div>
              <p className="text-sm font-medium text-foreground">
                {diffResult.isBinary
                  ? "Binary diff preview is unavailable."
                  : diffResult.tooLarge
                    ? "Diff is too large to render in Monaco."
                    : "Unable to render diff preview."}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {diffResult.changeKind}
                {diffResult.previousPath ? ` · renamed from ${diffResult.previousPath}` : ""}
              </p>
            </div>
            {diffResult.unifiedDiff.trim().length > 0 ? (
              <pre className="overflow-auto rounded-md border border-border/70 bg-background/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {diffResult.unifiedDiff}
              </pre>
            ) : (
              <div className="rounded-md border border-border/70 bg-background/60 p-3 text-xs text-muted-foreground">
                No unified patch was returned for this file.
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Diff preview is unavailable.
          </div>
        )}
      </div>
    </div>
  );
}
