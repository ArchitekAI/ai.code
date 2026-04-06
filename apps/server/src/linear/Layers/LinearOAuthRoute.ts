import { LinearOAuthError } from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { LinearOAuth } from "../Services/LinearOAuth.ts";

const CALLBACK_SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Linear Connected</title>
  </head>
  <body style="font-family: system-ui; padding: 40px; text-align: center;">
    <h2>Linear authorized successfully</h2>
    <p>You can close this window and return to T3 Code.</p>
  </body>
</html>`;

const callbackRouteLayer = HttpRouter.add(
  "GET",
  "/callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const linearOAuth = yield* LinearOAuth;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const error = url.value.searchParams.get("error");
    if (error) {
      return HttpServerResponse.text(`Linear authorization failed: ${error}`, { status: 400 });
    }

    const code = url.value.searchParams.get("code")?.trim();
    if (!code) {
      return HttpServerResponse.text("Missing Linear authorization code.", { status: 400 });
    }

    const result = yield* linearOAuth.completeAuthorizationCodeFlow(code).pipe(
      Effect.catch((cause) => {
        const message = Schema.is(LinearOAuthError)(cause)
          ? cause.message
          : "Linear authorization failed.";
        return Effect.succeed(HttpServerResponse.text(message, { status: 500 }));
      }),
    );

    if ("status" in result) {
      return result;
    }

    return HttpServerResponse.text(CALLBACK_SUCCESS_HTML, {
      status: 200,
      contentType: "text/html; charset=utf-8",
    });
  }),
);

const authorizeRouteLayer = HttpRouter.add(
  "GET",
  "/oauth/authorize",
  Effect.gen(function* () {
    const linearOAuth = yield* LinearOAuth;
    return yield* linearOAuth.buildAuthorizationUrl.pipe(
      Effect.map((result) => HttpServerResponse.redirect(result.url, { status: 302 })),
      Effect.catch((cause) => {
        const message = Schema.is(LinearOAuthError)(cause)
          ? cause.message
          : "Linear OAuth is unavailable.";
        return Effect.succeed(HttpServerResponse.text(message, { status: 503 }));
      }),
    );
  }),
);

export const linearOAuthRouteLayer = Layer.mergeAll(authorizeRouteLayer, callbackRouteLayer);
