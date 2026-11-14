/**
 * Scient Connect on the desktop's own computer. Lending a sign-in links this computer, so only the
 * desktop app's own session may; any session allowed to manage Scient Connect may turn it off.
 */
import {
  AuthRelayWriteScope,
  EnvironmentAuthorizationError,
  type ScientConnectHostSaveError,
  type ScientConnectHostStatus,
  WS_METHODS,
  WsServerManagementRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";
import { ScientConnectHost } from "./ScientConnectHost.ts";

const UNMANAGED: ScientConnectHostStatus = {
  managed: false,
  off: false,
  phase: "idle",
  linkedAccountId: null,
  authorizationRequest: 0,
};

/** Servers composed without the host service (tests, older layers) answer "not managed here". */
const withHost = <A, E>(
  use: (host: ScientConnectHost["Service"]) => Effect.Effect<A, E>,
  fallback: A,
): Effect.Effect<A, E> =>
  Effect.serviceOption(ScientConnectHost).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.succeed(fallback), onSome: use })),
  );

export const makeScientConnectRpcHandlers = ({
  observeRpcEffect,
  observeRpcStream,
  sessionSubject,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream"> & {
  /** Who authenticated this WebSocket connection. */
  readonly sessionSubject: string;
}) =>
  ({
    [WS_METHODS.scientConnectStatus]: (_input) =>
      observeRpcStream(
        WS_METHODS.scientConnectStatus,
        Stream.unwrap(
          Effect.serviceOption(ScientConnectHost).pipe(
            Effect.map(
              Option.match({
                onNone: () => Stream.make(UNMANAGED),
                onSome: (host) => host.status,
              }),
            ),
          ),
        ),
        { "rpc.aggregate": "cloud" },
      ),
    [WS_METHODS.scientConnectAuthorize]: (input) =>
      observeRpcEffect(
        WS_METHODS.scientConnectAuthorize,
        sessionSubject === "desktop-bootstrap"
          ? withHost<
              ScientConnectHostStatus,
              ScientConnectHostSaveError | EnvironmentAuthorizationError
            >((host) => host.authorize(input), UNMANAGED)
          : Effect.fail<ScientConnectHostSaveError | EnvironmentAuthorizationError>(
              new EnvironmentAuthorizationError({
                message: "Only the Scient app on this computer can turn on Scient Connect here.",
                requiredScope: AuthRelayWriteScope,
              }),
            ),
        { "rpc.aggregate": "cloud" },
      ),
    [WS_METHODS.scientConnectTurnOff]: (input) =>
      observeRpcEffect(
        WS_METHODS.scientConnectTurnOff,
        withHost((host) => host.turnOff(input), UNMANAGED),
        { "rpc.aggregate": "cloud" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsServerManagementRpcGroup,
    | typeof WS_METHODS.scientConnectStatus
    | typeof WS_METHODS.scientConnectAuthorize
    | typeof WS_METHODS.scientConnectTurnOff
  >;
