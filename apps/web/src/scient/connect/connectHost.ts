/**
 * Scient Connect on the desktop app's own computer, as its server reports it: whether it is on,
 * what setup is doing, and why it stopped. One status for every window; see ScientConnectHost on
 * the server. Servers that do not manage it (other computers, older versions) report null.
 */
import { useAtomValue } from "@effect/atom-react";
import { subscribe } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ScientConnectHostStatus, WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";

const scientConnectHostStatus = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:scient-connect:status",
  subscribe: (_input: null) =>
    subscribe(WS_METHODS.scientConnectStatus, {}, { resubscribeOnCompleteAfter: "1 second" }),
});

export const authorizeScientConnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scient-connect:authorize",
  tag: WS_METHODS.scientConnectAuthorize,
});

export const turnOffScientConnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:scient-connect:turn-off",
  tag: WS_METHODS.scientConnectTurnOff,
});

const NO_STATUS = Atom.make(AsyncResult.initial<ScientConnectHostStatus, never>());

/** The computer's own Scient Connect status when its server manages it, otherwise null. */
export function useScientConnectHost(
  environmentId: EnvironmentId | null,
): ScientConnectHostStatus | null {
  const result = useAtomValue(
    environmentId === null ? NO_STATUS : scientConnectHostStatus({ environmentId, input: null }),
  );
  const status = Option.getOrNull(AsyncResult.value(result));
  return status?.managed === true ? status : null;
}

/**
 * What the person should know about Scient Connect on this computer, in a sentence, or null when
 * it is connected (then reachability says whether other devices get through).
 */
export function describeScientConnectHost(
  status: ScientConnectHostStatus,
  signedIn: boolean,
): string | null {
  if (status.off) return "Scient Connect is off on this computer.";
  switch (status.phase) {
    case "connected":
      return null;
    case "idle":
    case "needs-authorization":
      return signedIn
        ? "Setting up Scient Connect…"
        : "Sign in to make this computer reachable from your other devices and invites.";
    case "installing":
      return status.installStage === "downloading"
        ? "Downloading what Scient Connect needs…"
        : status.installStage === "verifying" || status.installStage === "validating"
          ? "Checking the download…"
          : "Setting up Scient Connect…";
    case "linking":
      return "Connecting this computer…";
    case "waiting-to-retry":
      return status.retryReason
        ? `Scient Connect isn't set up yet; trying again shortly. ${status.retryReason}`
        : "Scient Connect isn't set up yet; trying again shortly.";
    case "blocked": {
      const block = status.block;
      if (block === undefined) return "Scient Connect could not be set up.";
      switch (block.reason) {
        case "limit":
          return `Your account already has ${block.maxTunnels} computers on Scient Connect. Remove one to add this computer.`;
        case "policy":
          return block.message;
        case "revoked":
          return "This computer was removed from Scient Connect. Turn it on to add it again.";
        case "install":
          return `Scient Connect could not be installed on this computer. ${block.message}`;
        case "failed":
          return `Scient Connect could not be set up. ${block.message}`;
      }
    }
  }
}

/** Whether setup has finished and only reachability is left to confirm. */
export const isScientConnectHostReady = (status: ScientConnectHostStatus): boolean =>
  !status.off && status.phase === "connected";
