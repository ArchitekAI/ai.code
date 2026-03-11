import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_COMMIT_AND_PUSH_PROMPT,
  getAppModelOptions,
  getSlashModelOptions,
  normalizeCustomModelSlugs,
  normalizeEnvironmentVariablesText,
  parseEnvironmentVariablesText,
  isClaudeBedrockEnabled,
  normalizePromptHotkeyMessage,
  resolveAppModelSelection,
  getAppSettingsSnapshot,
} from "./appSettings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("app name settings", () => {
  it("defaults the custom app name to empty", () => {
    expect(getAppSettingsSnapshot().customAppName).toBe("");
  });

  it("defaults the commit-and-push hotkey prompt", () => {
    expect(getAppSettingsSnapshot().commitAndPushPrompt).toBe(DEFAULT_COMMIT_AND_PUSH_PROMPT);
  });
});

describe("normalizeCustomModelSlugs", () => {
  it("normalizes aliases, removes built-ins, and deduplicates values", () => {
    expect(
      normalizeCustomModelSlugs([
        " custom/internal-model ",
        "gpt-5.3-codex",
        "5.3",
        "custom/internal-model",
        "",
        null,
      ]),
    ).toEqual(["custom/internal-model"]);
  });
});

describe("getAppModelOptions", () => {
  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "custom/internal-model",
    ]);
  });

  it("keeps the currently selected custom model available even if it is no longer saved", () => {
    const options = getAppModelOptions("codex", [], "custom/selected-model");

    expect(options.at(-1)).toEqual({
      slug: "custom/selected-model",
      name: "custom/selected-model",
      isCustom: true,
    });
  });

  it("supports Claude custom models alongside built-in Claude options", () => {
    const options = getAppModelOptions("claudeCode", ["claude/internal-preview"]);

    expect(options.some((option) => option.slug === "claude-opus-4-6")).toBe(true);
    expect(options.at(-1)).toEqual({
      slug: "claude/internal-preview",
      name: "claude/internal-preview",
      isCustom: true,
    });
  });
});

describe("resolveAppModelSelection", () => {
  it("preserves saved custom model slugs instead of falling back to the default", () => {
    expect(resolveAppModelSelection("codex", ["galapagos-alpha"], "galapagos-alpha")).toBe(
      "galapagos-alpha",
    );
  });

  it("falls back to the provider default when no model is selected", () => {
    expect(resolveAppModelSelection("codex", [], "")).toBe("gpt-5.4");
  });
});

describe("getSlashModelOptions", () => {
  it("includes saved custom model slugs for /model command suggestions", () => {
    const options = getSlashModelOptions("codex", ["custom/internal-model"], "", "gpt-5.3-codex");

    expect(options.some((option) => option.slug === "custom/internal-model")).toBe(true);
  });

  it("filters slash-model suggestions across built-in and custom model names", () => {
    const options = getSlashModelOptions("codex", ["openai/gpt-oss-120b"], "oss", "gpt-5.3-codex");

    expect(options.map((option) => option.slug)).toEqual(["openai/gpt-oss-120b"]);
  });
});

describe("persisted settings migration", () => {
  it("merges older saved payloads with new Claude defaults instead of resetting existing fields", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });

    window.localStorage.setItem(
      "t3code:app-settings:v1",
      JSON.stringify({
        codexBinaryPath: "/usr/local/bin/codex",
        customCodexModels: ["custom/codex-model"],
        customAppName: "My App",
      }),
    );

    const snapshot = getAppSettingsSnapshot();

    expect(snapshot.codexBinaryPath).toBe("/usr/local/bin/codex");
    expect(snapshot.customCodexModels).toEqual(["custom/codex-model"]);
    expect(snapshot.customAppName).toBe("My App");
    expect(snapshot.claudeBinaryPath).toBe("");
    expect(snapshot.claudeEnvVars).toBe("");
    expect(snapshot.customClaudeModels).toEqual([]);
  });
});

describe("parseEnvironmentVariablesText", () => {
  it("preserves trailing newlines while normalizing textarea input", () => {
    expect(normalizeEnvironmentVariablesText("AWS_REGION=us-east-1\r\n")).toBe(
      "AWS_REGION=us-east-1\n",
    );
  });

  it("parses KEY=VALUE lines and ignores comments", () => {
    expect(
      parseEnvironmentVariablesText(
        ["CLAUDE_CODE_USE_BEDROCK=1", "# comment", "AWS_REGION=us-east-1"].join("\n"),
      ),
    ).toEqual({
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
      },
      invalidLineNumbers: [],
    });
  });

  it("tracks invalid lines without discarding valid ones", () => {
    expect(parseEnvironmentVariablesText(["AWS_REGION", "AWS_PROFILE=bedrock"].join("\n"))).toEqual(
      {
        env: {
          AWS_PROFILE: "bedrock",
        },
        invalidLineNumbers: [1],
      },
    );
  });
});

describe("isClaudeBedrockEnabled", () => {
  it("detects Bedrock mode from Claude env settings", () => {
    expect(isClaudeBedrockEnabled("CLAUDE_CODE_USE_BEDROCK=1")).toBe(true);
    expect(isClaudeBedrockEnabled("CLAUDE_CODE_USE_BEDROCK=true")).toBe(true);
    expect(isClaudeBedrockEnabled("AWS_REGION=us-east-1")).toBe(false);
  });
});

describe("normalizePromptHotkeyMessage", () => {
  it("falls back to the default prompt when the value is blank", () => {
    expect(normalizePromptHotkeyMessage("   ")).toBe(DEFAULT_COMMIT_AND_PUSH_PROMPT);
  });

  it("preserves custom prompt text after trimming outer whitespace", () => {
    expect(normalizePromptHotkeyMessage("  Ship it and push  ")).toBe("Ship it and push");
  });
});
