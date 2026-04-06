import { LinearClient as SdkLinearClient } from "@linear/sdk";
import {
  DEFAULT_LINEAR_OAUTH_SCOPES,
  LinearOAuthError,
  type LinearOAuthWorkspace,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  LinearOAuth,
  type LinearOAuthAccessTokenResult,
  type LinearOAuthCallbackResult,
  type LinearOAuthShape,
} from "../Services/LinearOAuth.ts";

const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const ACCESS_TOKEN_PREFIX = "lin_oauth_";
const DEFAULT_TOKEN_TYPE = "Bearer";
const REFRESH_EARLY_WINDOW_MS = 60_000;

function normalizeScopes(scopes: ReadonlyArray<string>): ReadonlyArray<string> {
  const normalized = scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0);
  return normalized.length > 0 ? normalized : [...DEFAULT_LINEAR_OAUTH_SCOPES];
}

function buildCallbackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/callback`;
}

function parseExpiresAt(input: string): number | null {
  if (!input.trim()) {
    return null;
  }
  const millis = Date.parse(input);
  return Number.isFinite(millis) ? millis : null;
}

function shouldRefreshWorkspace(workspace: LinearOAuthWorkspace): boolean {
  if (!workspace.refreshToken.trim()) {
    return false;
  }
  const expiresAt = parseExpiresAt(workspace.expiresAt);
  if (expiresAt === null) {
    return false;
  }
  return expiresAt <= Date.now() + REFRESH_EARLY_WINDOW_MS;
}

const makeLinearOAuth = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;

  const loadOauthSettings = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linear.oauth),
  );

  const requireOauthConfig = loadOauthSettings.pipe(
    Effect.flatMap((oauth) => {
      const clientId = oauth.clientId.trim();
      const clientSecret = oauth.clientSecret.trim();
      const baseUrl = oauth.baseUrl.trim();
      if (!clientId || !clientSecret || !baseUrl) {
        return Effect.fail(
          new LinearOAuthError({
            detail:
              "Linear OAuth is not configured. Set the client id, client secret, and base URL.",
          }),
        );
      }
      return Effect.succeed({
        clientId,
        clientSecret,
        baseUrl,
        scopes: normalizeScopes(oauth.scopes),
        workspace: oauth.workspace,
      });
    }),
  );

  const exchangeAuthorizationCode = (input: {
    readonly code: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(LINEAR_OAUTH_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            code: input.code,
            redirect_uri: input.redirectUri,
            client_id: input.clientId,
            client_secret: input.clientSecret,
            grant_type: "authorization_code",
          }).toString(),
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return (await response.json()) as {
          access_token: string;
          refresh_token?: string;
          token_type?: string;
          scope?: string;
          expires_in?: number;
        };
      },
      catch: (cause) =>
        new LinearOAuthError({
          detail: "Linear OAuth token exchange failed.",
          cause,
        }),
    });

  const refreshAccessToken = (input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(LINEAR_OAUTH_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: input.clientId,
            client_secret: input.clientSecret,
            refresh_token: input.refreshToken,
          }).toString(),
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return (await response.json()) as {
          access_token: string;
          refresh_token: string;
          token_type?: string;
          scope?: string;
          expires_in?: number;
        };
      },
      catch: (cause) =>
        new LinearOAuthError({
          detail: "Linear OAuth token refresh failed.",
          cause,
        }),
    });

  const fetchWorkspace = (accessToken: string) =>
    Effect.tryPromise({
      try: async () => {
        const client = new SdkLinearClient({ apiKey: accessToken });
        const viewer = await client.viewer;
        const organization = await viewer.organization;
        if (!organization) {
          throw new Error("Missing Linear workspace info.");
        }
        return {
          id: organization.id,
          name: organization.name ?? "",
          slug: organization.urlKey ?? "",
        };
      },
      catch: (cause) =>
        new LinearOAuthError({
          detail: "Failed to fetch Linear workspace information.",
          cause,
        }),
    });

  const persistWorkspace = (workspace: LinearOAuthWorkspace) =>
    serverSettings.updateSettings({
      linear: {
        enabled: true,
        oauth: {
          workspace,
        },
      },
    });

  const buildWorkspaceRecord = (input: {
    readonly currentWorkspace: LinearOAuthWorkspace | null;
    readonly workspaceId: string;
    readonly workspaceName: string;
    readonly workspaceSlug: string;
    readonly accessToken: string;
    readonly refreshToken: string | undefined;
    readonly tokenType: string | undefined;
    readonly scope: string | undefined;
    readonly expiresIn: number | undefined;
  }): LinearOAuthWorkspace => {
    const now = new Date().toISOString();
    const sameWorkspace = input.currentWorkspace?.id === input.workspaceId;
    return {
      id: input.workspaceId,
      name: input.workspaceName,
      slug: input.workspaceSlug,
      accessToken: input.accessToken,
      refreshToken:
        input.refreshToken ??
        (sameWorkspace ? input.currentWorkspace?.refreshToken : undefined) ??
        "",
      tokenType:
        input.tokenType?.trim() ||
        (sameWorkspace ? input.currentWorkspace?.tokenType : undefined) ||
        DEFAULT_TOKEN_TYPE,
      scope:
        input.scope?.trim() || (sameWorkspace ? input.currentWorkspace?.scope : undefined) || "",
      expiresAt:
        typeof input.expiresIn === "number"
          ? new Date(Date.now() + input.expiresIn * 1000).toISOString()
          : ((sameWorkspace ? input.currentWorkspace?.expiresAt : undefined) ?? ""),
      // Keep the original install timestamp so re-auth and refreshes do not erase history.
      installedAt: sameWorkspace ? (input.currentWorkspace?.installedAt ?? now) : now,
      updatedAt: now,
    };
  };

  const buildAuthorizationUrl: LinearOAuthShape["buildAuthorizationUrl"] = requireOauthConfig.pipe(
    Effect.map((oauth) => ({
      url: `${LINEAR_OAUTH_AUTHORIZE_URL}?${new URLSearchParams({
        client_id: oauth.clientId,
        redirect_uri: buildCallbackUrl(oauth.baseUrl),
        response_type: "code",
        scope: oauth.scopes.join(","),
        actor: "app",
      }).toString()}`,
    })),
  );

  const completeAuthorizationCodeFlow: LinearOAuthShape["completeAuthorizationCodeFlow"] = (code) =>
    requireOauthConfig.pipe(
      Effect.flatMap((oauth) =>
        exchangeAuthorizationCode({
          code,
          clientId: oauth.clientId,
          clientSecret: oauth.clientSecret,
          redirectUri: buildCallbackUrl(oauth.baseUrl),
        }).pipe(
          Effect.flatMap((tokens) => {
            if (!tokens.access_token?.startsWith(ACCESS_TOKEN_PREFIX)) {
              return Effect.fail(
                new LinearOAuthError({
                  detail: "Linear OAuth returned an invalid access token.",
                }),
              );
            }
            return fetchWorkspace(tokens.access_token).pipe(
              Effect.flatMap(
                (workspaceInfo): Effect.Effect<LinearOAuthCallbackResult, LinearOAuthError> => {
                  const workspace = buildWorkspaceRecord({
                    currentWorkspace: oauth.workspace,
                    workspaceId: workspaceInfo.id,
                    workspaceName: workspaceInfo.name,
                    workspaceSlug: workspaceInfo.slug,
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    tokenType: tokens.token_type,
                    scope: tokens.scope,
                    expiresIn: tokens.expires_in,
                  });
                  return persistWorkspace(workspace).pipe(
                    Effect.map(() => ({ workspace })),
                    Effect.mapError(
                      (cause) =>
                        new LinearOAuthError({
                          detail: "Failed to persist Linear OAuth workspace credentials.",
                          cause,
                        }),
                    ),
                  );
                },
              ),
            );
          }),
        ),
      ),
    );

  const refreshWorkspaceToken: LinearOAuthShape["refreshWorkspaceToken"] = (workspace) =>
    requireOauthConfig.pipe(
      Effect.flatMap((oauth): Effect.Effect<LinearOAuthWorkspace, LinearOAuthError> => {
        const refreshToken = workspace.refreshToken.trim();
        if (!refreshToken) {
          return Effect.fail(
            new LinearOAuthError({
              detail: "Linear OAuth workspace does not have a refresh token.",
            }),
          );
        }
        return refreshAccessToken({
          clientId: oauth.clientId,
          clientSecret: oauth.clientSecret,
          refreshToken,
        }).pipe(
          Effect.flatMap((tokens) => {
            if (!tokens.access_token?.startsWith(ACCESS_TOKEN_PREFIX)) {
              return Effect.fail(
                new LinearOAuthError({
                  detail: "Linear OAuth returned an invalid refreshed access token.",
                }),
              );
            }
            const nextWorkspace = buildWorkspaceRecord({
              currentWorkspace: workspace,
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              workspaceSlug: workspace.slug,
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              tokenType: tokens.token_type,
              scope: tokens.scope,
              expiresIn: tokens.expires_in,
            });
            return persistWorkspace(nextWorkspace).pipe(
              Effect.map(() => nextWorkspace),
              Effect.mapError(
                (cause) =>
                  new LinearOAuthError({
                    detail: "Failed to persist refreshed Linear OAuth credentials.",
                    cause,
                  }),
              ),
            );
          }),
        );
      }),
    );

  const getAccessToken: LinearOAuthShape["getAccessToken"] = requireOauthConfig.pipe(
    Effect.flatMap((oauth) => {
      const workspace = oauth.workspace;
      if (!workspace) {
        return Effect.succeed<LinearOAuthAccessTokenResult | null>(null);
      }

      if (!workspace.accessToken.trim()) {
        return Effect.fail(
          new LinearOAuthError({
            detail: "Linear OAuth workspace is missing an access token.",
          }),
        );
      }

      if (!shouldRefreshWorkspace(workspace)) {
        return Effect.succeed({
          accessToken: workspace.accessToken,
          workspace,
        });
      }

      // Mirror Cyrus's refresh-on-use behavior so a long-running server can keep working
      // without requiring operators to re-run the install flow when tokens expire.
      return refreshWorkspaceToken(workspace).pipe(
        Effect.map((refreshedWorkspace) => ({
          accessToken: refreshedWorkspace.accessToken,
          workspace: refreshedWorkspace,
        })),
      );
    }),
  );

  return {
    buildAuthorizationUrl,
    completeAuthorizationCodeFlow,
    getAccessToken,
    refreshWorkspaceToken,
  } satisfies LinearOAuthShape;
});

export const LinearOAuthLive = Layer.effect(LinearOAuth, makeLinearOAuth);
