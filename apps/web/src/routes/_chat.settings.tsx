import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ProviderKind } from "@repo/contracts";
import { APP_BASE_NAME, normalizeAppBaseName } from "@repo/shared/branding";
import { DEFAULT_GIT_BRANCH_PREFIX, normalizeGitBranchPrefix } from "@repo/shared/git";
import { getModelOptions, normalizeModelSlug } from "@repo/shared/model";

import {
  MAX_PROMPT_HOTKEY_MESSAGE_LENGTH,
  MAX_CLAUDE_ENV_VARS_LENGTH,
  MAX_CUSTOM_APP_NAME_LENGTH,
  MAX_CUSTOM_MODEL_LENGTH,
  getCustomModelsForProvider,
  parseEnvironmentVariablesText,
  normalizePromptHotkeyMessage,
  patchCustomModels,
  useAppSettings,
} from "../appSettings";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { shortcutLabelForCommand } from "../keybindings";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { preferredTerminalEditor } from "../terminal-links";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { APP_VERSION, getAppDisplayName } from "../branding";
import { SidebarInset } from "~/components/ui/sidebar";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  {
    provider: "claudeCode",
    title: "Claude Code",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-opus-4-6",
  },
] as const;

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeCode: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [customAppNameInput, setCustomAppNameInput] = useState(settings.customAppName);
  const [gitBranchPrefixInput, setGitBranchPrefixInput] = useState(settings.gitBranchPrefix);
  const [commitAndPushPromptInput, setCommitAndPushPromptInput] = useState(
    settings.commitAndPushPrompt,
  );
  const [gitBranchPrefixError, setGitBranchPrefixError] = useState<string | null>(null);

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const claudeBinaryPath = settings.claudeBinaryPath;
  const claudeEnvVars = settings.claudeEnvVars;
  const parsedClaudeEnvVars = useMemo(
    () => parseEnvironmentVariablesText(claudeEnvVars),
    [claudeEnvVars],
  );
  const effectiveAppDisplayName = getAppDisplayName(customAppNameInput);
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const normalizedGitBranchPrefixPreview = useMemo(
    () => normalizeGitBranchPrefix(gitBranchPrefixInput) ?? settings.gitBranchPrefix,
    [gitBranchPrefixInput, settings.gitBranchPrefix],
  );
  const commitAndPushShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(serverConfigQuery.data?.keybindings ?? [], "prompt.commitAndPush") ??
      (typeof navigator !== "undefined" && navigator.platform.includes("Mac")
        ? "⌘⇧Y"
        : "Ctrl+Shift+Y"),
    [serverConfigQuery.data?.keybindings],
  );

  useEffect(() => {
    setCustomAppNameInput(settings.customAppName);
  }, [settings.customAppName]);

  useEffect(() => {
    setGitBranchPrefixInput(settings.gitBranchPrefix);
  }, [settings.gitBranchPrefix]);

  useEffect(() => {
    setCommitAndPushPromptInput(settings.commitAndPushPrompt);
  }, [settings.commitAndPushPrompt]);

  const commitCustomAppName = useCallback(() => {
    const normalized = normalizeAppBaseName(customAppNameInput) ?? "";
    setCustomAppNameInput(normalized);
    if (normalized !== settings.customAppName) {
      updateSettings({ customAppName: normalized });
    }
  }, [customAppNameInput, settings.customAppName, updateSettings]);

  const commitCommitAndPushPrompt = useCallback(() => {
    const normalized = normalizePromptHotkeyMessage(commitAndPushPromptInput);
    setCommitAndPushPromptInput(normalized);
    if (normalized !== settings.commitAndPushPrompt) {
      updateSettings({ commitAndPushPrompt: normalized });
    }
  }, [commitAndPushPromptInput, settings.commitAndPushPrompt, updateSettings]);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    void api.shell
      .openInEditor(keybindingsConfigPath, preferredTerminalEditor())
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [keybindingsConfigPath]);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const handleGitBranchPrefixChange = useCallback(
    (rawValue: string) => {
      setGitBranchPrefixInput(rawValue);
      const normalized = normalizeGitBranchPrefix(rawValue);
      if (!normalized) {
        setGitBranchPrefixError("Branch prefixes must contain at least one letter or number.");
        return;
      }
      setGitBranchPrefixError(null);
      if (normalized !== settings.gitBranchPrefix) {
        updateSettings({ gitBranchPrefix: normalized });
      }
    },
    [settings.gitBranchPrefix, updateSettings],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how {effectiveAppDisplayName} handles light and dark mode.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                {THEME_OPTIONS.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => setTheme(option.value)}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{option.label}</span>
                        <span className="text-xs">{option.description}</span>
                      </span>
                      {selected ? (
                        <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
              </p>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Branding</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Customize the runtime app name shown in the web app and desktop window.
                </p>
              </div>

              <div className="space-y-3">
                <label htmlFor="custom-app-name" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Custom app name</span>
                  <Input
                    id="custom-app-name"
                    value={customAppNameInput}
                    onChange={(event) => setCustomAppNameInput(event.target.value)}
                    onBlur={commitCustomAppName}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") {
                        return;
                      }
                      event.preventDefault();
                      commitCustomAppName();
                      event.currentTarget.blur();
                    }}
                    placeholder={APP_BASE_NAME}
                    maxLength={MAX_CUSTOM_APP_NAME_LENGTH}
                    spellCheck={false}
                  />
                </label>

                <p className="text-xs text-muted-foreground">
                  Preview:{" "}
                  <span className="font-medium text-foreground">{effectiveAppDisplayName}</span>
                </p>

                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCustomAppNameInput(defaults.customAppName);
                      updateSettings({ customAppName: defaults.customAppName });
                    }}
                    disabled={settings.customAppName === defaults.customAppName}
                  >
                    Reset to default
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Git</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Configure the branch namespace used for new worktrees and first-turn branch
                  rename.
                </p>
              </div>

              <div className="space-y-3">
                <label htmlFor="git-branch-prefix" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Branch name prefix</span>
                  <Input
                    id="git-branch-prefix"
                    value={gitBranchPrefixInput}
                    onChange={(event) => handleGitBranchPrefixChange(event.target.value)}
                    placeholder={DEFAULT_GIT_BRANCH_PREFIX}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className={
                      gitBranchPrefixError
                        ? "border-red-500/70 focus-visible:ring-red-500/40"
                        : undefined
                    }
                  />
                </label>

                <div className="rounded-xl border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <p>
                    Initial worktree branch:{" "}
                    <span className="font-mono text-foreground">
                      {normalizedGitBranchPrefixPreview}silent-fern-ridge
                    </span>
                  </p>
                  <p className="mt-1">
                    First-turn rename:{" "}
                    <span className="font-mono text-foreground">
                      {normalizedGitBranchPrefixPreview}fix-login-timeout
                    </span>
                  </p>
                </div>

                {gitBranchPrefixError ? (
                  <p className="text-xs text-red-500">{gitBranchPrefixError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Prefixes are normalized to lowercase and always saved with a trailing slash.
                  </p>
                )}

                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setGitBranchPrefixError(null);
                      setGitBranchPrefixInput(defaults.gitBranchPrefix);
                      updateSettings({ gitBranchPrefix: defaults.gitBranchPrefix });
                    }}
                    disabled={settings.gitBranchPrefix === defaults.gitBranchPrefix}
                  >
                    Reset to default
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These overrides apply to new sessions and let you use a non-default Codex install.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="codex-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Codex binary path</span>
                  <Input
                    id="codex-binary-path"
                    value={codexBinaryPath}
                    onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
                    placeholder="codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>codex</code> from your PATH.
                  </span>
                </label>

                <label htmlFor="codex-home-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                  <Input
                    id="codex-home-path"
                    value={codexHomePath}
                    onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
                    placeholder="/Users/you/.codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Optional custom Codex home/config directory.
                  </span>
                </label>

                <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p>Binary source</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-foreground">
                      {codexBinaryPath || "PATH"}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    className="self-start"
                    onClick={() =>
                      updateSettings({
                        codexBinaryPath: defaults.codexBinaryPath,
                        codexHomePath: defaults.codexHomePath,
                      })
                    }
                  >
                    Reset codex overrides
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Claude Code CLI</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  This override applies to new Claude sessions and lets you use a non-default Claude
                  install.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="claude-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Claude binary path</span>
                  <Input
                    id="claude-binary-path"
                    value={claudeBinaryPath}
                    onChange={(event) => updateSettings({ claudeBinaryPath: event.target.value })}
                    placeholder="claude"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>claude</code> from your PATH.
                  </span>
                </label>

                <label htmlFor="claude-env-vars" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Claude environment</span>
                  <Textarea
                    id="claude-env-vars"
                    value={claudeEnvVars}
                    onChange={(event) => updateSettings({ claudeEnvVars: event.target.value })}
                    placeholder={[
                      "CLAUDE_CODE_USE_BEDROCK=1",
                      "AWS_REGION=us-east-1",
                      "AWS_PROFILE=bedrock",
                    ].join("\n")}
                    spellCheck={false}
                    rows={6}
                    className="font-mono text-xs"
                  />
                  <span className="text-xs text-muted-foreground">
                    Enter one <code>KEY=VALUE</code> pair per line. These vars are applied to new
                    Claude sessions, which is useful for Bedrock-backed Claude Code setups.
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Example: <code>CLAUDE_CODE_USE_BEDROCK=1</code>,{" "}
                    <code>AWS_REGION=us-east-1</code>, <code>AWS_PROFILE=bedrock</code>.
                  </span>
                  {parsedClaudeEnvVars.invalidLineNumbers.length > 0 && (
                    <span className="text-xs text-amber-600">
                      Ignoring invalid env lines:{" "}
                      {parsedClaudeEnvVars.invalidLineNumbers.join(", ")}.
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    Parsed {Object.keys(parsedClaudeEnvVars.env).length} variable
                    {Object.keys(parsedClaudeEnvVars.env).length === 1 ? "" : "s"}. Maximum{" "}
                    {MAX_CLAUDE_ENV_VARS_LENGTH.toLocaleString()} characters total.
                  </span>
                </label>

                <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p>Binary source</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-foreground">
                      {claudeBinaryPath || "PATH"}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    className="self-start"
                    onClick={() =>
                      updateSettings({
                        claudeBinaryPath: defaults.claudeBinaryPath,
                        claudeEnvVars: defaults.claudeEnvVars,
                      })
                    }
                  >
                    Reset Claude overrides
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
                </p>
              </div>

              <div className="space-y-5">
                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const customModels = getCustomModelsForProvider(settings, provider);
                  const customModelInput = customModelInputByProvider[provider];
                  const customModelError = customModelErrorByProvider[provider] ?? null;
                  return (
                    <div
                      key={provider}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerSettings.description}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <label
                            htmlFor={`custom-model-slug-${provider}`}
                            className="block flex-1 space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Custom model slug
                            </span>
                            <Input
                              id={`custom-model-slug-${provider}`}
                              value={customModelInput}
                              onChange={(event) => {
                                const value = event.target.value;
                                setCustomModelInputByProvider((existing) => ({
                                  ...existing,
                                  [provider]: value,
                                }));
                                if (customModelError) {
                                  setCustomModelErrorByProvider((existing) => ({
                                    ...existing,
                                    [provider]: null,
                                  }));
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addCustomModel(provider);
                              }}
                              placeholder={providerSettings.placeholder}
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Example: <code>{providerSettings.example}</code>
                            </span>
                          </label>

                          <Button
                            className="sm:mt-6"
                            type="button"
                            onClick={() => addCustomModel(provider)}
                          >
                            Add model
                          </Button>
                        </div>

                        {customModelError ? (
                          <p className="text-xs text-destructive">{customModelError}</p>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>Saved custom models: {customModels.length}</p>
                            {customModels.length > 0 ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  updateSettings(
                                    patchCustomModels(provider, [
                                      ...getCustomModelsForProvider(defaults, provider),
                                    ]),
                                  )
                                }
                              >
                                Reset custom models
                              </Button>
                            ) : null}
                          </div>

                          {customModels.length > 0 ? (
                            <div className="space-y-2">
                              {customModels.map((slug) => (
                                <div
                                  key={`${provider}:${slug}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                >
                                  <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                    {slug}
                                  </code>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => removeCustomModel(provider, slug)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Responses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how assistant output is rendered during a turn.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
                  <p className="text-xs text-muted-foreground">
                    Show token-by-token output while a response is in progress.
                  </p>
                </div>
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableAssistantStreaming: Boolean(checked),
                    })
                  }
                  aria-label="Stream assistant messages"
                />
              </div>

              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: defaults.enableAssistantStreaming,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Prompt hotkeys</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Customize the prompt text sent by shortcut-driven worktree actions.
                </p>
              </div>

              <div className="rounded-lg border border-border bg-background p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">Commit and push changes</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Sends this prompt to the focused worktree thread.
                    </p>
                  </div>
                  <code className="rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    {commitAndPushShortcutLabel}
                  </code>
                </div>

                <div className="mt-3 space-y-2">
                  <Textarea
                    rows={3}
                    maxLength={MAX_PROMPT_HOTKEY_MESSAGE_LENGTH}
                    value={commitAndPushPromptInput}
                    onChange={(event) => setCommitAndPushPromptInput(event.target.value)}
                    onBlur={commitCommitAndPushPrompt}
                    placeholder={defaults.commitAndPushPrompt}
                    aria-label="Commit and push changes prompt"
                  />
                  <p className="text-xs text-muted-foreground">
                    {commitAndPushPromptInput.length}/{MAX_PROMPT_HOTKEY_MESSAGE_LENGTH}. Leave it
                    blank to restore the default prompt.
                  </p>
                </div>
              </div>

              {settings.commitAndPushPrompt !== defaults.commitAndPushPrompt ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        commitAndPushPrompt: defaults.commitAndPushPrompt,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>
            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">About</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Application version and environment information.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Version</p>
                  <p className="text-xs text-muted-foreground">
                    Current version of the application.
                  </p>
                </div>
                <code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>
              </div>
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
