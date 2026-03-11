/**
 * Sanitize an arbitrary string into a valid, lowercase git branch fragment.
 * Strips quotes, collapses separators, limits to 64 chars.
 */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

export const DEFAULT_GIT_BRANCH_PREFIX = "feature/";

/**
 * Normalize a user-provided branch prefix into a lowercase slash-safe namespace
 * that always ends with a trailing slash.
 */
export function normalizeGitBranchPrefix(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }

  if (!/[a-z0-9]/i.test(trimmed)) {
    return null;
  }

  const sanitized = sanitizeBranchFragment(trimmed)
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");

  if (sanitized.length === 0) {
    return null;
  }

  return `${sanitized}/`;
}

/**
 * Apply a normalized branch prefix to a branch fragment.
 */
export function buildPrefixedBranchName(prefix: string, raw: string): string {
  const normalizedPrefix = normalizeGitBranchPrefix(prefix) ?? DEFAULT_GIT_BRANCH_PREFIX;
  const sanitized = sanitizeBranchFragment(raw).replace(/^\/+/, "");
  const withoutPrefix = sanitized.startsWith(normalizedPrefix)
    ? sanitized.slice(normalizedPrefix.length)
    : sanitized;
  const normalizedFragment = withoutPrefix.replace(/^\/+/, "");

  return `${normalizedPrefix}${normalizedFragment.length > 0 ? normalizedFragment : "update"}`;
}

/**
 * Resolve a unique prefixed branch name that doesn't collide with existing
 * branches. Appends a numeric suffix when needed.
 */
export function resolveAutoPrefixedBranchName(
  existingBranchNames: readonly string[],
  prefix: string,
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = buildPrefixedBranchName(
    prefix,
    preferred && preferred.length > 0 ? preferred : "update",
  );
  const existingNames = new Set(existingBranchNames.map((branch) => branch.toLowerCase()));

  if (!existingNames.has(resolvedBase)) {
    return resolvedBase;
  }

  let suffix = 2;
  while (existingNames.has(`${resolvedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${resolvedBase}-${suffix}`;
}

/**
 * Sanitize a string into a `feature/…` branch name.
 * Preserves an existing `feature/` prefix or slash-separated namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  return buildPrefixedBranchName(DEFAULT_GIT_BRANCH_PREFIX, raw);
}

const AUTO_FEATURE_BRANCH_FALLBACK = `${DEFAULT_GIT_BRANCH_PREFIX}update`;

/**
 * Resolve a unique `feature/…` branch name that doesn't collide with
 * any existing branch. Appends a numeric suffix when needed.
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  return resolveAutoPrefixedBranchName(
    existingBranchNames,
    DEFAULT_GIT_BRANCH_PREFIX,
    preferredBranch ?? AUTO_FEATURE_BRANCH_FALLBACK,
  );
}
