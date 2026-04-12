import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const controlThreadState = v.union(
  v.literal("open"),
  v.literal("active"),
  v.literal("waiting"),
  v.literal("closed"),
);

const linearThreadKind = v.union(v.literal("issue"), v.literal("comment"));

export default defineSchema({
  controlThreads: defineTable({
    source: v.literal("linear"),
    linearThreadKey: v.string(),
    linearThreadKind,
    linearIssueId: v.string(),
    linearCommentId: v.optional(v.string()),
    linearTeamId: v.optional(v.string()),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    state: controlThreadState,
    lastEventId: v.string(),
    lastIngressAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_linear_thread_key", ["linearThreadKey"])
    .index("by_updated_at", ["updatedAt"]),
  controlThreadEvents: defineTable({
    controlThreadId: v.id("controlThreads"),
    eventKey: v.string(),
    kind: v.string(),
    payloadJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_control_thread_id", ["controlThreadId"])
    .index("by_event_key", ["eventKey"]),
  controlThreadMessages: defineTable({
    controlThreadId: v.id("controlThreads"),
    externalMessageKey: v.string(),
    authorName: v.optional(v.string()),
    bodyPreview: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_control_thread_id", ["controlThreadId"])
    .index("by_external_message_key", ["externalMessageKey"]),
  chatStateLocks: defineTable({
    lockKey: v.string(),
    ownerKey: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_lock_key", ["lockKey"]),
  chatStateSubscriptions: defineTable({
    subscriptionKey: v.string(),
    threadKey: v.string(),
    subscriberKey: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_subscription_key", ["subscriptionKey"])
    .index("by_thread_key", ["threadKey"]),
  chatStateKv: defineTable({
    kvKey: v.string(),
    valueJson: v.string(),
    updatedAt: v.number(),
  }).index("by_kv_key", ["kvKey"]),
});
