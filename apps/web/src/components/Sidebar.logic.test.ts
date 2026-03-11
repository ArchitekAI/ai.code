import { describe, expect, it } from "vitest";

import { resolveWorktreeDiffStat, shouldClearThreadSelectionOnMouseDown } from "./Sidebar.logic";

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("resolveWorktreeDiffStat", () => {
  it("returns null when git status is unavailable", () => {
    expect(resolveWorktreeDiffStat(null)).toBeNull();
  });

  it("returns null when both insertions and deletions are zero", () => {
    expect(
      resolveWorktreeDiffStat({
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      }),
    ).toBeNull();
  });

  it("returns insertions and deletions from the working tree", () => {
    expect(
      resolveWorktreeDiffStat({
        workingTree: {
          files: [],
          insertions: 12,
          deletions: 4,
        },
      }),
    ).toEqual({ additions: 12, deletions: 4 });
  });
});
