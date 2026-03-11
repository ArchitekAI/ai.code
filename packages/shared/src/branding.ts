export const APP_BASE_NAME = "AI Code";
export const MAX_APP_BASE_NAME_LENGTH = 64;

export function normalizeAppBaseName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > MAX_APP_BASE_NAME_LENGTH) {
    return null;
  }

  return normalized;
}

export function resolveAppBaseName(value: string | null | undefined): string {
  return normalizeAppBaseName(value) ?? APP_BASE_NAME;
}

export function getAppStageLabel(isDevelopment: boolean): string {
  return isDevelopment ? "Dev" : "Alpha";
}

export function getAppDisplayName(
  isDevelopment: boolean,
  appBaseName: string | null | undefined = APP_BASE_NAME,
): string {
  return `${resolveAppBaseName(appBaseName)} (${getAppStageLabel(isDevelopment)})`;
}
