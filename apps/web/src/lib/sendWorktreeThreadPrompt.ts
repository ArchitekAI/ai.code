import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ProjectId,
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
  type ThreadId,
  type UploadChatAttachment,
  type WorktreeId,
} from "@repo/contracts";

import type { DraftThreadState } from "../composerDraftStore";
import { getAppSettingsSnapshot, getProviderStartOptionsFromAppSettings } from "../appSettings";
import { readNativeApi } from "../nativeApi";
import { inferProviderForModel } from "../providerModels";
import { truncateTitle } from "../truncateTitle";
import { newCommandId, newMessageId } from "./utils";

export async function sendWorktreeThreadPrompt(input: {
  targetThreadId: ThreadId;
  worktreeId: WorktreeId;
  projectId: ProjectId;
  projectModel: string;
  prompt: string;
  attachments?: UploadChatAttachment[];
  isServerThread: boolean;
  draftThread: DraftThreadState | null;
}) {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API is unavailable.");
  }

  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new Error("Prompt text is required.");
  }

  const now = new Date().toISOString();
  const runtimeMode: RuntimeMode = input.draftThread?.runtimeMode ?? "full-access";
  const interactionMode: ProviderInteractionMode =
    input.draftThread?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
  const providerOptions = getProviderStartOptionsFromAppSettings(getAppSettingsSnapshot());
  const inferredProvider: ProviderKind = inferProviderForModel({
    model: input.projectModel,
    sessionProviderName: null,
  });

  if (!input.isServerThread) {
    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId: input.targetThreadId,
      worktreeId: input.worktreeId,
      title: truncateTitle(prompt),
      model: input.projectModel,
      runtimeMode,
      interactionMode,
      createdAt: input.draftThread?.createdAt ?? now,
    });
  }

  await api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: input.targetThreadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: prompt,
      attachments: input.attachments ?? [],
    },
    ...(!input.isServerThread ? { provider: inferredProvider, model: input.projectModel } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    assistantDeliveryMode: "streaming",
    runtimeMode,
    interactionMode,
    createdAt: now,
  });
}
