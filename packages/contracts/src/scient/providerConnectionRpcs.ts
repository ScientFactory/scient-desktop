import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  ProviderConnectionCancelInput,
  ProviderConnectionDisconnectInput,
  ProviderConnectionError,
  ProviderConnectionStartInput,
  ProviderConnectionSubmitAuthorizationCodeInput,
  ProviderRuntimeCancelInput,
  ProviderRuntimePlan,
  ProviderRuntimePlanInput,
  ProviderRuntimeStartInput,
} from "../providerLifecycle.ts";
import { ServerProviderUpdatedPayload } from "../server.ts";

/** Spread into rpc.ts WS_METHODS where these methods have always been listed. */
export const SCIENT_PROVIDER_CONNECTION_WS_METHODS = {
  serverStartProviderConnection: "server.startProviderConnection",
  serverCancelProviderConnection: "server.cancelProviderConnection",
  serverSubmitProviderAuthorizationCode: "server.submitProviderAuthorizationCode",
  serverDisconnectProvider: "server.disconnectProvider",
  serverPlanProviderRuntime: "server.planProviderRuntime",
  serverStartProviderRuntime: "server.startProviderRuntime",
  serverCancelProviderRuntime: "server.cancelProviderRuntime",
} as const;

export const WsServerStartProviderConnectionRpc = Rpc.make(
  SCIENT_PROVIDER_CONNECTION_WS_METHODS.serverStartProviderConnection,
  {
    payload: ProviderConnectionStartInput,
    success: ServerProviderUpdatedPayload,
    error: Schema.Union([ProviderConnectionError, EnvironmentAuthorizationError]),
  },
);

export const WsServerCancelProviderConnectionRpc = Rpc.make(
  SCIENT_PROVIDER_CONNECTION_WS_METHODS.serverCancelProviderConnection,
  {
    payload: ProviderConnectionCancelInput,
    success: ServerProviderUpdatedPayload,
    error: Schema.Union([ProviderConnectionError, EnvironmentAuthorizationError]),
  },
);

export const WsServerSubmitProviderAuthorizationCodeRpc = Rpc.make(
  SCIENT_PROVIDER_CONNECTION_WS_METHODS.serverSubmitProviderAuthorizationCode,
  {
    payload: ProviderConnectionSubmitAuthorizationCodeInput,
    success: ServerProviderUpdatedPayload,
    error: Schema.Union([ProviderConnectionError, EnvironmentAuthorizationError]),
  },
);

export const WsServerDisconnectProviderRpc = Rpc.make(
  SCIENT_PROVIDER_CONNECTION_WS_METHODS.serverDisconnectProvider,
  {
    payload: ProviderConnectionDisconnectInput,
    success: ServerProviderUpdatedPayload,
    error: Schema.Union([ProviderConnectionError, EnvironmentAuthorizationError]),
  },
);

export const WsServerPlanProviderRuntimeRpc = Rpc.make(
  SCIENT_PROVIDER_CONNECTION_WS_METHODS.serverPlanProviderRuntime,
  {
    payload: ProviderRuntimePlanInput,
    success: ProviderRuntimePlan,
    error: Schema.Union([ProviderConnectionError, EnvironmentAuthorizationError]),
  },
);

export const WsServerStartProviderRuntimeRpc = Rpc.make(
  SCIENT_PROVIDER_CONNECTION_WS_METHODS.serverStartProviderRuntime,
  {
    payload: ProviderRuntimeStartInput,
    success: ServerProviderUpdatedPayload,
    error: Schema.Union([ProviderConnectionError, EnvironmentAuthorizationError]),
  },
);

export const WsServerCancelProviderRuntimeRpc = Rpc.make(
  SCIENT_PROVIDER_CONNECTION_WS_METHODS.serverCancelProviderRuntime,
  {
    payload: ProviderRuntimeCancelInput,
    success: ServerProviderUpdatedPayload,
    error: Schema.Union([ProviderConnectionError, EnvironmentAuthorizationError]),
  },
);
