import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { msg } from "gt-react";
import type { EnvironmentMachineKind } from "@t3tools/contracts";

/** How one of the person's computers looks from the hosted page. */
export type HostedComputerStatus =
  | "checking"
  | "opening"
  | "off"
  | "unreachable"
  | "needs-update"
  | "open";

export interface HostedComputer {
  readonly id: string;
  readonly label: string;
  readonly machineKind: EnvironmentMachineKind;
  readonly status: HostedComputerStatus;
}

/** Everything the hosted landing can show, from first visit until a computer is open. */
export type HostedLandingModel =
  | { readonly kind: "loading" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "waiting"; readonly account: string | null }
  | {
      readonly kind: "computers";
      readonly account: string | null;
      readonly computers: ReadonlyArray<HostedComputer>;
    }
  | { readonly kind: "cant-list"; readonly account: string | null; readonly offline: boolean }
  | { readonly kind: "local-off" };

/** `msg()` strings: resolve them where they show. */
export const HOSTED_COMPUTER_STATUS_LABEL: Record<HostedComputerStatus, string> = {
  checking: msg("Checking…"),
  opening: msg("Opening…"),
  off: msg("Off or asleep"),
  unreachable: msg("Unreachable"),
  "needs-update": msg("Needs an update"),
  open: msg("Open", { $context: "the computer is open in Scient" }),
};

/** A discovered computer's relay availability, as the hosted page words it. */
export function statusFromAvailability(
  availability: "checking" | "online" | "offline" | "error",
  compatible: boolean,
): HostedComputerStatus {
  if (!compatible) return "needs-update";
  switch (availability) {
    case "checking":
      return "checking";
    case "online":
      return "opening";
    case "offline":
      return "off";
    case "error":
      return "unreachable";
  }
}

/** An added computer's connection phase, as the hosted page words it. */
export function statusFromConnectionPhase(phase: EnvironmentConnectionPhase): HostedComputerStatus {
  switch (phase) {
    case "connected":
      return "open";
    case "connecting":
    case "reconnecting":
    case "available":
      return "opening";
    case "offline":
      return "off";
    case "error":
      return "unreachable";
    case "unsupported":
      return "needs-update";
  }
}

/** The one thing the page says about a set of computers: the most hopeful state wins. */
export function summarizeComputers(
  computers: ReadonlyArray<HostedComputer>,
): Exclude<HostedComputerStatus, "open"> {
  const order: ReadonlyArray<Exclude<HostedComputerStatus, "open">> = [
    "opening",
    "checking",
    "unreachable",
    "needs-update",
    "off",
  ];
  for (const status of order) {
    if (computers.some((computer) => computer.status === status)) return status;
  }
  return "off";
}

const laptop = "Yaacov's MacBook Pro";

/** Fixture states for the development-only `?hostedPreview=` switch. */
export const HOSTED_LANDING_PREVIEWS: Record<string, HostedLandingModel> = {
  loading: { kind: "loading" },
  "signed-out": { kind: "signed-out" },
  waiting: { kind: "waiting", account: "yaacov@example.com" },
  checking: {
    kind: "computers",
    account: "yaacov@example.com",
    computers: [{ id: "mac", label: laptop, machineKind: "laptop", status: "checking" }],
  },
  opening: {
    kind: "computers",
    account: "yaacov@example.com",
    computers: [{ id: "mac", label: laptop, machineKind: "laptop", status: "opening" }],
  },
  off: {
    kind: "computers",
    account: "yaacov@example.com",
    computers: [{ id: "mac", label: laptop, machineKind: "laptop", status: "off" }],
  },
  unreachable: {
    kind: "computers",
    account: "yaacov@example.com",
    computers: [{ id: "mac", label: laptop, machineKind: "laptop", status: "unreachable" }],
  },
  "needs-update": {
    kind: "computers",
    account: "yaacov@example.com",
    computers: [{ id: "mac", label: laptop, machineKind: "laptop", status: "needs-update" }],
  },
  several: {
    kind: "computers",
    account: "yaacov@example.com",
    computers: [
      { id: "mac", label: laptop, machineKind: "laptop", status: "opening" },
      // oxlint-disable-next-line t3code/no-untranslated-copy -- sample computer name in a design preview state
      { id: "lab", label: "Lab workstation", machineKind: "desktop", status: "checking" },
      // oxlint-disable-next-line t3code/no-untranslated-copy -- sample computer name in a design preview state
      { id: "home", label: "Home iMac", machineKind: "desktop", status: "off" },
    ],
  },
  "cant-list": { kind: "cant-list", account: "yaacov@example.com", offline: true },
  "local-off": { kind: "local-off" },
};
