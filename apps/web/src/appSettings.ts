import { useCallback, useSyncExternalStore } from "react";
import { Schema } from "effect";
import { type ProviderKind, type ProviderStartOptions } from "@repo/contracts";
import { MAX_APP_BASE_NAME_LENGTH, normalizeAppBaseName } from "@repo/shared/branding";
import { DEFAULT_GIT_BRANCH_PREFIX, normalizeGitBranchPrefix } from "@repo/shared/git";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@repo/shared/model";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const MAX_CUSTOM_APP_NAME_LENGTH = MAX_APP_BASE_NAME_LENGTH;
export const MAX_PROMPT_HOTKEY_MESSAGE_LENGTH = 2_000;
export const DEFAULT_COMMIT_AND_PUSH_PROMPT = "Commit and push changes";
export const MAX_CLAUDE_ENV_VARS_LENGTH = 16_384;
export const MAX_ALL_FILES_HIDDEN_PREFIX_LENGTH = 128;
const MAX_ALL_FILES_HIDDEN_PREFIX_COUNT = 32;
const MAX_ENV_VAR_KEY_LENGTH = 128;
const MAX_ENV_VAR_VALUE_LENGTH = 4_096;
const MAX_ENV_VAR_COUNT = 64;
const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  claudeCode: new Set(getModelOptions("claudeCode").map((option) => option.slug)),
};

const SettingsString = Schema.String.check(Schema.isMaxLength(4096));
const ClaudeEnvVarsString = Schema.String.check(Schema.isMaxLength(MAX_CLAUDE_ENV_VARS_LENGTH));
const PersistedAppSettingsSchema = Schema.Struct({
  codexBinaryPath: Schema.optional(SettingsString),
  codexHomePath: Schema.optional(SettingsString),
  claudeBinaryPath: Schema.optional(SettingsString),
  claudeEnvVars: Schema.optional(ClaudeEnvVarsString),
  confirmThreadDelete: Schema.optional(Schema.Boolean),
  enableAssistantStreaming: Schema.optional(Schema.Boolean),
  customCodexModels: Schema.optional(Schema.Array(Schema.String)),
  customClaudeModels: Schema.optional(Schema.Array(Schema.String)),
  customAppName: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_CUSTOM_APP_NAME_LENGTH)),
  ),
  gitBranchPrefix: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  commitAndPushPrompt: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_PROMPT_HOTKEY_MESSAGE_LENGTH)),
  ),
  allFilesHiddenPrefixes: Schema.optional(Schema.Array(Schema.String)),
});

const AppSettingsSchema = Schema.Struct({
  codexBinaryPath: SettingsString,
  codexHomePath: SettingsString,
  claudeBinaryPath: SettingsString,
  claudeEnvVars: ClaudeEnvVarsString,
  confirmThreadDelete: Schema.Boolean,
  enableAssistantStreaming: Schema.Boolean,
  customCodexModels: Schema.Array(Schema.String),
  customClaudeModels: Schema.Array(Schema.String),
  customAppName: Schema.String.check(Schema.isMaxLength(MAX_CUSTOM_APP_NAME_LENGTH)),
  gitBranchPrefix: Schema.String.check(Schema.isMaxLength(256)),
  commitAndPushPrompt: Schema.String.check(Schema.isMaxLength(MAX_PROMPT_HOTKEY_MESSAGE_LENGTH)),
  allFilesHiddenPrefixes: Schema.Array(
    Schema.String.check(Schema.isMaxLength(MAX_ALL_FILES_HIDDEN_PREFIX_LENGTH)),
  ),
});

export type AppSettings = typeof AppSettingsSchema.Type;

export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  codexBinaryPath: "",
  codexHomePath: "",
  claudeBinaryPath: "",
  claudeEnvVars: "",
  confirmThreadDelete: true,
  enableAssistantStreaming: false,
  customCodexModels: [],
  customClaudeModels: [],
  customAppName: "",
  gitBranchPrefix: DEFAULT_GIT_BRANCH_PREFIX,
  commitAndPushPrompt: DEFAULT_COMMIT_AND_PUSH_PROMPT,
  allFilesHiddenPrefixes: ["."],
};

let listeners: Array<() => void> = [];
let cachedRawSettings: string | null | undefined;
let cachedSnapshot: AppSettings = DEFAULT_APP_SETTINGS;

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

export function normalizePromptHotkeyMessage(
  value: string | null | undefined,
  fallback = DEFAULT_COMMIT_AND_PUSH_PROMPT,
): string {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : fallback;
}

export function normalizeAllFilesHiddenPrefixes(
  prefixes: Iterable<string | null | undefined>,
): string[] {
  const normalizedPrefixes: string[] = [];
  const seen = new Set<string>();

  for (const candidate of prefixes) {
    const normalized = candidate?.trim() ?? "";
    if (
      normalized.length === 0 ||
      normalized.length > MAX_ALL_FILES_HIDDEN_PREFIX_LENGTH ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedPrefixes.push(normalized);
    if (normalizedPrefixes.length >= MAX_ALL_FILES_HIDDEN_PREFIX_COUNT) {
      break;
    }
  }

  return normalizedPrefixes;
}

export function normalizeEnvironmentVariablesText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n");
}

export function parseEnvironmentVariablesText(value: string | null | undefined): {
  env: Record<string, string>;
  invalidLineNumbers: number[];
} {
  const normalized = normalizeEnvironmentVariablesText(value);
  const env: Record<string, string> = {};
  const invalidLineNumbers: number[] = [];
  let acceptedCount = 0;

  if (!normalized) {
    return { env, invalidLineNumbers };
  }

  for (const [index, line] of normalized.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      invalidLineNumbers.push(index + 1);
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (
      !ENV_VAR_KEY_PATTERN.test(key) ||
      key.length > MAX_ENV_VAR_KEY_LENGTH ||
      rawValue.length > MAX_ENV_VAR_VALUE_LENGTH
    ) {
      invalidLineNumbers.push(index + 1);
      continue;
    }

    if (!(key in env)) {
      acceptedCount += 1;
      if (acceptedCount > MAX_ENV_VAR_COUNT) {
        invalidLineNumbers.push(index + 1);
        delete env[key];
        continue;
      }
    }

    env[key] = rawValue;
  }

  return { env, invalidLineNumbers };
}

export function getProviderStartOptionsFromAppSettings(
  settings: Pick<
    AppSettings,
    "codexBinaryPath" | "codexHomePath" | "claudeBinaryPath" | "claudeEnvVars"
  >,
): ProviderStartOptions | undefined {
  const claudeEnvironment = parseEnvironmentVariablesText(settings.claudeEnvVars).env;

  if (
    !settings.codexBinaryPath &&
    !settings.codexHomePath &&
    !settings.claudeBinaryPath &&
    Object.keys(claudeEnvironment).length === 0
  ) {
    return undefined;
  }

  return {
    ...(settings.codexBinaryPath || settings.codexHomePath
      ? {
          codex: {
            ...(settings.codexBinaryPath ? { binaryPath: settings.codexBinaryPath } : {}),
            ...(settings.codexHomePath ? { homePath: settings.codexHomePath } : {}),
          },
        }
      : {}),
    ...(settings.claudeBinaryPath || Object.keys(claudeEnvironment).length > 0
      ? {
          claudeCode: {
            ...(settings.claudeBinaryPath ? { binaryPath: settings.claudeBinaryPath } : {}),
            ...(Object.keys(claudeEnvironment).length > 0 ? { env: claudeEnvironment } : {}),
          },
        }
      : {}),
  };
}

export function isClaudeBedrockEnabled(value: string | null | undefined): boolean {
  const parsed = parseEnvironmentVariablesText(value);
  const flag = parsed.env.CLAUDE_CODE_USE_BEDROCK;
  if (!flag) {
    return false;
  }
  const normalized = flag.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeAppSettings(settings: Partial<AppSettings>): AppSettings {
  return Schema.decodeSync(AppSettingsSchema)({
    codexBinaryPath: settings.codexBinaryPath ?? DEFAULT_APP_SETTINGS.codexBinaryPath,
    codexHomePath: settings.codexHomePath ?? DEFAULT_APP_SETTINGS.codexHomePath,
    claudeBinaryPath: settings.claudeBinaryPath ?? DEFAULT_APP_SETTINGS.claudeBinaryPath,
    claudeEnvVars: normalizeEnvironmentVariablesText(settings.claudeEnvVars),
    confirmThreadDelete: settings.confirmThreadDelete ?? DEFAULT_APP_SETTINGS.confirmThreadDelete,
    enableAssistantStreaming:
      settings.enableAssistantStreaming ?? DEFAULT_APP_SETTINGS.enableAssistantStreaming,
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels ?? [], "codex"),
    customClaudeModels: normalizeCustomModelSlugs(settings.customClaudeModels ?? [], "claudeCode"),
    customAppName: normalizeAppBaseName(settings.customAppName ?? "") ?? "",
    gitBranchPrefix:
      normalizeGitBranchPrefix(settings.gitBranchPrefix ?? DEFAULT_GIT_BRANCH_PREFIX) ??
      DEFAULT_GIT_BRANCH_PREFIX,
    commitAndPushPrompt: normalizePromptHotkeyMessage(settings.commitAndPushPrompt),
    allFilesHiddenPrefixes: normalizeAllFilesHiddenPrefixes(
      settings.allFilesHiddenPrefixes ?? ["."],
    ),
  });
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parsePersistedSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    const parsed = Schema.decodeSync(Schema.fromJsonString(PersistedAppSettingsSchema))(value);
    return normalizeAppSettings(parsed as Partial<AppSettings>);
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (raw === cachedRawSettings) {
    return cachedSnapshot;
  }

  cachedRawSettings = raw;
  cachedSnapshot = parsePersistedSettings(raw);
  return cachedSnapshot;
}

function persistSettings(next: AppSettings): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  try {
    if (raw !== cachedRawSettings) {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, raw);
    }
  } catch {
    // Best-effort persistence only.
  }

  cachedRawSettings = raw;
  cachedSnapshot = next;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_SETTINGS_STORAGE_KEY) {
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function getCustomModelsForProvider(
  settings: Pick<AppSettings, "customCodexModels" | "customClaudeModels">,
  provider: ProviderKind,
): readonly string[] {
  switch (provider) {
    case "claudeCode":
      return settings.customClaudeModels;
    case "codex":
    default:
      return settings.customCodexModels;
  }
}

export function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "claudeCode":
      return { customClaudeModels: models };
    case "codex":
    default:
      return { customCodexModels: models };
  }
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function getSlashModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  query: string,
  selectedModel?: string | null,
): AppModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const options = getAppModelOptions(provider, customModels, selectedModel);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchSlug = option.slug.toLowerCase();
    const searchName = option.name.toLowerCase();
    return searchSlug.includes(normalizedQuery) || searchName.includes(normalizedQuery);
  });
}

export function useAppSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getAppSettingsSnapshot,
    () => DEFAULT_APP_SETTINGS,
  );

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = normalizeAppSettings({
      ...getAppSettingsSnapshot(),
      ...patch,
    });
    persistSettings(next);
    emitChange();
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_APP_SETTINGS);
    emitChange();
  }, []);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
