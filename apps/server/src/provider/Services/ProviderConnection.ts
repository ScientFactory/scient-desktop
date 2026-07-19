/**
 * ProviderConnection - supervises explicit provider sign-in operations.
 *
 * Credentials remain owned by the provider CLI. This service only launches
 * allowlisted commands and publishes safe, transient progress through
 * ProviderHealth.
 *
 * @module ProviderConnection
 */
import type {
  ServerProviderConnectionCancelInput,
  ServerProviderConnectionError,
  ServerProviderConnectionResult,
  ServerProviderConnectionStartInput,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ProviderConnectionShape {
  readonly start: (
    input: ServerProviderConnectionStartInput,
  ) => Effect.Effect<ServerProviderConnectionResult, ServerProviderConnectionError>;
  readonly cancel: (
    input: ServerProviderConnectionCancelInput,
  ) => Effect.Effect<ServerProviderConnectionResult, ServerProviderConnectionError>;
}

export class ProviderConnection extends ServiceMap.Service<
  ProviderConnection,
  ProviderConnectionShape
>()("synara/provider/Services/ProviderConnection") {}
