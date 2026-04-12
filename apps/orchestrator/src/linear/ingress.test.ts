import { describe, expect, it } from "vitest";

import { linearThreadKeyFor, normalizeLinearWebhookInput } from "./ingress.ts";

describe("linear ingress normalization", () => {
  it("normalizes issue threads into stable keys", () => {
    const ingress = normalizeLinearWebhookInput({
      eventId: "evt-1",
      issueId: "issue-123",
      teamId: "team-1",
      title: "Investigate webhook ingress",
      body: "Please take a look at the new fork",
    });

    expect(ingress.threadKind).toBe("issue");
    expect(ingress.bodyPreview).toBe("Please take a look at the new fork");
    expect(linearThreadKeyFor(ingress)).toBe("linear:issue:issue-123");
  });

  it("normalizes comment threads into stable keys", () => {
    const ingress = normalizeLinearWebhookInput({
      eventId: "evt-2",
      issueId: "issue-123",
      commentId: "comment-9",
      threadKind: "comment",
      body: "This comment should thread into the same control plane",
    });

    expect(ingress.threadKind).toBe("comment");
    expect(linearThreadKeyFor(ingress)).toBe("linear:comment:issue-123:comment-9");
  });
});
