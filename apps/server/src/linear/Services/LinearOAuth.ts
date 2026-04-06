import { LinearOAuthError, type LinearOAuthWorkspace } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ServerSettingsError } from "@t3tools/contracts";

export interface LinearOAuthAuthorizeResult {
  readonly url: string;
}

export interface LinearOAuthCallbackResult {
  readonly workspace: LinearOAuthWorkspace;
}

export interface LinearOAuthAccessTokenResult {
  readonly accessToken: string;
  readonly workspace: LinearOAuthWorkspace;
}

export interface LinearOAuthShape {
  readonly buildAuthorizationUrl: Effect.Effect<
    LinearOAuthAuthorizeResult,
    LinearOAuthError | ServerSettingsError
  >;
  readonly completeAuthorizationCodeFlow: (
    code: string,
  ) => Effect.Effect<LinearOAuthCallbackResult, LinearOAuthError | ServerSettingsError>;
  readonly getAccessToken: Effect.Effect<
    LinearOAuthAccessTokenResult | null,
    LinearOAuthError | ServerSettingsError
  >;
  readonly refreshWorkspaceToken: (
    workspace: LinearOAuthWorkspace,
  ) => Effect.Effect<LinearOAuthWorkspace, LinearOAuthError | ServerSettingsError>;
}

export class LinearOAuth extends ServiceMap.Service<LinearOAuth, LinearOAuthShape>()(
  "t3/linear/Services/LinearOAuth",
) {}
