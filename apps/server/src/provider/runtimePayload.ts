import { type ProviderRuntimeBinding } from "./Services/ProviderSessionDirectory.ts";

export function readProviderOptionsFromRuntimePayload(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): Record<string, unknown> | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }

  const raw = "providerOptions" in runtimePayload ? runtimePayload.providerOptions : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  return raw as Record<string, unknown>;
}

export function readCwdFromRuntimePayload(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }

  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") {
    return undefined;
  }

  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
