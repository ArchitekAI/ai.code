export type LinearThreadKind = "issue" | "comment";

export interface LinearIngressEnvelope {
  readonly eventId: string;
  readonly threadKind: LinearThreadKind;
  readonly issueId: string;
  readonly commentId?: string;
  readonly teamId?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly authorName?: string;
  readonly bodyPreview?: string;
  readonly receivedAt: number;
}

export interface LinearWebhookInput {
  readonly eventId?: unknown;
  readonly issueId?: unknown;
  readonly commentId?: unknown;
  readonly teamId?: unknown;
  readonly threadKind?: unknown;
  readonly title?: unknown;
  readonly summary?: unknown;
  readonly authorName?: unknown;
  readonly bodyPreview?: unknown;
  readonly body?: unknown;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function previewBody(value: unknown): string | undefined {
  const body = asTrimmedString(value);
  if (body === undefined) {
    return undefined;
  }

  return body.length > 240 ? `${body.slice(0, 237)}...` : body;
}

export function linearThreadKeyFor(input: {
  readonly threadKind: LinearThreadKind;
  readonly issueId: string;
  readonly commentId?: string;
}) {
  return input.threadKind === "comment" && input.commentId !== undefined
    ? `linear:comment:${input.issueId}:${input.commentId}`
    : `linear:issue:${input.issueId}`;
}

export function normalizeLinearWebhookInput(input: unknown): LinearIngressEnvelope {
  if (input === null || typeof input !== "object") {
    throw new Error("Linear webhook payload must be an object");
  }

  const payload = input as LinearWebhookInput;
  const issueId = asTrimmedString(payload.issueId);
  if (issueId === undefined) {
    throw new Error("Linear webhook payload is missing issueId");
  }

  const eventId = asTrimmedString(payload.eventId) ?? `${issueId}:${Date.now()}`;
  const commentId = asTrimmedString(payload.commentId);
  const teamId = asTrimmedString(payload.teamId);
  const title = asTrimmedString(payload.title);
  const summary = asTrimmedString(payload.summary);
  const authorName = asTrimmedString(payload.authorName);
  const bodyPreview = previewBody(payload.bodyPreview ?? payload.body);
  const threadKind =
    payload.threadKind === "comment" || commentId !== undefined ? "comment" : "issue";

  return {
    eventId,
    issueId,
    threadKind,
    receivedAt: Date.now(),
    ...(commentId !== undefined ? { commentId } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(authorName !== undefined ? { authorName } : {}),
    ...(bodyPreview !== undefined ? { bodyPreview } : {}),
  };
}
