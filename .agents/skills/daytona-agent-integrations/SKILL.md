---
name: daytona-agent-integrations
displayName: Daytona Agent Integrations
description: Integrate Daytona with AI agents, coding agents, and framework-based toolchains. Use when building sandbox-backed agent workflows, exposing Daytona through MCP, or adapting Daytona to frameworks like LangChain, Mastra, Claude Agent SDK, or Google ADK.
version: 1.0.0
author: Daytona
tags: [daytona, agents, mcp, langchain, mastra, claude, adk]
---

# Daytona Agent Integrations

Use this skill when Daytona is part of a higher-level agent system rather than a standalone sandbox tool.

## Documentation Sources

- MCP: https://www.daytona.io/docs/en/mcp.md
- Getting Started: https://www.daytona.io/docs/en/getting-started.md
- Mastra guide: https://www.daytona.io/docs/en/guides/mastra/mastra-coding-agent.md
- Claude Agent SDK guide: https://www.daytona.io/docs/en/guides/claude/claude-agent-sdk-interactive-terminal-sandbox.md
- LangChain guide: https://www.daytona.io/docs/en/guides/langchain/langchain-data-analysis.md
- Google ADK guide: https://www.daytona.io/docs/en/guides/google-adk-code-generator.md
- Docs map: [`../daytona/references/docs-map.md`](../daytona/references/docs-map.md)

## Integration Choices

- Use the SDK when your application directly orchestrates sandbox creation and execution.
- Use MCP when Daytona should be exposed as a tool provider to another agent runtime.
- Use framework guides when you need Daytona to fit a specific orchestration model rather than inventing the wiring yourself.

## Guidance

- Keep Daytona responsible for isolated execution and environment control, not long-term business state.
- Separate agent planning from sandbox execution so failures are easier to diagnose.
- Define clear boundaries for file ingress, secrets, network access, and teardown behavior.
- Standardize sandbox labels and metadata so agent runs can be traced and cleaned up.
- Prefer well-scoped tools over broad “do anything in the sandbox” abstractions when building agent systems for non-technical users.

## Good Fits

- Coding agents that need safe execution environments
- Tool-calling agents that need ephemeral workspaces
- Human-in-the-loop background agents
- MCP-based integrations where Daytona becomes one tool in a larger agent stack
