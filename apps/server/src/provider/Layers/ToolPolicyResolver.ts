import { type LinearProjectMapping, type PromptType } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import {
  ToolPolicyResolver,
  type ResolvedToolPolicy,
  type ToolPolicyResolverShape,
} from "../Services/ToolPolicyResolver.ts";

const WORKSPACE_MCP_TOOL_PREFIXES = ["mcp__linear*", "mcp__t3-tools*", "mcp__t3-docs*"] as const;

const KNOWN_TOOL_PRESETS: Record<string, ReadonlyArray<string>> = {
  "workspace-mcp": WORKSPACE_MCP_TOOL_PREFIXES,
};

type PromptPolicyConfig = {
  readonly allowedToolsPreset?: string;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
};

function readStringArray(value: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
}

function normalizePromptType(
  promptType: PromptType,
): Exclude<PromptType, "graphite-orchestrator"> | "orchestrator" {
  return promptType === "graphite-orchestrator" ? "orchestrator" : promptType;
}

function readPromptPolicy(
  mapping: LinearProjectMapping,
  promptType: PromptType,
): PromptPolicyConfig | null {
  const promptDefaults = mapping.toolPolicy?.promptDefaults;
  if (!promptDefaults || typeof promptDefaults !== "object") {
    return null;
  }

  const normalizedPromptType = normalizePromptType(promptType);
  const candidate = (promptDefaults as Record<string, unknown>)[normalizedPromptType];
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const allowedTools = readStringArray(record.allowedTools);
  const disallowedTools = readStringArray(record.disallowedTools);

  return {
    ...(typeof record.allowedToolsPreset === "string"
      ? { allowedToolsPreset: record.allowedToolsPreset }
      : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
  };
}

function mergeAllowedTools(mappings: ReadonlyArray<LinearProjectMapping>, promptType: PromptType) {
  const merged = new Set<string>();
  for (const mapping of mappings) {
    const promptPolicy = readPromptPolicy(mapping, promptType);
    const presetName =
      promptPolicy?.allowedToolsPreset ?? mapping.toolPolicy?.defaultAllowedToolsPreset;
    if (presetName && KNOWN_TOOL_PRESETS[presetName]) {
      for (const tool of KNOWN_TOOL_PRESETS[presetName]) {
        merged.add(tool);
      }
    }
    for (const tool of promptPolicy?.allowedTools ?? []) {
      merged.add(tool);
    }
  }

  if (merged.size === 0) {
    return undefined;
  }

  for (const toolPrefix of WORKSPACE_MCP_TOOL_PREFIXES) {
    merged.add(toolPrefix);
  }
  return [...merged];
}

function intersectDisallowedTools(
  mappings: ReadonlyArray<LinearProjectMapping>,
  promptType: PromptType,
): ReadonlyArray<string> | undefined {
  let current: Set<string> | undefined;

  for (const mapping of mappings) {
    const promptPolicy = readPromptPolicy(mapping, promptType);
    const values = new Set([
      ...(mapping.toolPolicy?.defaultDisallowedTools ?? []),
      ...(promptPolicy?.disallowedTools ?? []),
    ]);
    current =
      current === undefined ? values : new Set([...current].filter((entry) => values.has(entry)));
  }

  return current && current.size > 0 ? [...current] : undefined;
}

const makeToolPolicyResolver = Effect.succeed({
  resolve: ({ promptType, mappings }) => {
    const allowedTools = mergeAllowedTools(mappings, promptType);
    const disallowedTools = intersectDisallowedTools(mappings, promptType);
    return Effect.succeed({
      ...(allowedTools ? { allowedTools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
    } satisfies ResolvedToolPolicy);
  },
} satisfies ToolPolicyResolverShape);

export const ToolPolicyResolverLive = Layer.effect(ToolPolicyResolver, makeToolPolicyResolver);
