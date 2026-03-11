import { describe, expect, it } from "vitest";

import { inferProviderForModel } from "./providerModels";

describe("inferProviderForModel", () => {
  it("prefers the persisted session provider when available", () => {
    expect(
      inferProviderForModel({
        model: "gpt-5.4",
        sessionProviderName: "claudeCode",
      }),
    ).toBe("claudeCode");
  });

  it("infers Claude from built-in Claude model slugs", () => {
    expect(
      inferProviderForModel({
        model: "claude-opus-4-6",
      }),
    ).toBe("claudeCode");
  });

  it("infers Claude from provider-specific custom model slugs", () => {
    expect(
      inferProviderForModel({
        model: "claude-max",
        customModelsByProvider: {
          claudeCode: ["claude-max"],
        },
      }),
    ).toBe("claudeCode");
  });

  it("falls back to Codex for unknown models", () => {
    expect(
      inferProviderForModel({
        model: "unknown-model",
      }),
    ).toBe("codex");
  });
});
