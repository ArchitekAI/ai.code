import { LinearWebhookHandlerError, LinearWebhookVerificationError } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface LinearWebhookHandlerShape {
  readonly handleWebhook: (input: {
    readonly rawBody: Uint8Array;
    readonly signature?: string | undefined;
    readonly timestamp?: string | undefined;
    readonly authorization?: string | undefined;
  }) => Effect.Effect<void, LinearWebhookVerificationError | LinearWebhookHandlerError>;
}

export class LinearWebhookHandler extends ServiceMap.Service<
  LinearWebhookHandler,
  LinearWebhookHandlerShape
>()("t3/linear/Services/LinearWebhookHandler") {}
