import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
// SCIENT-FORK:START account-switch
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
// SCIENT-FORK:END account-switch

import { connectionAtomRuntime } from "../connection/runtime";
import {
  checkCloudReachability,
  // SCIENT-FORK:START account-switch
  isCloudEnvironmentLinkError,
  // SCIENT-FORK:END account-switch
  linkEnvironmentToCloud,
  readCloudLinkState,
  type CloudLinkMode,
  type CloudLinkTarget,
  unlinkEnvironmentFromCloud,
  updateCloudPreferences,
} from "./linkEnvironment";

const cloudLinkScheduler = createAtomCommandScheduler();
const cloudLinkConcurrency = {
  mode: "serial" as const,
  key: (input: { readonly target: CloudLinkTarget }) => input.target.environmentId,
};

export const linkEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:link-environment",
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: {
    readonly target: CloudLinkTarget;
    readonly clerkToken: string;
    readonly mode?: CloudLinkMode;
  }) => linkEnvironmentToCloud(input),
});

export const unlinkEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:unlink-environment",
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: { readonly target: CloudLinkTarget; readonly clerkToken: string | null }) =>
    unlinkEnvironmentFromCloud(input),
});

// SCIENT-FORK:START account-switch
const isManagedRelayClientError = Schema.is(ManagedRelay.ManagedRelayClientError);

/**
 * Moves an environment linked to another account to the signed-in one, as one queued step so a
 * concurrent Off cannot land between the unlink and the link. The local unlink always runs first;
 * the relay record it cannot remove belongs to the other account, and the new link ends it.
 */
export const switchEnvironmentAccount = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:switch-environment-account",
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: {
    readonly target: CloudLinkTarget;
    readonly clerkToken: string;
    readonly mode?: CloudLinkMode;
  }) =>
    unlinkEnvironmentFromCloud({ target: input.target, clerkToken: input.clerkToken }).pipe(
      Effect.catchIf(
        (error) => isCloudEnvironmentLinkError(error) && isManagedRelayClientError(error.cause),
        () => Effect.void,
      ),
      Effect.andThen(linkEnvironmentToCloud(input)),
    ),
});
// SCIENT-FORK:END account-switch

export const updateEnvironmentPreferences = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:update-environment-preferences",
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: {
    readonly target: CloudLinkTarget;
    readonly publishAgentActivity: boolean;
    readonly holdWebhooksWhileOffline?: boolean;
  }) => updateCloudPreferences(input),
});

export const checkReachability = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:check-reachability",
  execute: (input: { readonly target: CloudLinkTarget }) => checkCloudReachability(input),
});

export const readLinkState = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:read-link-state",
  execute: (input: { readonly target: CloudLinkTarget }) => readCloudLinkState(input),
});
