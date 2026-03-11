---
name: daytona
displayName: Daytona
description: Umbrella skill for Daytona sandbox development. Routes to focused Daytona subskills for setup, sandbox lifecycle, images and storage, computer use, agent integrations, and platform operations.
version: 1.0.0
author: Daytona
tags: [daytona, sandbox, infra, agents]
---

# Daytona Skills

This is the umbrella skill for Daytona work. Use it to choose the right Daytona subskill instead of loading broad documentation by default.

## Core Skills

| Skill              | Command                       | Use When                                                                                                    |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Foundations        | `/daytona-foundations`        | Setting up Daytona, choosing SDK vs CLI vs API vs MCP, configuring auth and environment                     |
| Sandbox Lifecycle  | `/daytona-sandbox-lifecycle`  | Creating, reusing, inspecting, and deleting sandboxes; running code, files, Git, PTY, and process workflows |
| Images and Storage | `/daytona-images-storage`     | Building declarative images, working with Dockerfiles, snapshots, and volumes                               |
| Computer Use       | `/daytona-computer-use`       | Automating desktop/browser interactions, screenshots, keyboard/mouse input, and recordings                  |
| Agent Integrations | `/daytona-agent-integrations` | Wiring Daytona into coding agents, MCP flows, and framework-specific agent stacks                           |
| Platform Ops       | `/daytona-platform-ops`       | Managing API keys, audit logs, webhooks, limits, security, networking, billing, and deployment concerns     |

## How To Use This Skill

1. Pick the narrowest Daytona subskill that matches the task.
2. Use [`references/docs-map.md`](references/docs-map.md) when you need official doc links or want to quickly locate a specific topic.
3. Fetch the latest official docs before implementing details that might have changed.

## Quick Start

For most Daytona work:

1. Start with `/daytona-foundations` if the project is not configured yet.
2. Use `/daytona-sandbox-lifecycle` for day-to-day sandbox creation and command execution.
3. Add `/daytona-images-storage` when reproducibility or persistence matters.
4. Use `/daytona-agent-integrations` for agent tooling or MCP-driven workflows.
5. Use `/daytona-platform-ops` for production hardening, org controls, or debugging account-level issues.

## Documentation

- Primary docs: https://www.daytona.io/docs
- LLM-optimized index: https://www.daytona.io/docs/llms.txt
- Shared local docs map: [`references/docs-map.md`](references/docs-map.md)
