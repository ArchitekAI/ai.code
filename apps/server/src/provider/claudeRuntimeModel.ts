import { normalizeModelSlug } from "@repo/shared/model";

const BEDROCK_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const CLAUDE_BEDROCK_ALIAS_BY_MODEL_SLUG: Record<string, string> = {
  "claude-opus-4-6": "opus",
  "claude-sonnet-4-6": "sonnet",
  "claude-haiku-4-5": "haiku",
};

const AWS_AUTH_ENV_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
] as const;

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isClaudeBedrockEnvironment(
  env: Record<string, string | undefined> | undefined,
): boolean {
  if (!env) {
    return false;
  }

  const explicitFlag = nonEmptyTrimmed(env.CLAUDE_CODE_USE_BEDROCK)?.toLowerCase();
  if (explicitFlag && BEDROCK_TRUE_VALUES.has(explicitFlag)) {
    return true;
  }

  return AWS_AUTH_ENV_KEYS.some((key) => nonEmptyTrimmed(env[key]) !== undefined);
}

export function resolveClaudeRuntimeModel(
  model: string | null | undefined,
  env: Record<string, string | undefined> | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!isClaudeBedrockEnvironment(env)) {
    return trimmed;
  }

  const normalized = normalizeModelSlug(trimmed, "claudeCode") ?? trimmed;
  return CLAUDE_BEDROCK_ALIAS_BY_MODEL_SLUG[normalized] ?? trimmed;
}
