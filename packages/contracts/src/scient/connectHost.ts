/**
 * Scient Connect on the desktop app's own computer: signing in turns it on. The computer's server
 * sets it up (download, link, tunnel) with a short-lived sign-in token its window lends; every
 * window reads one status. Hosts linked with `scient connect link` and other computers are not
 * managed here.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { RelayClientInstallProgressStageSchema } from "../relayClient.ts";

/** Why setup stopped and waits for the person, not for time. */
export const ScientConnectHostBlock = Schema.Union([
  /** The account already has its maximum number of computers. */
  Schema.Struct({ reason: Schema.Literal("limit"), maxTunnels: Schema.Number }),
  /** An administrator's policy turns Scient Connect off. */
  Schema.Struct({ reason: Schema.Literal("policy"), message: Schema.String }),
  /** This computer was removed from the account elsewhere; only Turn on links it again. */
  Schema.Struct({ reason: Schema.Literal("revoked") }),
  /** The tunnel program could not be installed here (unsupported, blocked or corrupted download). */
  Schema.Struct({ reason: Schema.Literal("install"), message: Schema.String }),
  /** Anything else that retrying would not fix. */
  Schema.Struct({ reason: Schema.Literal("failed"), message: Schema.String }),
]);
export type ScientConnectHostBlock = typeof ScientConnectHostBlock.Type;

export const ScientConnectHostStatus = Schema.Struct({
  /**
   * False where this server does not set itself up (not the desktop app's backend, a host the
   * command line manages, or no Scient Connect in this build); clients then keep T3's controls.
   */
  managed: Schema.Boolean,
  /** The person turned Scient Connect off on this computer. */
  off: Schema.Boolean,
  phase: Schema.Literals([
    /** Nothing to do yet (off, or settling at startup). */
    "idle",
    /** Waiting for a signed-in window to lend a token. */
    "needs-authorization",
    "installing",
    "linking",
    "waiting-to-retry",
    /** Linked with a tunnel; whether other devices reach it is the reachability check's answer. */
    "connected",
    "blocked",
  ]),
  /** The account this computer is linked to, if any. */
  linkedAccountId: Schema.NullOr(Schema.String),
  installStage: Schema.optionalKey(RelayClientInstallProgressStageSchema),
  block: Schema.optionalKey(ScientConnectHostBlock),
  /** The last failure being retried, for the person waiting. */
  retryReason: Schema.optionalKey(Schema.String),
  /** Raised each time the server wants a fresh token, so windows answer each request once. */
  authorizationRequest: Schema.Number,
});
export type ScientConnectHostStatus = typeof ScientConnectHostStatus.Type;

export const ScientConnectHostAuthorizeInput = Schema.Struct({
  /** The signed-in account the token belongs to. */
  accountId: Schema.String,
  /** A short-lived relay token for that account. Used once, never stored. */
  token: Schema.String,
  /** The person asked for it (Turn on, Try again): clears Off and any block. */
  turnOn: Schema.Boolean,
});
export type ScientConnectHostAuthorizeInput = typeof ScientConnectHostAuthorizeInput.Type;

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_CONNECT_HOST_WS_METHODS = {
  scientConnectStatus: "scientConnect.status",
  scientConnectAuthorize: "scientConnect.authorize",
  scientConnectTurnOff: "scientConnect.turnOff",
} as const;

export const WsScientConnectStatusRpc = Rpc.make(
  SCIENT_CONNECT_HOST_WS_METHODS.scientConnectStatus,
  {
    payload: Schema.Struct({}),
    success: ScientConnectHostStatus,
    stream: true,
    error: EnvironmentAuthorizationError,
  },
);

/** Resolves with the status once this attempt settles (connected, blocked or waiting). */
export const WsScientConnectAuthorizeRpc = Rpc.make(
  SCIENT_CONNECT_HOST_WS_METHODS.scientConnectAuthorize,
  {
    payload: ScientConnectHostAuthorizeInput,
    success: ScientConnectHostStatus,
    error: EnvironmentAuthorizationError,
  },
);

/** Remembers Off for this computer, stops any setup, and unlinks it here. */
export const WsScientConnectTurnOffRpc = Rpc.make(
  SCIENT_CONNECT_HOST_WS_METHODS.scientConnectTurnOff,
  {
    payload: Schema.Struct({}),
    success: ScientConnectHostStatus,
    error: EnvironmentAuthorizationError,
  },
);
