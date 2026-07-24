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
  ProviderKind,
  ServerProviderConnectionMethod,
  ServerProviderConnectionCancelInput,
  ServerProviderConnectionError,
  ServerProviderConnectionResult,
  ServerProviderConnectionStartInput,
  ServerProviderConnectionSubmitAuthorizationCodeInput,
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
  readonly submitAuthorizationCode: (
    input: ServerProviderConnectionSubmitAuthorizationCodeInput,
  ) => Effect.Effect<ServerProviderConnectionResult, ServerProviderConnectionError>;
  readonly startAfterInstallation: (input: {
    readonly provider: ProviderKind;
    readonly method: ServerProviderConnectionMethod;
    readonly installationOperationId: string;
  }) => Effect.Effect<void>;
}

export class ProviderConnection extends ServiceMap.Service<
  ProviderConnection,
  ProviderConnectionShape
>()("synara/provider/Services/ProviderConnection") {}
