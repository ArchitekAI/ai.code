import path from "node:path";

export function managedWorktreeRootForRepoPath(repoPath: string, homeDir?: string): string {
  const resolvedHomeDir = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(resolvedHomeDir, ".t3", "worktrees", path.basename(repoPath));
}

export function defaultManagedWorktreePath(input: {
  repoPath: string;
  managedPathName: string;
  homeDir?: string;
}): string {
  return path.join(
    managedWorktreeRootForRepoPath(input.repoPath, input.homeDir),
    input.managedPathName,
  );
}
