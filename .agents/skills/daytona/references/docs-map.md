# Daytona Docs Map

Use this file when you need to locate the right official Daytona page quickly. Keep `SKILL.md` files lean and fetch the latest docs from these URLs when implementing.

## Getting Started and Setup

- Getting Started: https://www.daytona.io/docs/en/getting-started.md
- Configuration: https://www.daytona.io/docs/en/configuration.md
- API Keys: https://www.daytona.io/docs/en/api-keys.md
- MCP: https://www.daytona.io/docs/en/mcp.md
- Architecture: https://www.daytona.io/docs/en/architecture.md

## Sandbox Workflows

- Sandboxes: https://www.daytona.io/docs/en/sandboxes.md
- Process and Code Execution: https://www.daytona.io/docs/en/process-code-execution.md
- PTY: https://www.daytona.io/docs/en/pty.md
- File System Operations: https://www.daytona.io/docs/en/file-system-operations.md
- Git Operations: https://www.daytona.io/docs/en/git-operations.md
- Language Server Protocol: https://www.daytona.io/docs/en/language-server-protocol.md
- CLI Reference: https://www.daytona.io/docs/en/tools/cli.md

## Images, Snapshots, and Storage

- Declarative Builder: https://www.daytona.io/docs/en/declarative-builder.md
- Snapshots: https://www.daytona.io/docs/en/snapshots.md
- Volumes: https://www.daytona.io/docs/en/volumes.md

## Computer Use and Interactive Automation

- Computer Use: https://www.daytona.io/docs/en/computer-use.md
- VNC Access: https://www.daytona.io/docs/en/vnc-access.md

## Agents and Framework Guides

- MCP Server: https://www.daytona.io/docs/en/mcp.md
- Next.js integration section: https://www.daytona.io/docs/en/getting-started.md#daytona-in-nextjs-projects
- Vite integration section: https://www.daytona.io/docs/en/getting-started.md#daytona-in-vite-projects
- Mastra guide: https://www.daytona.io/docs/en/guides/mastra/mastra-coding-agent.md
- Claude Agent SDK guide: https://www.daytona.io/docs/en/guides/claude/claude-agent-sdk-interactive-terminal-sandbox.md
- LangChain guide: https://www.daytona.io/docs/en/guides/langchain/langchain-data-analysis.md
- Google ADK guide: https://www.daytona.io/docs/en/guides/google-adk-code-generator.md

## Operations, Security, and Platform Admin

- Audit Logs: https://www.daytona.io/docs/en/audit-logs.md
- Webhooks: https://www.daytona.io/docs/en/webhooks.md
- Custom Domain and Authentication: https://www.daytona.io/docs/en/custom-domain-authentication.md
- Network Limits: https://www.daytona.io/docs/en/network-limits.md
- Limits: https://www.daytona.io/docs/en/limits.md
- Organizations: https://www.daytona.io/docs/en/organizations.md
- Billing: https://www.daytona.io/docs/en/billing.md
- OSS Deployment: https://www.daytona.io/docs/en/oss-deployment.md
- OpenTelemetry Collection: https://www.daytona.io/docs/en/experimental/otel-collection.md
- Security Exhibit: https://www.daytona.io/docs/en/security-exhibit.md
- VPN Connections: https://www.daytona.io/docs/en/vpn-connections.md

## SDK References

- TypeScript SDK overview: https://www.daytona.io/docs/en/typescript-sdk.md
- TypeScript Daytona client: https://www.daytona.io/docs/en/typescript-sdk/daytona.md
- TypeScript Sandbox: https://www.daytona.io/docs/en/typescript-sdk/sandbox.md
- TypeScript Process: https://www.daytona.io/docs/en/typescript-sdk/process.md
- TypeScript Snapshot: https://www.daytona.io/docs/en/typescript-sdk/snapshot.md
- TypeScript Volume: https://www.daytona.io/docs/en/typescript-sdk/volume.md
- TypeScript Computer Use: https://www.daytona.io/docs/en/typescript-sdk/computer-use.md
- Go SDK overview: https://www.daytona.io/docs/en/go-sdk/daytona.md

## Suggested Search Patterns

- Sandbox lifecycle: `rg -n "sandboxes|process|pty|file-system|git-operations" .agents/skills/daytona/references/docs-map.md`
- Images and persistence: `rg -n "declarative|snapshot|volume" .agents/skills/daytona/references/docs-map.md`
- Platform ops: `rg -n "audit|webhooks|limits|billing|security|vpn" .agents/skills/daytona/references/docs-map.md`
