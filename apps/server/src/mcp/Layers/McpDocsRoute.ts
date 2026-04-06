import { randomUUID } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { createT3DocsServer } from "../t3Docs.ts";

const getHeader = (headers: Headers, name: string) =>
  headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase());

export const mcpDocsRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const transports = new Map<
      string,
      {
        readonly server: ReturnType<typeof createT3DocsServer>;
        readonly transport: WebStandardStreamableHTTPServerTransport;
      }
    >();

    return HttpRouter.add(
      "POST",
      "/mcp/t3-docs",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);

        if (serverConfig.authToken) {
          const authorization = getHeader(webRequest.headers, "authorization");
          if (authorization !== `Bearer ${serverConfig.authToken}`) {
            return HttpServerResponse.text("Unauthorized MCP request", { status: 401 });
          }
        }

        const requestBody = yield* Effect.tryPromise({
          try: () =>
            webRequest
              .clone()
              .json()
              .catch(() => undefined),
          catch: () => undefined,
        });

        const sessionId = getHeader(webRequest.headers, "mcp-session-id");
        let transportRecord = sessionId ? transports.get(sessionId) : undefined;
        if (!transportRecord) {
          if (sessionId || !isInitializeRequest(requestBody)) {
            return HttpServerResponse.text("Bad MCP session request", { status: 400 });
          }

          const server = createT3DocsServer(serverConfig.cwd);
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (initializedSessionId) => {
              transports.set(initializedSessionId, { server, transport });
            },
          });
          yield* Effect.tryPromise(() => server.connect(transport));
          transportRecord = { server, transport };
        }

        const response = yield* Effect.tryPromise(() =>
          transportRecord.transport.handleRequest(webRequest),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    ).pipe(
      Layer.provide(
        HttpRouter.cors({
          allowedMethods: ["POST", "OPTIONS"],
          allowedHeaders: ["authorization", "content-type", "mcp-session-id"],
          exposedHeaders: ["mcp-session-id", "mcp-protocol-version"],
        }),
      ),
    );
  }),
);
