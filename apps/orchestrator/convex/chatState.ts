import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

const lockArgs = {
  key: v.string(),
  ownerKey: v.string(),
  ttlMs: v.optional(v.number()),
} as const;

const subscriptionArgs = {
  threadKey: v.string(),
  subscriberKey: v.string(),
} as const;

const kvArgs = {
  key: v.string(),
  valueJson: v.string(),
} as const;

export const acquireLock = internalMutation({
  args: lockArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const ttlMs = args.ttlMs ?? 30_000;
    const current = await ctx.db
      .query("chatStateLocks")
      .withIndex("by_lock_key", (query: any) => query.eq("lockKey", args.key))
      .unique();

    if (current !== null && current.expiresAt > now && current.ownerKey !== args.ownerKey) {
      return false;
    }

    if (current === null) {
      await ctx.db.insert("chatStateLocks", {
        lockKey: args.key,
        ownerKey: args.ownerKey,
        expiresAt: now + ttlMs,
        createdAt: now,
        updatedAt: now,
      });
      return true;
    }

    await ctx.db.patch(current._id, {
      ownerKey: args.ownerKey,
      expiresAt: now + ttlMs,
      updatedAt: now,
    });
    return true;
  },
});

export const releaseLock = internalMutation({
  args: {
    key: v.string(),
    ownerKey: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("chatStateLocks")
      .withIndex("by_lock_key", (query: any) => query.eq("lockKey", args.key))
      .unique();

    if (current === null || current.ownerKey !== args.ownerKey) {
      return false;
    }

    await ctx.db.delete(current._id);
    return true;
  },
});

export const subscribeThread = internalMutation({
  args: subscriptionArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const key = `${args.threadKey}:${args.subscriberKey}`;
    const current = await ctx.db
      .query("chatStateSubscriptions")
      .withIndex("by_subscription_key", (query: any) => query.eq("subscriptionKey", key))
      .unique();

    if (current === null) {
      await ctx.db.insert("chatStateSubscriptions", {
        subscriptionKey: key,
        threadKey: args.threadKey,
        subscriberKey: args.subscriberKey,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.patch(current._id, { updatedAt: now });
  },
});

export const unsubscribeThread = internalMutation({
  args: subscriptionArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = `${args.threadKey}:${args.subscriberKey}`;
    const current = await ctx.db
      .query("chatStateSubscriptions")
      .withIndex("by_subscription_key", (query: any) => query.eq("subscriptionKey", key))
      .unique();

    if (current === null) {
      return;
    }

    await ctx.db.delete(current._id);
  },
});

export const setValue = internalMutation({
  args: kvArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const current = await ctx.db
      .query("chatStateKv")
      .withIndex("by_kv_key", (query: any) => query.eq("kvKey", args.key))
      .unique();

    if (current === null) {
      await ctx.db.insert("chatStateKv", {
        kvKey: args.key,
        valueJson: args.valueJson,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.patch(current._id, {
      valueJson: args.valueJson,
      updatedAt: now,
    });
  },
});

export const getValue = internalQuery({
  args: {
    key: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("chatStateKv")
      .withIndex("by_kv_key", (query: any) => query.eq("kvKey", args.key))
      .unique();

    return current?.valueJson ?? null;
  },
});

export const deleteValue = internalMutation({
  args: {
    key: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("chatStateKv")
      .withIndex("by_kv_key", (query: any) => query.eq("kvKey", args.key))
      .unique();

    if (current !== null) {
      await ctx.db.delete(current._id);
    }
  },
});
