---
name: daytona-foundations
displayName: Daytona Foundations
description: Set up Daytona for application development or agent infrastructure. Use when choosing between the SDK, CLI, API, or MCP server, configuring authentication, or debugging basic Daytona setup issues.
version: 1.0.0
author: Daytona
tags: [daytona, setup, configuration, sdk, cli, mcp]
---

# Daytona Foundations

Use this skill when the task is about getting Daytona working correctly before deeper sandbox features are built.

## Documentation Sources

- Getting Started: https://www.daytona.io/docs/en/getting-started.md
- Configuration: https://www.daytona.io/docs/en/configuration.md
- API Keys: https://www.daytona.io/docs/en/api-keys.md
- MCP: https://www.daytona.io/docs/en/mcp.md
- Docs map: [`../daytona/references/docs-map.md`](../daytona/references/docs-map.md)

## Interface Selection

- Use the SDK when Daytona is part of application code or a backend service.
- Use the CLI for local testing, debugging, and manual inspection.
- Use the API when you need direct HTTP integration from another service.
- Use the MCP server when another agent platform should call Daytona as a tool surface.

## Setup Checklist

1. Create an API key with the minimum scopes required.
2. Configure Daytona via environment variables or code-based config.
3. Decide whether the workflow needs dashboard access, CLI access, SDK access, or all three.
4. Run a minimal smoke test that creates a sandbox and executes one command.
5. Confirm the target runtime, shell, and authentication model before adding higher-level abstractions.

## Guidance

- Prefer TypeScript SDK usage in this Bun monorepo unless the user explicitly wants another runtime.
- Keep secrets out of prompts and checked-in files; use environment variables or secret managers.
- If setup is failing, verify auth, base URL, region or org context, and shell configuration before debugging application code.
- If the user is still deciding how to integrate Daytona, start from the smallest reproducible sandbox creation example and expand from there.
