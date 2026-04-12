import { describe, expect, it } from "vitest";

import { chatStateSubscriptionKey, chatStateValueKey, createLocalChatStateAdapter } from "./state.ts";

describe("local chat state adapter", () => {
  it("tracks locks, subscriptions, queues, and kv values", async () => {
    const state = createLocalChatStateAdapter();

    const lock = await state.acquireLock("thread-1", 1_000);
    expect(lock).not.toBeNull();
    expect(await state.acquireLock("thread-1", 1_000)).toBeNull();
    expect(await state.extendLock(lock!, 1_000)).toBe(true);
    expect(await state.releaseLock(lock!)).toBeUndefined();
    expect(await state.acquireLock("thread-1", 1_000)).not.toBeNull();

    await state.subscribe("thread-1");
    expect(await state.isSubscribed("thread-1")).toBe(true);
    await state.unsubscribe("thread-1");
    expect(await state.isSubscribed("thread-1")).toBe(false);

    const kvKey = chatStateValueKey("thread-1", "summary");
    expect(await state.setIfNotExists(kvKey, { summary: "ready" })).toBe(true);
    expect(await state.setIfNotExists(kvKey, { summary: "later" })).toBe(false);
    expect(await state.get<{ summary: string }>(kvKey)).toEqual({ summary: "ready" });
    await state.delete(kvKey);
    expect(await state.get(kvKey)).toBeNull();

    await state.appendToList("thread-1:events", "first");
    await state.appendToList("thread-1:events", "second", { maxLength: 1 });
    expect(await state.getList<string>("thread-1:events")).toEqual(["second"]);

    const depth = await state.enqueue(
      "thread-1",
      {
        enqueuedAt: Date.now(),
        expiresAt: Date.now() + 1_000,
        message: { id: "msg-1" } as never,
      },
      5,
    );
    expect(depth).toBe(1);
    expect(await state.queueDepth("thread-1")).toBe(1);
    expect(await state.dequeue("thread-1")).not.toBeNull();

    expect(chatStateSubscriptionKey("thread-1", "bot-a")).toBe("thread-1:bot-a");
  });
});
