import type { Lock, QueueEntry, StateAdapter } from "chat";

export interface ChatStateLock {
  readonly key: string;
  readonly ownerKey: string;
  readonly expiresAt: number;
}

export interface ChatStateSubscription {
  readonly threadKey: string;
  readonly subscriberKey: string;
}

export interface ChatStateValue {
  readonly key: string;
  readonly valueJson: string;
}

interface LocalStateSnapshot {
  readonly locks: Map<string, ChatStateLock>;
  readonly subscriptions: Map<string, Set<string>>;
  readonly values: Map<string, unknown>;
  readonly lists: Map<string, unknown[]>;
  readonly queues: Map<string, QueueEntry[]>;
}

const DEFAULT_LOCK_TTL_MS = 30_000;

function subscriptionKey(input: ChatStateSubscription) {
  return `${input.threadKey}:${input.subscriberKey}`;
}

function lockToSdkLock(lock: ChatStateLock): Lock {
  return {
    threadId: lock.key,
    token: lock.ownerKey,
    expiresAt: lock.expiresAt,
  };
}

export function chatStateLockKey(threadKey: string) {
  return `lock:${threadKey}`;
}

export function chatStateSubscriptionKey(threadKey: string, subscriberKey: string) {
  return subscriptionKey({ threadKey, subscriberKey });
}

export function chatStateValueKey(threadKey: string, name: string) {
  return `kv:${threadKey}:${name}`;
}

export function createLocalChatStateAdapter(snapshot?: Partial<LocalStateSnapshot>): StateAdapter {
  const state: LocalStateSnapshot = {
    locks: snapshot?.locks ?? new Map<string, ChatStateLock>(),
    subscriptions: snapshot?.subscriptions ?? new Map<string, Set<string>>(),
    values: snapshot?.values ?? new Map<string, unknown>(),
    lists: snapshot?.lists ?? new Map<string, unknown[]>(),
    queues: snapshot?.queues ?? new Map<string, QueueEntry[]>(),
  };

  return {
    async acquireLock(threadId, ttlMs) {
      const now = Date.now();
      const current = state.locks.get(threadId);
      if (current !== undefined && current.expiresAt > now) {
        return null;
      }

      const next: ChatStateLock = {
        key: threadId,
        ownerKey: crypto.randomUUID(),
        expiresAt: now + ttlMs,
      };
      state.locks.set(threadId, next);
      return lockToSdkLock(next);
    },
    async appendToList(key, value, options) {
      const list = state.lists.get(key) ?? [];
      list.push(value);

      const maxLength = options?.maxLength;
      if (typeof maxLength === "number" && maxLength >= 0 && list.length > maxLength) {
        list.splice(0, list.length - maxLength);
      }

      state.lists.set(key, list);
    },
    async connect() {
      return;
    },
    async delete(key) {
      state.values.delete(key);
      state.lists.delete(key);
    },
    async dequeue(threadId) {
      const queue = state.queues.get(threadId);
      if (queue === undefined || queue.length === 0) {
        return null;
      }

      const now = Date.now();
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (next.expiresAt > now) {
          return next;
        }
      }

      return null;
    },
    async disconnect() {
      return;
    },
    async enqueue(threadId, entry, maxSize) {
      const queue = state.queues.get(threadId) ?? [];
      queue.push(entry);
      if (queue.length > maxSize) {
        queue.splice(0, queue.length - maxSize);
      }
      state.queues.set(threadId, queue);
      return queue.length;
    },
    async extendLock(lock, ttlMs) {
      const current = state.locks.get(lock.threadId);
      if (current === undefined || current.ownerKey !== lock.token) {
        return false;
      }

      state.locks.set(lock.threadId, {
        ...current,
        expiresAt: Date.now() + ttlMs,
      });
      return true;
    },
    async forceReleaseLock(threadId) {
      state.locks.delete(threadId);
    },
    async get<T = unknown>(key: string) {
      return (state.values.get(key) as T | undefined) ?? null;
    },
    async getList<T = unknown>(key: string) {
      return (state.lists.get(key) as T[] | undefined) ?? [];
    },
    async isSubscribed(threadId: string) {
      return (state.subscriptions.get(threadId)?.size ?? 0) > 0;
    },
    async queueDepth(threadId: string) {
      return state.queues.get(threadId)?.length ?? 0;
    },
    async releaseLock(lock) {
      const current = state.locks.get(lock.threadId);
      if (current !== undefined && current.ownerKey === lock.token) {
        state.locks.delete(lock.threadId);
      }
    },
    async set<T = unknown>(key: string, value: T) {
      state.values.set(key, value);
    },
    async setIfNotExists(key: string, value: unknown) {
      if (state.values.has(key)) {
        return false;
      }

      state.values.set(key, value);
      return true;
    },
    async subscribe(threadId: string) {
      const next = state.subscriptions.get(threadId) ?? new Set<string>();
      next.add(threadId);
      state.subscriptions.set(threadId, next);
    },
    async unsubscribe(threadId: string) {
      state.subscriptions.delete(threadId);
    },
  };
}
