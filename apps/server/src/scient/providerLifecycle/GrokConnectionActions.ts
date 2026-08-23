import {
  type GrokSettings,
  type ProviderConnectionMethod,
  type ProviderAuthorizationUrlKind,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import type {
  ProviderConnectionActions,
  ProviderConnectionActionFailure,
} from "../../provider/ProviderDriver.ts";
import {
  GROK_AUTH_METHOD_ACCOUNT,
  GROK_AUTH_METHOD_CACHED_TOKEN,
  GROK_AUTH_EXTENSION_METHOD,
  GROK_AUTH_METHOD_OIDC,
  GROK_DEVICE_FLOW_ENV,
  makeGrokAcpRuntime,
} from "../../provider/acp/GrokAcpSupport.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";

const GROK_ACCOUNT_METHOD = "grok_account";
const GROK_DEVICE_METHOD = "grok_device_code";
const SESSION_START_TIMEOUT = "30 seconds";
const URL_DISCOVERY_TIMEOUT = "30 seconds";
const AUTH_COMPLETION_TIMEOUT = "10 minutes";
const AUTH_CODE_SUBMISSION_TIMEOUT = "30 seconds";
const ACCOUNT_VERIFY_TIMEOUT = "20 seconds";
const LOGOUT_TIMEOUT = "30 seconds";
const CANCEL_REQUEST_TIMEOUT = "5 seconds";

const GrokAuthorizationResponse = Schema.Struct({
  auth_url: Schema.String,
  external_provider: Schema.optional(Schema.Boolean),
  mode: Schema.Literals(["loopback", "device", "command"]),
});
const decodeGrokAuthorizationResponse = Schema.decodeUnknownEffect(GrokAuthorizationResponse);

const GrokLogoutResponse = Schema.Struct({
  ok: Schema.Boolean,
  was_logged_in: Schema.optional(Schema.Boolean),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  api_key_still_set: Schema.optional(Schema.Boolean),
});
const decodeGrokLogoutResponse = Schema.decodeUnknownEffect(GrokLogoutResponse);

interface GrokAcpConnection {
  readonly initialize: () => Effect.Effect<
    EffectAcpSchema.InitializeResponse,
    ProviderConnectionActionFailure
  >;
  readonly authenticate: (
    payload: EffectAcpSchema.AuthenticateRequest,
  ) => Effect.Effect<EffectAcpSchema.AuthenticateResponse, ProviderConnectionActionFailure>;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, ProviderConnectionActionFailure>;
}

export interface GrokConnectionRuntime {
  readonly open: (
    deviceFlow: boolean,
  ) => Effect.Effect<GrokAcpConnection, ProviderConnectionActionFailure, Scope.Scope>;
}

const actionError = (message: string, cause?: unknown): ProviderConnectionActionError =>
  new ProviderConnectionActionError({ message, cause });

function mapFailure<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  message: string,
): Effect.Effect<A, ProviderConnectionActionFailure, R> {
  return effect.pipe(Effect.mapError((cause) => actionError(message, cause)));
}

function authMethodIds(initialized: EffectAcpSchema.InitializeResponse): ReadonlySet<string> {
  return new Set(initialized.authMethods?.map((method) => method.id) ?? []);
}

function chooseInteractiveAuthMethod(
  initialized: EffectAcpSchema.InitializeResponse,
  method: ProviderConnectionMethod,
): string | undefined {
  const available = authMethodIds(initialized);
  if (method === GROK_DEVICE_METHOD) {
    return available.has(GROK_AUTH_METHOD_ACCOUNT) ? GROK_AUTH_METHOD_ACCOUNT : undefined;
  }
  return available.has(GROK_AUTH_METHOD_ACCOUNT)
    ? GROK_AUTH_METHOD_ACCOUNT
    : available.has(GROK_AUTH_METHOD_OIDC)
      ? GROK_AUTH_METHOD_OIDC
      : undefined;
}

function safeAuthorizationUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const connectionHasAccount = Effect.fn("GrokConnectionActions.hasAccount")(function* (
  runtime: GrokConnectionRuntime,
  failureMessage: string,
) {
  return yield* Effect.gen(function* () {
    const acp = yield* runtime.open(false);
    const initialized = yield* acp.initialize();
    return authMethodIds(initialized).has(GROK_AUTH_METHOD_CACHED_TOKEN);
  }).pipe(
    Effect.timeout(ACCOUNT_VERIFY_TIMEOUT),
    Effect.mapError((cause) => actionError(failureMessage, cause)),
  );
});

/**
 * Orchestrates only Grok's official ACP auth extensions. Credentials remain in
 * Grok's own store and no token-bearing extension is ever called.
 */
export const makeGrokConnectionActionsFromRuntime = Effect.fn(
  "GrokConnectionActions.makeFromRuntime",
)(function* (runtime: GrokConnectionRuntime): Effect.fn.Return<ProviderConnectionActions, never> {
  const requestSequence = yield* Ref.make(0);

  const start: ProviderConnectionActions["start"] = (method) =>
    Effect.gen(function* () {
      if (method !== GROK_ACCOUNT_METHOD && method !== GROK_DEVICE_METHOD) {
        return yield* actionError("The selected Grok sign-in method is not supported.");
      }
      const deviceFlow = method === GROK_DEVICE_METHOD;
      const scope = yield* Scope.Scope;
      const acp = yield* mapFailure(
        runtime.open(deviceFlow).pipe(Effect.timeout(SESSION_START_TIMEOUT)),
        "Grok could not start its secure sign-in flow.",
      );
      const initialized = yield* mapFailure(
        acp.initialize().pipe(Effect.timeout(SESSION_START_TIMEOUT)),
        "Grok did not start its secure sign-in flow.",
      );
      const authMethodId = chooseInteractiveAuthMethod(initialized, method);
      if (!authMethodId) {
        return yield* actionError(
          deviceFlow
            ? "This Grok installation does not offer device-code sign in."
            : "This Grok installation does not offer account sign in.",
        );
      }
      const requestSeq = yield* Ref.updateAndGet(requestSequence, (value) => value + 1);
      const authenticateFiber = yield* acp
        .authenticate({
          methodId: authMethodId,
          _meta: {
            headless: false,
            force_interactive: true,
            // Grok's use_oauth flag forces loopback and overrides the
            // GROK_LOGIN_DEVICE_FLOW environment setting.
            use_oauth: !deviceFlow,
            request_seq: requestSeq,
          },
        })
        .pipe(Effect.forkIn(scope));
      const cancelAuthentication = acp
        .request(GROK_AUTH_EXTENSION_METHOD.cancel, { request_seq: requestSeq })
        .pipe(
          Effect.timeout(CANCEL_REQUEST_TIMEOUT),
          Effect.ignore,
          Effect.andThen(
            Fiber.interrupt(authenticateFiber).pipe(
              Effect.timeout(CANCEL_REQUEST_TIMEOUT),
              Effect.ignore,
            ),
          ),
          Effect.asVoid,
        );

      const discovery = yield* Effect.raceFirst(
        acp.request(GROK_AUTH_EXTENSION_METHOD.getUrl, {}).pipe(
          Effect.flatMap(decodeGrokAuthorizationResponse),
          Effect.retry(Schedule.spaced("100 millis")),
          Effect.map((authorization) => ({ _tag: "Authorization", authorization }) as const),
        ),
        Fiber.join(authenticateFiber).pipe(Effect.as({ _tag: "Authenticated" } as const)),
      ).pipe(
        Effect.timeout(URL_DISCOVERY_TIMEOUT),
        Effect.mapError((cause) =>
          actionError("Grok did not provide a secure sign-in page.", cause),
        ),
        Effect.onError(() => cancelAuthentication),
      );
      if (discovery._tag === "Authenticated") {
        const connected = yield* connectionHasAccount(
          runtime,
          "Grok finished sign in, but Scient could not verify the connected account.",
        );
        if (!connected) {
          return yield* actionError("Grok finished sign in without reporting a connected account.");
        }
        return {
          initialStatus: "verifying",
          waitForCompletion: Effect.void,
          cancel: Effect.void,
        };
      }

      const authorization = discovery.authorization;
      const authorizationUrl = safeAuthorizationUrl(authorization.auth_url);
      if (!authorizationUrl) {
        yield* cancelAuthentication;
        return yield* actionError("Grok returned an invalid or insecure sign-in page.");
      }

      // Grok's official loopback and device-code implementations launch the
      // system browser themselves. Scient retains the URL only as an explicit
      // fallback so one sign-in request never opens duplicate browser tabs.
      const authorizationUrlKind: ProviderAuthorizationUrlKind = "manual_fallback";
      const submitAuthorizationCode =
        authorization.mode === "loopback"
          ? (code: string) =>
              mapFailure(
                acp
                  .request(GROK_AUTH_EXTENSION_METHOD.submitCode, { code: code.trim() })
                  .pipe(Effect.timeout(AUTH_CODE_SUBMISSION_TIMEOUT), Effect.asVoid),
                "Grok did not accept the authorization code.",
              )
          : undefined;
      const userCode =
        authorization.mode === "device"
          ? (authorizationUrl.searchParams.get("user_code")?.trim() ?? undefined)
          : undefined;

      return {
        authorizationUrl: authorizationUrl.toString(),
        authorizationUrlKind,
        initialStatus:
          authorization.mode === "device" ? "waiting_for_device_code" : "waiting_for_browser",
        ...(userCode ? { userCode } : {}),
        ...(submitAuthorizationCode ? { submitAuthorizationCode } : {}),
        waitForCompletion: mapFailure(
          Fiber.join(authenticateFiber).pipe(
            Effect.timeout(AUTH_COMPLETION_TIMEOUT),
            Effect.onError(() => cancelAuthentication),
          ),
          "Grok sign in did not finish successfully.",
        ).pipe(
          Effect.flatMap(() =>
            connectionHasAccount(
              runtime,
              "Grok signed in, but Scient could not verify the connected account.",
            ).pipe(Effect.provideService(Scope.Scope, scope)),
          ),
          Effect.flatMap((connected) =>
            connected
              ? Effect.void
              : Effect.fail(actionError("Grok did not report a connected account after sign in.")),
          ),
        ),
        cancel: cancelAuthentication,
      };
    });

  const disconnect = Effect.gen(function* () {
    const acp = yield* mapFailure(
      runtime.open(false).pipe(Effect.timeout(SESSION_START_TIMEOUT)),
      "Grok did not start its sign-out flow.",
    );
    yield* mapFailure(
      acp.initialize().pipe(Effect.timeout(SESSION_START_TIMEOUT)),
      "Grok did not start its sign-out flow.",
    );
    const logout = yield* mapFailure(
      acp
        .request(GROK_AUTH_EXTENSION_METHOD.logout, {})
        .pipe(Effect.timeout(LOGOUT_TIMEOUT), Effect.flatMap(decodeGrokLogoutResponse)),
      "Grok could not sign out of the connected account.",
    );
    if (!logout.ok) {
      return yield* actionError("Grok did not confirm that the account was signed out.");
    }
    const stillConnected = yield* connectionHasAccount(
      runtime,
      "Grok signed out, but Scient could not verify it.",
    );
    if (stillConnected) {
      return yield* actionError("Grok still reports a connected account.");
    }
  });

  return {
    methods: [GROK_ACCOUNT_METHOD, GROK_DEVICE_METHOD],
    start,
    disconnect,
  };
});

export const makeGrokConnectionActions = Effect.fn("GrokConnectionActions.make")(function* (
  settings: GrokSettings,
  environment: NodeJS.ProcessEnv,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.fn.Return<ProviderConnectionActions, never, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto;
  const runtime: GrokConnectionRuntime = {
    open: (deviceFlow) =>
      makeGrokAcpRuntime({
        grokSettings: settings,
        environment: {
          ...environment,
          [GROK_DEVICE_FLOW_ENV]: deviceFlow ? "true" : "false",
        },
        childProcessSpawner: spawner,
        cwd: process.cwd(),
        clientInfo: { name: "scient-provider-connection", version: "0.0.0" },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError((cause) => actionError("Grok could not start its local agent.", cause)),
        Effect.map(
          (acp): GrokAcpConnection => ({
            initialize: () =>
              mapFailure(acp.initialize(), "Grok could not initialize its local agent."),
            authenticate: (payload) =>
              mapFailure(
                acp.authenticate(payload),
                "Grok could not start its secure sign-in flow.",
              ),
            request: (method, payload) =>
              mapFailure(acp.request(method, payload), "Grok did not complete the account action."),
          }),
        ),
      ),
  };
  return yield* makeGrokConnectionActionsFromRuntime(runtime);
});

export function withGrokSessionShutdown<E>(
  actions: ProviderConnectionActions,
  stopAll: Effect.Effect<void, E>,
): ProviderConnectionActions {
  return {
    ...actions,
    disconnect: stopAll.pipe(
      Effect.mapError((cause) =>
        actionError("Scient could not stop active Grok sessions before signing out.", cause),
      ),
      Effect.andThen(actions.disconnect),
    ),
  };
}
