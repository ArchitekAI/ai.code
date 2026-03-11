---
name: daytona-computer-use
displayName: Daytona Computer Use
description: Use Daytona computer-use capabilities for interactive desktop and browser automation. Use when the task involves keyboard and mouse control, screenshots, recordings, VNC access, or monitoring GUI-driven workflows inside a sandbox.
version: 1.0.0
author: Daytona
tags: [daytona, computer-use, automation, screenshots, vnc, browser]
---

# Daytona Computer Use

Use this skill for GUI automation workflows that need a visual desktop, browser interactions, screenshots, or recordings inside a Daytona sandbox.

## Documentation Sources

- Computer Use: https://www.daytona.io/docs/en/computer-use.md
- TypeScript Computer Use SDK: https://www.daytona.io/docs/en/typescript-sdk/computer-use.md
- VNC Access: https://www.daytona.io/docs/en/vnc-access.md
- Docs map: [`../daytona/references/docs-map.md`](../daytona/references/docs-map.md)

## Core Workflow

1. Start or connect to the computer-use process for the target sandbox.
2. Confirm display state before sending input.
3. Use mouse and keyboard primitives conservatively and verify results with screenshots.
4. Record runs when the workflow needs debugging, auditing, or playback.
5. Stop or reset the process cleanly if the UI gets into a bad state.

## Guidance

- Prefer normal sandbox APIs over computer use when the task can be solved without a GUI.
- Treat screenshots as part of the control loop, not just debugging output.
- Keep input steps small and observable so failures are easy to recover from.
- Use recordings for flaky flows, demos, and postmortems.
- Reach for VNC when a human needs to inspect or guide the live environment.

## Good Fits

- Browser-based workflows that lack an API
- Visual QA or reproduction tasks
- Human-in-the-loop agent operations
- Demonstrating or auditing interactive agent behavior
