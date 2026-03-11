import { type ProviderKind } from "@repo/contracts";
import { getModelOptions, normalizeModelSlug } from "@repo/shared/model";

const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set<string>(getModelOptions("codex").map((option) => option.slug)),
  claudeCode: new Set<string>(getModelOptions("claudeCode").map((option) => option.slug)),
};

export type CustomModelsByProvider = Readonly<Partial<Record<ProviderKind, readonly string[]>>>;

function getNormalizedCustomModels(
  provider: ProviderKind,
  customModelsByProvider: CustomModelsByProvider | undefined,
): ReadonlySet<string> {
  return new Set(
    (customModelsByProvider?.[provider] ?? []).flatMap((model) => {
      const normalized = normalizeModelSlug(model, provider);
      return normalized ? [normalized] : [];
    }),
  );
}

export function inferProviderForModel(input: {
  readonly model: string;
  readonly sessionProviderName?: string | null;
  readonly customModelsByProvider?: CustomModelsByProvider;
}): ProviderKind {
  if (input.sessionProviderName === "codex" || input.sessionProviderName === "claudeCode") {
    return input.sessionProviderName;
  }

  for (const provider of ["codex", "claudeCode"] as const) {
    const normalized = normalizeModelSlug(input.model, provider);
    if (!normalized) {
      continue;
    }
    if (BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider].has(normalized)) {
      return provider;
    }
    if (getNormalizedCustomModels(provider, input.customModelsByProvider).has(normalized)) {
      return provider;
    }
  }

  return "codex";
}
