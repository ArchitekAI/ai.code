import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type WorktreeId,
} from "@repo/contracts";

import type { DraftThreadState } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { truncateTitle } from "../truncateTitle";
import { newCommandId, newMessageId } from "./utils";

export async function sendWorktreeThreadPrompt(input: {
  targetThreadId: ThreadId;
  worktreeId: WorktreeId;
  projectId: ProjectId;
  projectModel: string;
  prompt: string;
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
      attachments: [],
    },
    assistantDeliveryMode: "streaming",
    runtimeMode,
    interactionMode,
    createdAt: now,
  });
}
