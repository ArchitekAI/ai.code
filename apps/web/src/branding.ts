import {
  getAppDisplayName as getSharedAppDisplayName,
  getAppStageLabel,
} from "@repo/shared/branding";

export { APP_BASE_NAME } from "@repo/shared/branding";

export const APP_STAGE_LABEL = getAppStageLabel(import.meta.env.DEV);
export function getAppDisplayName(customAppName?: string | null): string {
  return getSharedAppDisplayName(import.meta.env.DEV, customAppName);
}
export const APP_DISPLAY_NAME = getAppDisplayName();
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
