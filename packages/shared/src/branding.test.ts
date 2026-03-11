import { describe, expect, it } from "vitest";

import {
  APP_BASE_NAME,
  getAppDisplayName,
  getAppStageLabel,
  normalizeAppBaseName,
  resolveAppBaseName,
} from "./branding";

describe("normalizeAppBaseName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeAppBaseName("  My   App  ")).toBe("My App");
  });

  it("returns null for missing, empty, or oversized values", () => {
    expect(normalizeAppBaseName(null)).toBeNull();
    expect(normalizeAppBaseName(undefined)).toBeNull();
    expect(normalizeAppBaseName("   ")).toBeNull();
    expect(normalizeAppBaseName("x".repeat(65))).toBeNull();
  });
});

describe("resolveAppBaseName", () => {
  it("falls back to the default app name", () => {
    expect(resolveAppBaseName("")).toBe(APP_BASE_NAME);
  });
});

describe("getAppStageLabel", () => {
  it("returns the expected stage label", () => {
    expect(getAppStageLabel(true)).toBe("Dev");
    expect(getAppStageLabel(false)).toBe("Alpha");
  });
});

describe("getAppDisplayName", () => {
  it("builds the visible display name from the base name and stage", () => {
    expect(getAppDisplayName(true)).toBe("AI Code (Dev)");
    expect(getAppDisplayName(false, "Workspace AI")).toBe("Workspace AI (Alpha)");
  });
});
