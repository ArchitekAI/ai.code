---
name: daytona-sandbox-lifecycle
displayName: Daytona Sandbox Lifecycle
description: Manage Daytona sandboxes end to end. Use when creating, listing, updating, or deleting sandboxes, running commands or processes, working with files or Git inside sandboxes, or designing reusable sandbox workflows.
version: 1.0.0
author: Daytona
tags: [daytona, sandboxes, process, file-system, git, pty]
---

# Daytona Sandbox Lifecycle

Use this skill for the day-to-day mechanics of creating sandboxes, running work inside them, and cleaning them up safely.

## Documentation Sources

- Sandboxes: https://www.daytona.io/docs/en/sandboxes.md
- Process and Code Execution: https://www.daytona.io/docs/en/process-code-execution.md
- PTY: https://www.daytona.io/docs/en/pty.md
- File System Operations: https://www.daytona.io/docs/en/file-system-operations.md
- Git Operations: https://www.daytona.io/docs/en/git-operations.md
- CLI Reference: https://www.daytona.io/docs/en/tools/cli.md
- Docs map: [`../daytona/references/docs-map.md`](../daytona/references/docs-map.md)

## Core Workflow

1. Decide whether to create a fresh sandbox, restore from a snapshot, or reuse an existing sandbox.
2. Configure resources, labels, mounts, and repository state before running workloads.
3. Use process or PTY APIs intentionally: process APIs for deterministic execution, PTY for interactive shells.
4. Keep file-system and Git operations explicit so agent state stays understandable.
5. Tear down or snapshot the sandbox once the useful state has been captured.

## Guidance

- Prefer short-lived sandboxes for isolated agent tasks unless persistence is clearly needed.
- Use labels and metadata consistently so sandboxes can be traced back to jobs, users, or threads.
- Favor deterministic command execution over interactive shells in background workflows.
- Reach for PTY only when the task truly needs terminal interactivity.
- If the user wants IDE-like behavior, check whether file operations, LSP, or Git primitives already cover the use case before inventing a custom transport.

## Common Decision Points

- Fresh sandbox vs snapshot restore: restore when startup cost matters and the environment is reproducible.
- Process execution vs PTY: use process APIs for automation, PTY for interactive sessions.
- Clone inside sandbox vs mount or copy files: clone when the repo itself is the source of truth; mount or copy when the host workspace should remain authoritative.
