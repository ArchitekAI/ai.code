import type { OrchestrationThreadActivity } from "@t3tools/contracts";

const MAX_LINEAR_RESULT_CHARS = 4_000;

type LinearActivityContent =
  | {
      readonly type: "thought";
      readonly body: string;
    }
  | {
      readonly type: "action";
      readonly action: string;
      readonly parameter?: string;
      readonly result?: string;
    }
  | {
      readonly type: "error";
      readonly body: string;
    };

export interface FormattedLinearActivity {
  readonly content: LinearActivityContent;
  readonly ephemeral: boolean;
}

interface ActivityPayloadRecord extends Record<string, unknown> {
  readonly data?: unknown;
  readonly detail?: unknown;
  readonly explanation?: unknown;
  readonly itemType?: unknown;
  readonly message?: unknown;
  readonly plan?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncateResult(value: string): string {
  return value.length > MAX_LINEAR_RESULT_CHARS
    ? `${value.slice(0, MAX_LINEAR_RESULT_CHARS)}\n\n[truncated]`
    : value;
}

function formatToolName(toolName: string): string {
  const stripped = toolName.replace(/^mcp__[^_]+__/, "");
  return stripped
    .split(/[_-]+/)
    .map((segment) => {
      const lower = segment.toLowerCase();
      switch (lower) {
        case "github":
          return "GitHub";
        case "gitlab":
          return "GitLab";
        case "linear":
          return "Linear";
        case "pr":
          return "PR";
        case "url":
          return "URL";
        case "mcp":
          return "MCP";
        default:
          return lower.charAt(0).toUpperCase() + lower.slice(1);
      }
    })
    .join(" ");
}

function formatLineRange(input: Record<string, unknown>): string | null {
  const filePath =
    asString(input.file_path) ??
    asString(input.filePath) ??
    asString(input.path) ??
    asString(input.file);
  if (!filePath) {
    return null;
  }

  const offset = typeof input.offset === "number" ? input.offset : null;
  const limit = typeof input.limit === "number" ? input.limit : null;
  if (offset === null && limit === null) {
    return filePath;
  }

  const start = offset ?? 0;
  const end = limit !== null ? start + limit : "end";
  return `${filePath} (lines ${start + 1}-${end})`;
}

function formatToolParameter(input: Record<string, unknown>): string | null {
  return (
    asString(input.command) ??
    formatLineRange(input) ??
    asString(input.url) ??
    asString(input.query) ??
    asString(input.search_query) ??
    asString(input.pattern) ??
    asString(input.path) ??
    asString(input.issueIdentifier) ??
    asString(input.issueId) ??
    asString(input.issue) ??
    asString(input.project) ??
    asString(input.branch) ??
    asString(input.name) ??
    null
  );
}

function readContentText(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const textParts = value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) {
      return [];
    }
    const text =
      asString(record.text) ??
      asString(record.content) ??
      asString(record.body) ??
      asString(record.value);
    return text ? [text] : [];
  });
  return textParts.length > 0 ? textParts.join("\n\n") : null;
}

function formatUnknownResult(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return (
    asString(record.body) ??
    asString(record.message) ??
    asString(record.output) ??
    asString(record.text) ??
    readContentText(record.content) ??
    asString(record.url) ??
    null
  );
}

function formatCommandResult(item: Record<string, unknown>): string {
  const output =
    asString(item.aggregatedOutput) ??
    asString(item.output) ??
    asString(item.stdout) ??
    asString(item.stderr);
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;

  if (output) {
    return truncateResult(output);
  }
  if (exitCode !== null) {
    return exitCode === 0 ? "Completed with no output." : `Exited with code ${exitCode}.`;
  }
  return "Completed.";
}

function formatMcpResult(item: Record<string, unknown>): string {
  const resultRecord = asRecord(item.result) ?? item;
  const structured = asRecord(resultRecord.structuredContent);
  const text =
    asString(structured?.url) ??
    asString(structured?.message) ??
    formatUnknownResult(structured) ??
    formatUnknownResult(resultRecord.content) ??
    formatUnknownResult(resultRecord.result) ??
    formatUnknownResult(resultRecord.output) ??
    "Completed.";
  return truncateResult(text);
}

function formatPlanBody(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload) as ActivityPayloadRecord | null;
  if (!payload) {
    return null;
  }

  const lines: string[] = [];
  const explanation = asString(payload.explanation);
  if (explanation) {
    lines.push(explanation);
  }

  if (Array.isArray(payload.plan)) {
    const planLines = payload.plan.flatMap((entry) => {
      const record = asRecord(entry);
      if (!record) {
        return [];
      }
      const step = asString(record.step);
      const status = asString(record.status) ?? "pending";
      if (!step) {
        return [];
      }

      const marker = status === "completed" ? "[x]" : status === "in_progress" ? "[-]" : "[ ]";
      return [`${marker} ${step}`];
    });
    lines.push(...planLines);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function readActivityPayload(activity: OrchestrationThreadActivity): ActivityPayloadRecord | null {
  return asRecord(activity.payload) as ActivityPayloadRecord | null;
}

function readLifecycleItem(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  const payload = readActivityPayload(activity);
  if (!payload) {
    return null;
  }

  const dataRecord = asRecord(payload.data);
  if (!dataRecord) {
    return null;
  }

  return asRecord(dataRecord.item) ?? dataRecord;
}

function readLifecycleItemType(activity: OrchestrationThreadActivity): string | null {
  const payload = readActivityPayload(activity);
  return payload ? asString(payload.itemType) : null;
}

function readLifecycleDetail(activity: OrchestrationThreadActivity): string | null {
  const payload = readActivityPayload(activity);
  return payload ? asString(payload.detail) : null;
}

function formatCompletedToolActivity(
  activity: OrchestrationThreadActivity,
): FormattedLinearActivity | null {
  const itemType = readLifecycleItemType(activity);
  const item = readLifecycleItem(activity);
  const detail = readLifecycleDetail(activity);

  switch (itemType) {
    case "command_execution": {
      const command = (item && asString(item.command)) ?? detail;
      return {
        content: {
          type: "action",
          action: "Bash",
          ...(command ? { parameter: command } : {}),
          result: formatCommandResult(item ?? {}),
        },
        ephemeral: false,
      };
    }
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
    case "web_search":
    case "image_view": {
      const toolName =
        (item && (asString(item.tool) ?? asString(item.name) ?? asString(item.title))) ??
        activity.summary;
      const action = formatToolName(toolName);
      const parameter =
        (item && formatToolParameter(asRecord(item.arguments) ?? item)) ?? detail ?? undefined;
      const result =
        itemType === "mcp_tool_call" ? formatMcpResult(item ?? {}) : formatUnknownResult(item);
      return {
        content: {
          type: "action",
          action,
          ...(parameter ? { parameter } : {}),
          ...(result ? { result: truncateResult(result) } : {}),
        },
        ephemeral: false,
      };
    }
    case "file_change":
      // The diff activity is a clearer durable summary than low-level file change tool chatter.
      return null;
    default:
      return null;
  }
}

function shouldSuppressToolProgress(activity: OrchestrationThreadActivity): boolean {
  const itemType = readLifecycleItemType(activity);
  if (!itemType) {
    return false;
  }
  return [
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "dynamic_tool_call",
    "collab_agent_tool_call",
    "web_search",
    "image_view",
  ].includes(itemType);
}

export function formatLinearActivityContent(
  activity: OrchestrationThreadActivity,
): FormattedLinearActivity | null {
  const payload = readActivityPayload(activity);
  const detail = readLifecycleDetail(activity);

  switch (activity.kind) {
    case "tool.started":
    case "tool.updated":
      if (shouldSuppressToolProgress(activity)) {
        return null;
      }
      return {
        content: {
          type: "thought",
          body: detail ? `${activity.summary}: ${detail}` : activity.summary,
        },
        ephemeral: true,
      };
    case "tool.completed":
      return formatCompletedToolActivity(activity);
    case "task.started":
      return {
        content: {
          type: "thought",
          body: activity.summary,
        },
        ephemeral: false,
      };
    case "task.progress":
    case "task.completed":
      return {
        content: {
          type: "thought",
          body: detail ? `${activity.summary}: ${detail}` : activity.summary,
        },
        ephemeral: false,
      };
    case "approval.requested":
      return {
        content: {
          type: "thought",
          body: `Waiting for approval: ${activity.summary}`,
        },
        ephemeral: false,
      };
    case "approval.resolved":
      return {
        content: {
          type: "thought",
          body: "Approval resolved",
        },
        ephemeral: false,
      };
    case "runtime.error":
      return {
        content: {
          type: "error",
          body: asString(payload?.message) ?? activity.summary,
        },
        ephemeral: false,
      };
    case "runtime.warning": {
      const message = asString(payload?.message) ?? activity.summary;
      const detailRecord = asRecord(payload?.detail);
      if (message.startsWith("Reconnecting") || detailRecord?.willRetry === true) {
        return null;
      }
      return {
        content: {
          type: "thought",
          body: `Warning: ${message}`,
        },
        ephemeral: false,
      };
    }
    case "turn.plan.updated": {
      const body = formatPlanBody(activity);
      if (!body) {
        return null;
      }
      return {
        content: {
          type: "thought",
          body,
        },
        ephemeral: false,
      };
    }
    case "prompt-mode.entered":
      return {
        content: {
          type: "thought",
          body: activity.summary,
        },
        ephemeral: false,
      };
    case "user-input.requested":
      return {
        content: {
          type: "thought",
          body: "Waiting for user input...",
        },
        ephemeral: false,
      };
    case "context-compaction":
    case "context-window.updated":
    case "user-input.resolved":
      return null;
    default:
      return null;
  }
}
