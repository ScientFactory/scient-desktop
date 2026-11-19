import {
  ACCOUNTS_PROTOCOL,
  type AccountsSnapshot,
  type BrowserProfileRecord,
} from "@t3tools/contracts";
import { shareable } from "@t3tools/shared/scientSessionCookies";

import type { DeliveryFailure } from "./remoteSessions";

export interface RemoteLineInput {
  readonly phase: string;
  /** Accounts' switch lets this desktop send sign-ins at all. */
  readonly sharing: boolean;
  readonly sending: boolean;
  /** The last delivery that failed, until one succeeds. */
  readonly failure?: DeliveryFailure | undefined;
  readonly refused: "relay" | "unencrypted" | undefined;
  /** The remote's snapshot while connected. */
  readonly remote: Pick<AccountsSnapshot, "accountsProtocol"> | undefined;
  /** This desktop's records of what the remote applied, one per profile. */
  readonly shared: ReadonlyArray<NonNullable<BrowserProfileRecord["sharedWith"]>[number]>;
  /** University rows here whose institution the remote has no row for. */
  readonly universities: ReadonlyArray<string>;
}

/** What another computer holds of this desktop's sign-ins: the first state that matches. */
export type RemoteState =
  | { readonly kind: "sharing-off" }
  | { readonly kind: "sending" }
  | { readonly kind: "failed"; readonly failure: DeliveryFailure }
  | { readonly kind: "refused"; readonly route: "relay" | "unencrypted" }
  | { readonly kind: "outdated" }
  | { readonly kind: "delivered"; readonly sentAt: string }
  | { readonly kind: "offline"; readonly sentAt: string; readonly seenAt: string | undefined }
  | { readonly kind: "on-connect" };

export interface RemoteView {
  readonly state: RemoteState;
  readonly needsYou: ReadonlyArray<string>;
  readonly kept: number;
  readonly waiting: number;
  readonly universities: ReadonlyArray<string>;
}

const latest = (values: ReadonlyArray<string | undefined>) =>
  values
    .flatMap((value) => (value ? [value] : []))
    .sort()
    .at(-1);

export function remoteView(input: RemoteLineInput): RemoteView {
  const sentAt = latest(input.shared.map(({ sentAt }) => sentAt));
  const seenAt = latest(input.shared.map(({ seenAt }) => seenAt));
  const connected = input.phase === "connected";
  const state: RemoteState = !input.sharing
    ? { kind: "sharing-off" }
    : input.sending
      ? { kind: "sending" }
      : input.failure
        ? { kind: "failed", failure: input.failure }
        : input.refused
          ? { kind: "refused", route: input.refused }
          : connected && input.remote && (input.remote.accountsProtocol ?? 0) < ACCOUNTS_PROTOCOL
            ? { kind: "outdated" }
            : sentAt
              ? connected
                ? { kind: "delivered", sentAt }
                : { kind: "offline", sentAt, seenAt }
              : { kind: "on-connect" };
  return {
    state,
    needsYou: [...new Set(input.shared.flatMap(({ needsYou }) => needsYou))],
    kept: input.shared.reduce((total, { kept }) => total + (kept ?? 0), 0),
    waiting: input.shared.reduce((total, { waiting }) => total + waiting, 0),
    universities: input.universities,
  };
}

export type NotSentReason = "off" | "projects" | "scripts";

/** Persistent profiles that don't go to other computers, with why. */
export function notSent(
  profiles: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly record: BrowserProfileRecord;
  }>,
): ReadonlyArray<{ readonly name: string; readonly reason: NotSentReason }> {
  return profiles
    .filter(({ id, record }) => !shareable(id, record))
    .map(({ name, record }) => ({
      name,
      reason:
        record.access === "off"
          ? "off"
          : record.scope.type !== "all-projects"
            ? "projects"
            : "scripts",
    }));
}
