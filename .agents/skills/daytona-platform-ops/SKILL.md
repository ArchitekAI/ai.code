---
name: daytona-platform-ops
displayName: Daytona Platform Ops
description: Operate Daytona safely in shared or production contexts. Use when dealing with API keys, organizations, audit logs, webhooks, limits, billing, custom domains, telemetry, networking, VPN access, or deployment architecture.
version: 1.0.0
author: Daytona
tags: [daytona, operations, security, webhooks, limits, billing, telemetry]
---

# Daytona Platform Ops

Use this skill for account-level, security, reliability, and production operations work around Daytona.

## Documentation Sources

- API Keys: https://www.daytona.io/docs/en/api-keys.md
- Audit Logs: https://www.daytona.io/docs/en/audit-logs.md
- Webhooks: https://www.daytona.io/docs/en/webhooks.md
- Custom Domain and Authentication: https://www.daytona.io/docs/en/custom-domain-authentication.md
- Network Limits: https://www.daytona.io/docs/en/network-limits.md
- Limits: https://www.daytona.io/docs/en/limits.md
- Organizations: https://www.daytona.io/docs/en/organizations.md
- Billing: https://www.daytona.io/docs/en/billing.md
- OpenTelemetry Collection: https://www.daytona.io/docs/en/experimental/otel-collection.md
- Security Exhibit: https://www.daytona.io/docs/en/security-exhibit.md
- VPN Connections: https://www.daytona.io/docs/en/vpn-connections.md
- OSS Deployment: https://www.daytona.io/docs/en/oss-deployment.md
- Docs map: [`../daytona/references/docs-map.md`](../daytona/references/docs-map.md)

## Guidance

- Prefer least-privilege API keys and org-scoped controls from the start.
- Turn on auditability early for multi-user or agent-driven systems.
- Treat limits, network policy, and billing as design constraints rather than afterthoughts.
- Use webhooks and telemetry to observe lifecycle events instead of polling when possible.
- Reach for custom domains, auth headers, and VPN connectivity only when the integration truly needs them.

## Operational Checklist

1. Confirm org, auth, and key scopes.
2. Understand platform limits that affect the workload.
3. Define the event and telemetry story before scaling usage.
4. Decide whether Daytona Cloud or OSS deployment fits the control and compliance needs.
5. Document cleanup, cost controls, and incident visibility for long-running agent systems.
