import { describe, expect, it } from "vitest";

import {
  isClaudeBedrockEnvironment,
  resolveClaudeRuntimeModel,
  shouldEnableClaudeFineGrainedToolStreaming,
} from "./claudeRuntimeModel.ts";

describe("isClaudeBedrockEnvironment", () => {
  it("detects explicit Claude Bedrock flag", () => {
    expect(isClaudeBedrockEnvironment({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
    expect(isClaudeBedrockEnvironment({ CLAUDE_CODE_USE_BEDROCK: "true" })).toBe(true);
  });

  it("detects AWS auth hints even without explicit Claude Bedrock flag", () => {
    expect(isClaudeBedrockEnvironment({ AWS_ACCESS_KEY_ID: "test" })).toBe(true);
    expect(isClaudeBedrockEnvironment({ AWS_PROFILE: "bedrock" })).toBe(true);
  });

  it("returns false when no Bedrock hints are present", () => {
    expect(isClaudeBedrockEnvironment({ PATH: "/usr/bin" })).toBe(false);
    expect(isClaudeBedrockEnvironment(undefined)).toBe(false);
  });
});

describe("resolveClaudeRuntimeModel", () => {
  it("preserves Claude-native slugs when Bedrock is not enabled", () => {
    expect(resolveClaudeRuntimeModel("claude-sonnet-4-6", { PATH: "/usr/bin" })).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("maps built-in Claude model slugs to runtime-safe aliases for Bedrock", () => {
    expect(resolveClaudeRuntimeModel("claude-sonnet-4-6", { AWS_ACCESS_KEY_ID: "test" })).toBe(
      "sonnet",
    );
    expect(resolveClaudeRuntimeModel("claude-opus-4-6", { AWS_ACCESS_KEY_ID: "test" })).toBe(
      "opus",
    );
    expect(resolveClaudeRuntimeModel("claude-haiku-4-5", { AWS_ACCESS_KEY_ID: "test" })).toBe(
      "haiku",
    );
  });

  it("leaves custom Bedrock model ids unchanged", () => {
    expect(
      resolveClaudeRuntimeModel("global.anthropic.claude-sonnet-4-6", {
        AWS_ACCESS_KEY_ID: "test",
      }),
    ).toBe("global.anthropic.claude-sonnet-4-6");
  });

  it("normalizes Claude aliases before applying Bedrock translation", () => {
    expect(resolveClaudeRuntimeModel("claude-sonnet-4.6", { AWS_ACCESS_KEY_ID: "test" })).toBe(
      "sonnet",
    );
  });
});

describe("shouldEnableClaudeFineGrainedToolStreaming", () => {
  it("disables fine-grained tool streaming for Bedrock environments", () => {
    expect(
      shouldEnableClaudeFineGrainedToolStreaming({
        AWS_ACCESS_KEY_ID: "test",
      }),
    ).toBe(false);
  });

  it("keeps fine-grained tool streaming enabled for Claude-native environments", () => {
    expect(
      shouldEnableClaudeFineGrainedToolStreaming({
        PATH: "/usr/bin",
      }),
    ).toBe(true);
  });
});
