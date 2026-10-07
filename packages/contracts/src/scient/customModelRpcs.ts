import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  CustomModelSaveInput,
  CustomModelRemoveInput,
  CustomModelTestInput,
  CustomModelsSettings,
  CustomModelError,
} from "../customModels.ts";

/** Spread into rpc.ts WS_METHODS where these methods have always been listed. */
export const SCIENT_CUSTOM_MODEL_WS_METHODS = {
  serverSaveCustomModel: "server.saveCustomModel",
  serverRemoveCustomModel: "server.removeCustomModel",
  serverTestCustomModel: "server.testCustomModel",
} as const;

export const WsServerSaveCustomModelRpc = Rpc.make(
  SCIENT_CUSTOM_MODEL_WS_METHODS.serverSaveCustomModel,
  {
    payload: CustomModelSaveInput,
    success: CustomModelsSettings,
    error: Schema.Union([CustomModelError, EnvironmentAuthorizationError]),
  },
);
export const WsServerRemoveCustomModelRpc = Rpc.make(
  SCIENT_CUSTOM_MODEL_WS_METHODS.serverRemoveCustomModel,
  {
    payload: CustomModelRemoveInput,
    success: CustomModelsSettings,
    error: Schema.Union([CustomModelError, EnvironmentAuthorizationError]),
  },
);

export const WsServerTestCustomModelRpc = Rpc.make(
  SCIENT_CUSTOM_MODEL_WS_METHODS.serverTestCustomModel,
  {
    payload: CustomModelTestInput,
    success: Schema.Struct({ revision: Schema.Int }),
    error: Schema.Union([CustomModelError, EnvironmentAuthorizationError]),
  },
);
