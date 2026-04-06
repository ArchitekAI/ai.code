import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, vi } from "vitest";

import { ServerSettingsService } from "../../serverSettings.ts";
import { LinearOAuth } from "../Services/LinearOAuth.ts";
import { LinearOAuthLive } from "./LinearOAuth.ts";

const linearOauthLayer = (overrides?: Parameters<typeof ServerSettingsService.layerTest>[0]) => {
  const settingsLayer = ServerSettingsService.layerTest(overrides);
  return Layer.mergeAll(settingsLayer, LinearOAuthLive.pipe(Layer.provide(settingsLayer)));
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.effect("builds the Cyrus-style Linear authorization URL", () =>
  Effect.gen(function* () {
    const linearOAuth = yield* LinearOAuth;
    const result = yield* linearOAuth.buildAuthorizationUrl;

    expect(result.url).toContain("https://linear.app/oauth/authorize?");
    expect(result.url).toContain("client_id=linear-client-id");
    expect(result.url).toContain(
      encodeURIComponent("https://cyrus.example.com/callback").replace(/%20/g, "+"),
    );
    expect(result.url).toContain("response_type=code");
    expect(result.url).toContain("actor=app");
    expect(result.url).toContain("scope=write%2Capp%3Aassignable%2Capp%3Amentionable");
  }).pipe(
    Effect.provide(
      linearOauthLayer({
        linear: {
          enabled: true,
          oauth: {
            clientId: "linear-client-id",
            clientSecret: "linear-client-secret",
            baseUrl: "https://cyrus.example.com",
          },
        },
      }),
    ),
  ),
);

it.effect("completes the callback flow and persists the Linear workspace tokens", () =>
  Effect.gen(function* () {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://api.linear.app/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "lin_oauth_access_token",
            refresh_token: "lin_oauth_refresh_token",
            token_type: "Bearer",
            scope: "write,app:assignable,app:mentionable",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              organization: {
                id: "workspace-1",
                name: "Acme",
                urlKey: "acme",
              },
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const linearOAuth = yield* LinearOAuth;
    const serverSettings = yield* ServerSettingsService;

    const result = yield* linearOAuth.completeAuthorizationCodeFlow("test-auth-code");
    const settings = yield* serverSettings.getSettings;

    assert.equal(result.workspace.id, "workspace-1");
    assert.equal(settings.linear.enabled, true);
    assert.isNotNull(settings.linear.oauth.workspace);
    assert.equal(settings.linear.oauth.workspace?.id, "workspace-1");
    assert.equal(settings.linear.oauth.workspace?.accessToken, "lin_oauth_access_token");
    assert.equal(settings.linear.oauth.workspace?.refreshToken, "lin_oauth_refresh_token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }).pipe(
    Effect.provide(
      linearOauthLayer({
        linear: {
          enabled: true,
          oauth: {
            clientId: "linear-client-id",
            clientSecret: "linear-client-secret",
            baseUrl: "https://cyrus.example.com",
          },
        },
      }),
    ),
  ),
);
