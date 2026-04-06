import { LINEAR_WEBHOOK_SIGNATURE_HEADER, LINEAR_WEBHOOK_TS_HEADER } from "@linear/sdk/webhooks";
import { LinearWebhookHandlerError, LinearWebhookVerificationError } from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../../serverSettings.ts";
import { LinearWebhookHandler } from "../Services/LinearWebhookHandler.ts";

const getHeader = (headers: Record<string, string | undefined>, name: string) =>
  headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];

const makeLinearWebhookRoute = (path: "/webhook" | "/webhook/linear") =>
  HttpRouter.add(
    "POST",
    path,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const serverSettings = yield* ServerSettingsService;
      const linearWebhookHandler = yield* LinearWebhookHandler;

      const settings = yield* serverSettings.getSettings;
      if (!settings.linear.enabled) {
        return HttpServerResponse.text("Linear integration is disabled.", { status: 503 });
      }

      const rawBody = new Uint8Array(yield* request.arrayBuffer);
      const headers = request.headers as Record<string, string | undefined>;

      return yield* linearWebhookHandler
        .handleWebhook({
          rawBody,
          signature: getHeader(headers, LINEAR_WEBHOOK_SIGNATURE_HEADER),
          timestamp: getHeader(headers, LINEAR_WEBHOOK_TS_HEADER),
          authorization: getHeader(headers, "authorization"),
        })
        .pipe(
          Effect.as(HttpServerResponse.empty({ status: 200 })),
          Effect.catch((error) => {
            if (Schema.is(LinearWebhookVerificationError)(error)) {
              return Effect.succeed(HttpServerResponse.text(error.message, { status: 401 }));
            }
            const message = Schema.is(LinearWebhookHandlerError)(error)
              ? error.message
              : "Linear webhook handling failed.";
            return Effect.succeed(HttpServerResponse.text(message, { status: 500 }));
          }),
        );
    }),
  ).pipe(Layer.provide(HttpRouter.cors({ allowedMethods: ["POST", "OPTIONS"] })));

export const linearWebhookRouteLayer = Layer.mergeAll(
  makeLinearWebhookRoute("/webhook/linear"),
  // Cyrus self-hosting docs register Linear against /webhook, so we accept both paths.
  makeLinearWebhookRoute("/webhook"),
);
