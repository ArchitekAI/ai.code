import {
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  ProjectId,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  ThreadId,
  WorktreeId,
  type CodexReasoningEffort,
  type ProviderKind,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@repo/contracts";
import { normalizeModelSlug } from "@repo/shared/model";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type ChatImageAttachment } from "./types";
import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";
export type DraftThreadEnvMode = "local" | "worktree";

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

interface DebouncedStorage extends StateStorage {
  flush: () => void;
}

export function createDebouncedStorage(baseStorage: StateStorage): DebouncedStorage {
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      baseStorage.setItem(name, value);
    },
    { wait: COMPOSER_PERSIST_DEBOUNCE_MS },
  );

  return {
    getItem: (name) => baseStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      baseStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}

const composerDebouncedStorage: DebouncedStorage =
  typeof localStorage !== "undefined"
    ? createDebouncedStorage(localStorage)
    : { getItem: () => null, setItem: () => {}, removeItem: () => {}, flush: () => {} };

// Flush pending composer draft writes before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

export interface PersistedComposerImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

interface PersistedComposerThreadDraftState {
  prompt: string;
  attachments: PersistedComposerImageAttachment[];
  provider?: ProviderKind | null;
  model?: string | null;
  runtimeMode?: RuntimeMode | null;
  interactionMode?: ProviderInteractionMode | null;
  effort?: CodexReasoningEffort | null;
  codexFastMode?: boolean | null;
  serviceTier?: string | null;
}

interface PersistedDraftThreadState {
  projectId: ProjectId;
  worktreeId: WorktreeId | null;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
}

interface PersistedComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, PersistedComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, PersistedDraftThreadState>;
  projectDraftThreadIdByProjectId: Record<ProjectId, ThreadId>;
  worktreeDraftThreadIdByWorktreeId: Record<WorktreeId, ThreadId>;
}

interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  provider: ProviderKind | null;
  model: string | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
  effort: CodexReasoningEffort | null;
  codexFastMode: boolean;
}

export interface DraftThreadState {
  projectId: ProjectId;
  worktreeId: WorktreeId | null;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
}

interface ProjectDraftThread extends DraftThreadState {
  threadId: ThreadId;
}

interface WorktreeDraftThread extends DraftThreadState {
  threadId: ThreadId;
}

interface ComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  projectDraftThreadIdByProjectId: Record<ProjectId, ThreadId>;
  worktreeDraftThreadIdByWorktreeId: Record<WorktreeId, ThreadId>;
  getDraftThreadByProjectId: (projectId: ProjectId) => ProjectDraftThread | null;
  getDraftThreadByWorktreeId: (worktreeId: WorktreeId) => WorktreeDraftThread | null;
  getDraftThread: (threadId: ThreadId) => DraftThreadState | null;
  setProjectDraftThreadId: (
    projectId: ProjectId,
    threadId: ThreadId,
    options?: {
      worktreeId?: WorktreeId | null;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  setWorktreeDraftThreadId: (
    worktreeId: WorktreeId,
    threadId: ThreadId,
    options: {
      projectId: ProjectId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    options: {
      worktreeId?: WorktreeId | null;
      branch?: string | null;
      worktreePath?: string | null;
      projectId?: ProjectId;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  clearWorktreeDraftThreadId: (worktreeId: WorktreeId) => void;
  clearWorktreeDraftThreadById: (worktreeId: WorktreeId, threadId: ThreadId) => void;
  clearDraftThread: (threadId: ThreadId) => void;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  setProvider: (threadId: ThreadId, provider: ProviderKind | null | undefined) => void;
  setModel: (threadId: ThreadId, model: string | null | undefined) => void;
  setRuntimeMode: (threadId: ThreadId, runtimeMode: RuntimeMode | null | undefined) => void;
  setInteractionMode: (
    threadId: ThreadId,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  setEffort: (threadId: ThreadId, effort: CodexReasoningEffort | null | undefined) => void;
  setCodexFastMode: (threadId: ThreadId, enabled: boolean | null | undefined) => void;
  addImage: (threadId: ThreadId, image: ComposerImageAttachment) => void;
  addImages: (threadId: ThreadId, images: ComposerImageAttachment[]) => void;
  removeImage: (threadId: ThreadId, imageId: string) => void;
  clearPersistedAttachments: (threadId: ThreadId) => void;
  syncPersistedAttachments: (
    threadId: ThreadId,
    attachments: PersistedComposerImageAttachment[],
  ) => void;
  clearComposerContent: (threadId: ThreadId) => void;
  clearThreadDraft: (threadId: ThreadId) => void;
}

const EMPTY_PERSISTED_DRAFT_STORE_STATE: PersistedComposerDraftStoreState = {
  draftsByThreadId: {},
  draftThreadsByThreadId: {},
  projectDraftThreadIdByProjectId: {},
  worktreeDraftThreadIdByWorktreeId: {},
};

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
const EMPTY_THREAD_DRAFT = Object.freeze({
  prompt: "",
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  provider: null,
  model: null,
  runtimeMode: null,
  interactionMode: null,
  effort: null,
  codexFastMode: false,
}) as ComposerThreadDraftState;

const REASONING_EFFORT_VALUES = new Set<CodexReasoningEffort>(
  REASONING_EFFORT_OPTIONS_BY_PROVIDER.codex,
);

function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    provider: null,
    model: null,
    runtimeMode: null,
    interactionMode: null,
    effort: null,
    codexFastMode: false,
  };
}

function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.provider === null &&
    draft.model === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null &&
    draft.effort === null &&
    draft.codexFastMode === false
  );
}

function mappingContainsThreadId<T extends string>(
  mapping: Record<T, ThreadId>,
  threadId: ThreadId,
): boolean {
  return Object.values(mapping).includes(threadId);
}

function removeThreadIdFromMappings<T extends string>(
  mapping: Record<T, ThreadId>,
  threadId: ThreadId,
): Record<T, ThreadId> {
  return Object.fromEntries(
    Object.entries(mapping).filter(([, draftThreadId]) => draftThreadId !== threadId),
  ) as Record<T, ThreadId>;
}

function removeDraftThreadStateIfUnmapped(input: {
  readonly threadId: ThreadId;
  readonly draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  readonly draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  readonly projectDraftThreadIdByProjectId: Record<ProjectId, ThreadId>;
  readonly worktreeDraftThreadIdByWorktreeId: Record<WorktreeId, ThreadId>;
}): {
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
} {
  const isStillMapped =
    mappingContainsThreadId(input.projectDraftThreadIdByProjectId, input.threadId) ||
    mappingContainsThreadId(input.worktreeDraftThreadIdByWorktreeId, input.threadId);
  if (isStillMapped) {
    return {
      draftsByThreadId: input.draftsByThreadId,
      draftThreadsByThreadId: input.draftThreadsByThreadId,
    };
  }

  const nextDraftThreadsByThreadId = { ...input.draftThreadsByThreadId };
  delete nextDraftThreadsByThreadId[input.threadId];

  if (input.draftsByThreadId[input.threadId] === undefined) {
    return {
      draftsByThreadId: input.draftsByThreadId,
      draftThreadsByThreadId: nextDraftThreadsByThreadId,
    };
  }

  const nextDraftsByThreadId = { ...input.draftsByThreadId };
  delete nextDraftsByThreadId[input.threadId];
  return {
    draftsByThreadId: nextDraftsByThreadId,
    draftThreadsByThreadId: nextDraftThreadsByThreadId,
  };
}

function normalizeProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" ? value : null;
}

function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

function normalizePersistedAttachment(value: unknown): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
  };
}

function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

function normalizePersistedComposerDraftState(value: unknown): PersistedComposerDraftStoreState {
  if (!value || typeof value !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const candidate = value as Record<string, unknown>;
  const rawDraftMap = candidate.draftsByThreadId;
  const rawDraftThreadsByThreadId = candidate.draftThreadsByThreadId;
  const rawProjectDraftThreadIdByProjectId = candidate.projectDraftThreadIdByProjectId;
  const rawWorktreeDraftThreadIdByWorktreeId = candidate.worktreeDraftThreadIdByWorktreeId;
  const draftThreadsByThreadId: PersistedComposerDraftStoreState["draftThreadsByThreadId"] = {};
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        continue;
      }
      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const projectId = candidateDraftThread.projectId;
      const worktreeId = candidateDraftThread.worktreeId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      if (typeof projectId !== "string" || projectId.length === 0) {
        continue;
      }
      draftThreadsByThreadId[threadId as ThreadId] = {
        projectId: projectId as ProjectId,
        worktreeId:
          typeof worktreeId === "string" && worktreeId.length > 0
            ? (worktreeId as WorktreeId)
            : null,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode:
          candidateDraftThread.runtimeMode === "approval-required" ||
          candidateDraftThread.runtimeMode === "full-access"
            ? candidateDraftThread.runtimeMode
            : DEFAULT_RUNTIME_MODE,
        interactionMode:
          candidateDraftThread.interactionMode === "plan" ||
          candidateDraftThread.interactionMode === "default"
            ? candidateDraftThread.interactionMode
            : DEFAULT_INTERACTION_MODE,
        branch: typeof branch === "string" ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
      };
    }
  }
  const projectDraftThreadIdByProjectId: PersistedComposerDraftStoreState["projectDraftThreadIdByProjectId"] =
    {};
  if (
    rawProjectDraftThreadIdByProjectId &&
    typeof rawProjectDraftThreadIdByProjectId === "object"
  ) {
    for (const [projectId, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectId as Record<string, unknown>,
    )) {
      if (
        typeof projectId === "string" &&
        projectId.length > 0 &&
        typeof threadId === "string" &&
        threadId.length > 0
      ) {
        projectDraftThreadIdByProjectId[projectId as ProjectId] = threadId as ThreadId;
        if (!draftThreadsByThreadId[threadId as ThreadId]) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            projectId: projectId as ProjectId,
            worktreeId: null,
            createdAt: new Date().toISOString(),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            envMode: "local",
          };
        } else if (draftThreadsByThreadId[threadId as ThreadId]?.projectId !== projectId) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            ...draftThreadsByThreadId[threadId as ThreadId]!,
            projectId: projectId as ProjectId,
          };
        }
      }
    }
  }
  const worktreeDraftThreadIdByWorktreeId: PersistedComposerDraftStoreState["worktreeDraftThreadIdByWorktreeId"] =
    {};
  if (
    rawWorktreeDraftThreadIdByWorktreeId &&
    typeof rawWorktreeDraftThreadIdByWorktreeId === "object"
  ) {
    for (const [worktreeId, threadId] of Object.entries(
      rawWorktreeDraftThreadIdByWorktreeId as Record<string, unknown>,
    )) {
      if (
        typeof worktreeId !== "string" ||
        worktreeId.length === 0 ||
        typeof threadId !== "string" ||
        threadId.length === 0
      ) {
        continue;
      }
      const existingDraftThread = draftThreadsByThreadId[threadId as ThreadId];
      if (!existingDraftThread) {
        continue;
      }
      worktreeDraftThreadIdByWorktreeId[worktreeId as WorktreeId] = threadId as ThreadId;
      if (existingDraftThread.worktreeId !== worktreeId) {
        draftThreadsByThreadId[threadId as ThreadId] = {
          ...existingDraftThread,
          worktreeId: worktreeId as WorktreeId,
        };
      }
    }
  }
  for (const [threadId, draftThread] of Object.entries(draftThreadsByThreadId)) {
    if (!draftThread.worktreeId) {
      continue;
    }
    if (worktreeDraftThreadIdByWorktreeId[draftThread.worktreeId] !== undefined) {
      continue;
    }
    worktreeDraftThreadIdByWorktreeId[draftThread.worktreeId] = threadId as ThreadId;
  }
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {
      draftsByThreadId: {},
      draftThreadsByThreadId,
      projectDraftThreadIdByProjectId,
      worktreeDraftThreadIdByWorktreeId,
    };
  }
  const nextDraftsByThreadId: PersistedComposerDraftStoreState["draftsByThreadId"] = {};
  for (const [threadId, draftValue] of Object.entries(rawDraftMap as Record<string, unknown>)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as Record<string, unknown>;
    const prompt = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const provider = normalizeProviderKind(draftCandidate.provider);
    const model =
      typeof draftCandidate.model === "string"
        ? normalizeModelSlug(draftCandidate.model, provider ?? "codex")
        : null;
    const runtimeMode =
      draftCandidate.runtimeMode === "approval-required" ||
      draftCandidate.runtimeMode === "full-access"
        ? draftCandidate.runtimeMode
        : null;
    const interactionMode =
      draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
        ? draftCandidate.interactionMode
        : null;
    const effortCandidate =
      typeof draftCandidate.effort === "string" ? draftCandidate.effort : null;
    const effort =
      effortCandidate && REASONING_EFFORT_VALUES.has(effortCandidate as CodexReasoningEffort)
        ? (effortCandidate as CodexReasoningEffort)
        : null;
    const codexFastMode =
      draftCandidate.codexFastMode === true ||
      (typeof draftCandidate.serviceTier === "string" && draftCandidate.serviceTier === "fast");
    if (
      prompt.length === 0 &&
      attachments.length === 0 &&
      !provider &&
      !model &&
      !runtimeMode &&
      !interactionMode &&
      !effort &&
      !codexFastMode
    ) {
      continue;
    }
    nextDraftsByThreadId[threadId as ThreadId] = {
      prompt,
      attachments,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
      ...(effort ? { effort } : {}),
      ...(codexFastMode ? { codexFastMode } : {}),
    };
  }
  return {
    draftsByThreadId: nextDraftsByThreadId,
    draftThreadsByThreadId,
    projectDraftThreadIdByProjectId,
    worktreeDraftThreadIdByWorktreeId,
  };
}

function parsePersistedDraftStateRaw(raw: string | null): PersistedComposerDraftStoreState {
  if (!raw) {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "state" in parsed) {
      return normalizePersistedComposerDraftState((parsed as { state?: unknown }).state);
    }
    return normalizePersistedComposerDraftState(parsed);
  } catch {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
}

function readPersistedAttachmentIdsFromStorage(threadId: ThreadId): string[] {
  if (threadId.length === 0) {
    return [];
  }
  try {
    const raw = localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    const persisted = parsePersistedDraftStateRaw(raw);
    return (persisted.draftsByThreadId[threadId]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

function hydreatePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

function hydrateImagesFromPersisted(
  attachments: PersistedComposerImageAttachment[],
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydreatePersistedComposerImageAttachment(attachment);
    if (!file) return [];

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
      } satisfies ComposerImageAttachment,
    ];
  });
}

function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  return {
    prompt: persistedDraft.prompt,
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    nonPersistedImageIds: [],
    persistedAttachments: persistedDraft.attachments,
    provider: persistedDraft.provider ?? null,
    model: persistedDraft.model ?? null,
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
    effort: persistedDraft.effort ?? null,
    codexFastMode: persistedDraft.codexFastMode === true,
  };
}

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get) => ({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      worktreeDraftThreadIdByWorktreeId: {},
      getDraftThreadByProjectId: (projectId) => {
        if (projectId.length === 0) {
          return null;
        }
        const threadId = get().projectDraftThreadIdByProjectId[projectId];
        if (!threadId) {
          return null;
        }
        const draftThread = get().draftThreadsByThreadId[threadId];
        if (!draftThread || draftThread.projectId !== projectId) {
          return null;
        }
        return {
          threadId,
          ...draftThread,
        };
      },
      getDraftThreadByWorktreeId: (worktreeId) => {
        if (worktreeId.length === 0) {
          return null;
        }
        const threadId = get().worktreeDraftThreadIdByWorktreeId[worktreeId];
        if (!threadId) {
          return null;
        }
        const draftThread = get().draftThreadsByThreadId[threadId];
        if (!draftThread || draftThread.worktreeId !== worktreeId) {
          return null;
        }
        return {
          threadId,
          ...draftThread,
        };
      },
      getDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return null;
        }
        return get().draftThreadsByThreadId[threadId] ?? null;
      },
      setProjectDraftThreadId: (projectId, threadId, options) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          const existingThread = state.draftThreadsByThreadId[threadId];
          const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[projectId];
          const nextWorktreePath =
            options?.worktreePath === undefined
              ? (existingThread?.worktreePath ?? null)
              : (options.worktreePath ?? null);
          const nextDraftThread: DraftThreadState = {
            projectId,
            worktreeId:
              options?.worktreeId === undefined
                ? (existingThread?.worktreeId ?? null)
                : (options.worktreeId ?? null),
            createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
            runtimeMode:
              options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode:
              options?.interactionMode ??
              existingThread?.interactionMode ??
              DEFAULT_INTERACTION_MODE,
            branch:
              options?.branch === undefined
                ? (existingThread?.branch ?? null)
                : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options?.envMode ??
              (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
          };
          const hasSameProjectMapping = previousThreadIdForProject === threadId;
          const hasSameDraftThread =
            existingThread &&
            existingThread.projectId === nextDraftThread.projectId &&
            existingThread.worktreeId === nextDraftThread.worktreeId &&
            existingThread.createdAt === nextDraftThread.createdAt &&
            existingThread.runtimeMode === nextDraftThread.runtimeMode &&
            existingThread.interactionMode === nextDraftThread.interactionMode &&
            existingThread.branch === nextDraftThread.branch &&
            existingThread.worktreePath === nextDraftThread.worktreePath &&
            existingThread.envMode === nextDraftThread.envMode;
          if (hasSameProjectMapping && hasSameDraftThread) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId: Record<ProjectId, ThreadId> = {
            ...state.projectDraftThreadIdByProjectId,
            [projectId]: threadId,
          };
          let nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (previousThreadIdForProject && previousThreadIdForProject !== threadId) {
            const cleaned = removeDraftThreadStateIfUnmapped({
              threadId: previousThreadIdForProject,
              draftsByThreadId: nextDraftsByThreadId,
              draftThreadsByThreadId: nextDraftThreadsByThreadId,
              projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
              worktreeDraftThreadIdByWorktreeId: state.worktreeDraftThreadIdByWorktreeId,
            });
            nextDraftsByThreadId = cleaned.draftsByThreadId;
            nextDraftThreadsByThreadId = cleaned.draftThreadsByThreadId;
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
            worktreeDraftThreadIdByWorktreeId: state.worktreeDraftThreadIdByWorktreeId,
          };
        });
      },
      setWorktreeDraftThreadId: (worktreeId, threadId, options) => {
        if (worktreeId.length === 0 || threadId.length === 0 || options.projectId.length === 0) {
          return;
        }
        set((state) => {
          const existingThread = state.draftThreadsByThreadId[threadId];
          const previousThreadIdForWorktree = state.worktreeDraftThreadIdByWorktreeId[worktreeId];
          const nextWorktreePath =
            options.worktreePath === undefined
              ? (existingThread?.worktreePath ?? null)
              : (options.worktreePath ?? null);
          const nextDraftThread: DraftThreadState = {
            projectId: options.projectId,
            worktreeId,
            createdAt: options.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
            runtimeMode: options.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode:
              options.interactionMode ??
              existingThread?.interactionMode ??
              DEFAULT_INTERACTION_MODE,
            branch:
              options.branch === undefined
                ? (existingThread?.branch ?? null)
                : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options.envMode ??
              (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "worktree")),
          };
          const hasSameWorktreeMapping = previousThreadIdForWorktree === threadId;
          const hasSameDraftThread =
            existingThread &&
            existingThread.projectId === nextDraftThread.projectId &&
            existingThread.worktreeId === nextDraftThread.worktreeId &&
            existingThread.createdAt === nextDraftThread.createdAt &&
            existingThread.runtimeMode === nextDraftThread.runtimeMode &&
            existingThread.interactionMode === nextDraftThread.interactionMode &&
            existingThread.branch === nextDraftThread.branch &&
            existingThread.worktreePath === nextDraftThread.worktreePath &&
            existingThread.envMode === nextDraftThread.envMode;
          if (hasSameWorktreeMapping && hasSameDraftThread) {
            return state;
          }

          const nextWorktreeDraftThreadIdByWorktreeId: Record<WorktreeId, ThreadId> = {
            ...state.worktreeDraftThreadIdByWorktreeId,
            [worktreeId]: threadId,
          };

          if (
            existingThread?.worktreeId &&
            existingThread.worktreeId !== worktreeId &&
            nextWorktreeDraftThreadIdByWorktreeId[existingThread.worktreeId] === threadId
          ) {
            delete nextWorktreeDraftThreadIdByWorktreeId[existingThread.worktreeId];
          }

          let nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (previousThreadIdForWorktree && previousThreadIdForWorktree !== threadId) {
            const cleaned = removeDraftThreadStateIfUnmapped({
              threadId: previousThreadIdForWorktree,
              draftsByThreadId: nextDraftsByThreadId,
              draftThreadsByThreadId: nextDraftThreadsByThreadId,
              projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
              worktreeDraftThreadIdByWorktreeId: nextWorktreeDraftThreadIdByWorktreeId,
            });
            nextDraftsByThreadId = cleaned.draftsByThreadId;
            nextDraftThreadsByThreadId = cleaned.draftThreadsByThreadId;
          }

          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
            worktreeDraftThreadIdByWorktreeId: nextWorktreeDraftThreadIdByWorktreeId,
          };
        });
      },
      setDraftThreadContext: (threadId, options) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadId[threadId];
          if (!existing) {
            return state;
          }
          const nextProjectId = options.projectId ?? existing.projectId;
          if (nextProjectId.length === 0) {
            return state;
          }
          const nextWorktreePath =
            options.worktreePath === undefined
              ? existing.worktreePath
              : (options.worktreePath ?? null);
          const nextDraftThread: DraftThreadState = {
            projectId: nextProjectId,
            worktreeId:
              options.worktreeId === undefined ? existing.worktreeId : (options.worktreeId ?? null),
            createdAt:
              options.createdAt === undefined
                ? existing.createdAt
                : options.createdAt || existing.createdAt,
            runtimeMode: options.runtimeMode ?? existing.runtimeMode,
            interactionMode: options.interactionMode ?? existing.interactionMode,
            branch: options.branch === undefined ? existing.branch : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
          };
          const isUnchanged =
            nextDraftThread.projectId === existing.projectId &&
            nextDraftThread.worktreeId === existing.worktreeId &&
            nextDraftThread.createdAt === existing.createdAt &&
            nextDraftThread.runtimeMode === existing.runtimeMode &&
            nextDraftThread.interactionMode === existing.interactionMode &&
            nextDraftThread.branch === existing.branch &&
            nextDraftThread.worktreePath === existing.worktreePath &&
            nextDraftThread.envMode === existing.envMode;
          if (isUnchanged) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId: Record<ProjectId, ThreadId> = {
            ...state.projectDraftThreadIdByProjectId,
            [nextProjectId]: threadId,
          };
          if (existing.projectId !== nextProjectId) {
            if (nextProjectDraftThreadIdByProjectId[existing.projectId] === threadId) {
              delete nextProjectDraftThreadIdByProjectId[existing.projectId];
            }
          }
          const nextWorktreeDraftThreadIdByWorktreeId: Record<WorktreeId, ThreadId> = {
            ...state.worktreeDraftThreadIdByWorktreeId,
          };
          if (
            existing.worktreeId &&
            nextWorktreeDraftThreadIdByWorktreeId[existing.worktreeId] === threadId &&
            existing.worktreeId !== nextDraftThread.worktreeId
          ) {
            delete nextWorktreeDraftThreadIdByWorktreeId[existing.worktreeId];
          }
          if (nextDraftThread.worktreeId) {
            nextWorktreeDraftThreadIdByWorktreeId[nextDraftThread.worktreeId] = threadId;
          }
          return {
            draftThreadsByThreadId: {
              ...state.draftThreadsByThreadId,
              [threadId]: nextDraftThread,
            },
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
            worktreeDraftThreadIdByWorktreeId: nextWorktreeDraftThreadIdByWorktreeId,
          };
        });
      },
      clearProjectDraftThreadId: (projectId) => {
        if (projectId.length === 0) {
          return;
        }
        set((state) => {
          const threadId = state.projectDraftThreadIdByProjectId[projectId];
          if (threadId === undefined) {
            return state;
          }
          const { [projectId]: _removed, ...restProjectMappingsRaw } =
            state.projectDraftThreadIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, ThreadId>;
          const cleaned = removeDraftThreadStateIfUnmapped({
            threadId,
            draftsByThreadId: state.draftsByThreadId,
            draftThreadsByThreadId: state.draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
            worktreeDraftThreadIdByWorktreeId: state.worktreeDraftThreadIdByWorktreeId,
          });
          return {
            draftsByThreadId: cleaned.draftsByThreadId,
            draftThreadsByThreadId: cleaned.draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
            worktreeDraftThreadIdByWorktreeId: state.worktreeDraftThreadIdByWorktreeId,
          };
        });
      },
      clearProjectDraftThreadById: (projectId, threadId) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          if (state.projectDraftThreadIdByProjectId[projectId] !== threadId) {
            return state;
          }
          const { [projectId]: _removed, ...restProjectMappingsRaw } =
            state.projectDraftThreadIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, ThreadId>;
          const cleaned = removeDraftThreadStateIfUnmapped({
            threadId,
            draftsByThreadId: state.draftsByThreadId,
            draftThreadsByThreadId: state.draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
            worktreeDraftThreadIdByWorktreeId: state.worktreeDraftThreadIdByWorktreeId,
          });
          return {
            draftsByThreadId: cleaned.draftsByThreadId,
            draftThreadsByThreadId: cleaned.draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
            worktreeDraftThreadIdByWorktreeId: state.worktreeDraftThreadIdByWorktreeId,
          };
        });
      },
      clearWorktreeDraftThreadId: (worktreeId) => {
        if (worktreeId.length === 0) {
          return;
        }
        set((state) => {
          const threadId = state.worktreeDraftThreadIdByWorktreeId[worktreeId];
          if (threadId === undefined) {
            return state;
          }
          const { [worktreeId]: _removed, ...restWorktreeMappingsRaw } =
            state.worktreeDraftThreadIdByWorktreeId;
          const restWorktreeMappings = restWorktreeMappingsRaw as Record<WorktreeId, ThreadId>;
          const cleaned = removeDraftThreadStateIfUnmapped({
            threadId,
            draftsByThreadId: state.draftsByThreadId,
            draftThreadsByThreadId: state.draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
            worktreeDraftThreadIdByWorktreeId: restWorktreeMappings,
          });
          return {
            draftsByThreadId: cleaned.draftsByThreadId,
            draftThreadsByThreadId: cleaned.draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
            worktreeDraftThreadIdByWorktreeId: restWorktreeMappings,
          };
        });
      },
      clearWorktreeDraftThreadById: (worktreeId, threadId) => {
        if (worktreeId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          if (state.worktreeDraftThreadIdByWorktreeId[worktreeId] !== threadId) {
            return state;
          }
          const { [worktreeId]: _removed, ...restWorktreeMappingsRaw } =
            state.worktreeDraftThreadIdByWorktreeId;
          const restWorktreeMappings = restWorktreeMappingsRaw as Record<WorktreeId, ThreadId>;
          const cleaned = removeDraftThreadStateIfUnmapped({
            threadId,
            draftsByThreadId: state.draftsByThreadId,
            draftThreadsByThreadId: state.draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
            worktreeDraftThreadIdByWorktreeId: restWorktreeMappings,
          });
          return {
            draftsByThreadId: cleaned.draftsByThreadId,
            draftThreadsByThreadId: cleaned.draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
            worktreeDraftThreadIdByWorktreeId: restWorktreeMappings,
          };
        });
      },
      clearDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
            threadId,
          );
          const hasWorktreeMapping = Object.values(
            state.worktreeDraftThreadIdByWorktreeId,
          ).includes(threadId);
          if (!hasDraftThread && !hasProjectMapping && !hasWorktreeMapping) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
            Object.entries(state.projectDraftThreadIdByProjectId).filter(
              ([, draftThreadId]) => draftThreadId !== threadId,
            ),
          ) as Record<ProjectId, ThreadId>;
          const nextWorktreeDraftThreadIdByWorktreeId = Object.fromEntries(
            Object.entries(state.worktreeDraftThreadIdByWorktreeId).filter(
              ([, draftThreadId]) => draftThreadId !== threadId,
            ),
          ) as Record<WorktreeId, ThreadId>;
          const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
            state.draftThreadsByThreadId;
          return {
            draftThreadsByThreadId: restDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
            worktreeDraftThreadIdByWorktreeId: nextWorktreeDraftThreadIdByWorktreeId,
          };
        });
      },
      setPrompt: (threadId, prompt) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setProvider: (threadId, provider) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedProvider = normalizeProviderKind(provider);
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && normalizedProvider === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.provider === normalizedProvider) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            provider: normalizedProvider,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setModel: (threadId, model) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedModel = normalizeModelSlug(model) ?? null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && normalizedModel === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.model === normalizedModel) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            model: normalizedModel,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setRuntimeMode: (threadId, runtimeMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextRuntimeMode =
          runtimeMode === "approval-required" || runtimeMode === "full-access" ? runtimeMode : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextRuntimeMode === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.runtimeMode === nextRuntimeMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            runtimeMode: nextRuntimeMode,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setInteractionMode: (threadId, interactionMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextInteractionMode =
          interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextInteractionMode === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.interactionMode === nextInteractionMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            interactionMode: nextInteractionMode,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setEffort: (threadId, effort) => {
        if (threadId.length === 0) {
          return;
        }
        const nextEffort =
          effort &&
          REASONING_EFFORT_VALUES.has(effort) &&
          effort !== DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex
            ? effort
            : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextEffort === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.effort === nextEffort) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            effort: nextEffort,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setCodexFastMode: (threadId, enabled) => {
        if (threadId.length === 0) {
          return;
        }
        const nextCodexFastMode = enabled === true;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextCodexFastMode === false) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.codexFastMode === nextCodexFastMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            codexFastMode: nextCodexFastMode,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      addImage: (threadId, image) => {
        if (threadId.length === 0) {
          return;
        }
        get().addImages(threadId, [image]);
      },
      addImages: (threadId, images) => {
        if (threadId.length === 0 || images.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const existingIds = new Set(existing.images.map((image) => image.id));
          const existingDedupKeys = new Set(
            existing.images.map((image) => composerImageDedupKey(image)),
          );
          const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
          const dedupedIncoming: ComposerImageAttachment[] = [];
          for (const image of images) {
            const dedupKey = composerImageDedupKey(image);
            if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
              // Avoid revoking a blob URL that's still referenced by an accepted image.
              if (!acceptedPreviewUrls.has(image.previewUrl)) {
                revokeObjectPreviewUrl(image.previewUrl);
              }
              continue;
            }
            dedupedIncoming.push(image);
            existingIds.add(image.id);
            existingDedupKeys.add(dedupKey);
            acceptedPreviewUrls.add(image.previewUrl);
          }
          if (dedupedIncoming.length === 0) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                images: [...existing.images, ...dedupedIncoming],
              },
            },
          };
        });
      },
      removeImage: (threadId, imageId) => {
        if (threadId.length === 0) {
          return;
        }
        const existing = get().draftsByThreadId[threadId];
        if (!existing) {
          return;
        }
        const removedImage = existing.images.find((image) => image.id === imageId);
        if (removedImage) {
          revokeObjectPreviewUrl(removedImage.previewUrl);
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            images: current.images.filter((image) => image.id !== imageId),
            nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
            persistedAttachments: current.persistedAttachments.filter(
              (attachment) => attachment.id !== imageId,
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearPersistedAttachments: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            persistedAttachments: [],
            nonPersistedImageIds: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      syncPersistedAttachments: (threadId, attachments) => {
        if (threadId.length === 0) {
          return;
        }
        const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            // Stage attempted attachments so persist middleware can try writing them.
            persistedAttachments: attachments,
            nonPersistedImageIds: current.nonPersistedImageIds.filter(
              (id) => !attachmentIdSet.has(id),
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
        Promise.resolve().then(() => {
          const persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadId));
          set((state) => {
            const current = state.draftsByThreadId[threadId];
            if (!current) {
              return state;
            }
            const imageIdSet = new Set(current.images.map((image) => image.id));
            const persistedAttachments = attachments.filter(
              (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
            );
            const nonPersistedImageIds = current.images
              .map((image) => image.id)
              .filter((imageId) => !persistedIdSet.has(imageId));
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              persistedAttachments,
              nonPersistedImageIds,
            };
            const nextDraftsByThreadId = { ...state.draftsByThreadId };
            if (shouldRemoveDraft(nextDraft)) {
              delete nextDraftsByThreadId[threadId];
            } else {
              nextDraftsByThreadId[threadId] = nextDraft;
            }
            return { draftsByThreadId: nextDraftsByThreadId };
          });
        });
      },
      clearComposerContent: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: "",
            images: [],
            nonPersistedImageIds: [],
            persistedAttachments: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearThreadDraft: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        const existing = get().draftsByThreadId[threadId];
        if (existing) {
          for (const image of existing.images) {
            revokeObjectPreviewUrl(image.previewUrl);
          }
        }
        set((state) => {
          const hasComposerDraft = state.draftsByThreadId[threadId] !== undefined;
          const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
            threadId,
          );
          const hasWorktreeMapping = Object.values(
            state.worktreeDraftThreadIdByWorktreeId,
          ).includes(threadId);
          if (!hasComposerDraft && !hasDraftThread && !hasProjectMapping && !hasWorktreeMapping) {
            return state;
          }
          const { [threadId]: _removedComposerDraft, ...restComposerDraftsByThreadId } =
            state.draftsByThreadId;
          const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
            state.draftThreadsByThreadId;
          const nextProjectDraftThreadIdByProjectId = removeThreadIdFromMappings(
            state.projectDraftThreadIdByProjectId,
            threadId,
          );
          const nextWorktreeDraftThreadIdByWorktreeId = removeThreadIdFromMappings(
            state.worktreeDraftThreadIdByWorktreeId,
            threadId,
          );
          return {
            draftsByThreadId: restComposerDraftsByThreadId,
            draftThreadsByThreadId: restDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
            worktreeDraftThreadIdByWorktreeId: nextWorktreeDraftThreadIdByWorktreeId,
          };
        });
      },
    }),
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => composerDebouncedStorage),
      partialize: (state) => {
        const persistedDraftsByThreadId: PersistedComposerDraftStoreState["draftsByThreadId"] = {};
        for (const [threadId, draft] of Object.entries(state.draftsByThreadId)) {
          if (typeof threadId !== "string" || threadId.length === 0) {
            continue;
          }
          if (
            draft.prompt.length === 0 &&
            draft.persistedAttachments.length === 0 &&
            draft.provider === null &&
            draft.model === null &&
            draft.runtimeMode === null &&
            draft.interactionMode === null &&
            draft.effort === null &&
            draft.codexFastMode === false
          ) {
            continue;
          }
          const persistedDraft: PersistedComposerThreadDraftState = {
            prompt: draft.prompt,
            attachments: draft.persistedAttachments,
          };
          if (draft.model) {
            persistedDraft.model = draft.model;
          }
          if (draft.provider) {
            persistedDraft.provider = draft.provider;
          }
          if (draft.runtimeMode) {
            persistedDraft.runtimeMode = draft.runtimeMode;
          }
          if (draft.interactionMode) {
            persistedDraft.interactionMode = draft.interactionMode;
          }
          if (draft.effort) {
            persistedDraft.effort = draft.effort;
          }
          if (draft.codexFastMode) {
            persistedDraft.codexFastMode = true;
          }
          persistedDraftsByThreadId[threadId as ThreadId] = persistedDraft;
        }
        return {
          draftsByThreadId: persistedDraftsByThreadId,
          draftThreadsByThreadId: state.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
          worktreeDraftThreadIdByWorktreeId: state.worktreeDraftThreadIdByWorktreeId,
        };
      },
      merge: (persistedState, currentState) => {
        const normalizedPersisted = normalizePersistedComposerDraftState(persistedState);
        const draftsByThreadId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadId).map(([threadId, draft]) => [
            threadId,
            toHydratedThreadDraft(draft),
          ]),
        );
        return {
          ...currentState,
          draftsByThreadId,
          draftThreadsByThreadId: normalizedPersisted.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: normalizedPersisted.projectDraftThreadIdByProjectId,
          worktreeDraftThreadIdByWorktreeId: normalizedPersisted.worktreeDraftThreadIdByWorktreeId,
        };
      },
    },
  ),
);

export function useComposerThreadDraft(threadId: ThreadId): ComposerThreadDraftState {
  return useComposerDraftStore((state) => state.draftsByThreadId[threadId] ?? EMPTY_THREAD_DRAFT);
}

/**
 * Clear draft threads that have been promoted to server threads.
 *
 * Call this after a snapshot sync so the route guard in `_chat.$threadId`
 * sees the server thread before the draft is removed — avoids a redirect
 * to `/` caused by a gap where neither draft nor server thread exists.
 */
export function clearPromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  const draftThreadIds = Object.keys(store.draftThreadsByThreadId) as ThreadId[];
  for (const draftId of draftThreadIds) {
    if (serverThreadIds.has(draftId)) {
      store.clearDraftThread(draftId);
    }
  }
}
