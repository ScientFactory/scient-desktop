// FILE: providerSignOutTransport.ts
// Purpose: Add provider sign-out RPC authority without rewriting released migration contracts.
// Layer: Shared desktop/web runtime overlay

import {
  type NativeApi,
  ProviderKind,
  ServerProviderConnectionError,
  ServerProviderConnectionResult,
} from "@synara/contracts";
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import type { LiveHtmlNativeApi } from "./liveHtmlPreviewTransport";

export const PROVIDER_SIGN_OUT_METHOD = "scient.provider.signOut.v1";

export const ProviderSignOutInput = Schema.Struct({
  provider: ProviderKind,
});
export type ProviderSignOutInput = typeof ProviderSignOutInput.Type;

export const ProviderSignOutRpc = Rpc.make(PROVIDER_SIGN_OUT_METHOD, {
  payload: ProviderSignOutInput,
  success: ServerProviderConnectionResult,
  error: ServerProviderConnectionError,
});

export const ProviderSignOutRpcGroup = RpcGroup.make(ProviderSignOutRpc);

export type ProviderSignOutNativeApi = Omit<LiveHtmlNativeApi, "server"> & {
  server: LiveHtmlNativeApi["server"] & {
    signOutProvider: (input: ProviderSignOutInput) => Promise<ServerProviderConnectionResult>;
  };
};

export function asProviderSignOutNativeApi(api: NativeApi): ProviderSignOutNativeApi {
  return api as ProviderSignOutNativeApi;
}
