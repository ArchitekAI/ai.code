import type { editor } from "monaco-editor";
import githubDarkTheme from "./monaco-themes/github-dark.json";
import githubLightTheme from "./monaco-themes/github-light.json";

export const T3CODE_MONACO_DARK_THEME = "t3code-github-dark";
export const T3CODE_MONACO_LIGHT_THEME = "t3code-github-light";

let themesRegistered = false;

function withEditorColors(
  theme: editor.IStandaloneThemeData,
  overrides: editor.IColors,
): editor.IStandaloneThemeData {
  return {
    ...theme,
    colors: {
      ...theme.colors,
      ...overrides,
    },
  };
}

export function ensureMonacoThemes(monaco: typeof import("monaco-editor")): void {
  if (themesRegistered) {
    return;
  }

  monaco.editor.defineTheme(
    T3CODE_MONACO_DARK_THEME,
    withEditorColors(githubDarkTheme as editor.IStandaloneThemeData, {
      "diffEditor.insertedLineBackground": "#0d442980",
      "diffEditor.insertedTextBackground": "#2ea04340",
      "diffEditor.removedLineBackground": "#5a1e2480",
      "diffEditor.removedTextBackground": "#f8514940",
    }),
  );
  monaco.editor.defineTheme(
    T3CODE_MONACO_LIGHT_THEME,
    withEditorColors(githubLightTheme as editor.IStandaloneThemeData, {
      "diffEditor.insertedLineBackground": "#dff3e480",
      "diffEditor.insertedTextBackground": "#2da44e33",
      "diffEditor.removedLineBackground": "#ffebe980",
      "diffEditor.removedTextBackground": "#cf222e26",
    }),
  );

  themesRegistered = true;
}
