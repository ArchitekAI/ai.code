import { DiffEditor, Editor, type BeforeMount, type OnMount } from "@monaco-editor/react";

import { ensureMonacoThemes } from "../lib/monacoTheme";

type CommonProps = {
  language?: string;
  path?: string;
  theme: string;
};

type FileProps = CommonProps & {
  mode: "file";
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
};

type DiffProps = CommonProps & {
  mode: "diff";
  original: string;
  modified: string;
  splitView: boolean;
};

type WorkspaceCodeEditorSurfaceProps = FileProps | DiffProps;

const COMMON_OPTIONS = {
  automaticLayout: true,
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "off" as const,
};

export default function WorkspaceCodeEditorSurface(props: WorkspaceCodeEditorSurfaceProps) {
  const beforeMount: BeforeMount = (monaco) => {
    ensureMonacoThemes(monaco);
  };

  if (props.mode === "diff") {
    return (
      <DiffEditor
        beforeMount={beforeMount}
        key={`${props.path ?? "diff"}:${props.splitView ? "split" : "unified"}`}
        height="100%"
        {...(props.language ? { language: props.language } : {})}
        originalModelPath={`original:${props.path ?? "left"}`}
        modifiedModelPath={props.path ?? "right"}
        original={props.original}
        modified={props.modified}
        options={{
          ...COMMON_OPTIONS,
          readOnly: true,
          renderSideBySide: props.splitView,
          renderSideBySideInlineBreakpoint: 0,
        }}
        theme={props.theme}
      />
    );
  }

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      props.onSave?.();
    });
  };

  return (
    <Editor
      beforeMount={beforeMount}
      height="100%"
      {...(props.language ? { language: props.language } : {})}
      {...(props.path ? { path: props.path } : {})}
      value={props.value}
      onChange={(value) => props.onChange(value ?? "")}
      onMount={onMount}
      options={{
        ...COMMON_OPTIONS,
      }}
      theme={props.theme}
    />
  );
}
