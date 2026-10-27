import {
  AccountsError,
  type AccountActivityEntry,
  type AccountSummary,
  type BrowserProfileRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { AccountsService } from "../AccountsService.ts";

export function fakeAccounts(
  options: {
    accounts?: ReadonlyArray<AccountSummary>;
    profiles?: ReadonlyArray<BrowserProfileRecord>;
    agentAccess?: boolean;
    denied?: boolean;
    values?: Readonly<Record<string, string>>;
  } = {},
) {
  const uses: Array<Omit<AccountActivityEntry, "at" | "decision">> = [];
  const calls: string[] = [];
  const unavailable = Effect.fail(
    new AccountsError({
      reason: "unsupported",
      message: "Not available in the synthetic account store.",
    }),
  );
  const service = AccountsService.of({
    passwordStore: () => unavailable,
    snapshot: unavailable,
    changes: Stream.empty,
    save: () => unavailable,
    remove: () => unavailable,
    test: () => unavailable,
    setControls: () => unavailable,
    setAgentAccess: () => unavailable,
    updateProfile: () => unavailable,
    removeProfile: () => unavailable,
    respondApproval: () => unavailable,
    activity: () => Effect.succeed([]),
    keychainCandidates: () => unavailable,
    connectOnePassword: () => unavailable,
    disconnectOnePassword: unavailable,
    importPasswords: () => unavailable,
    fillValues: () => unavailable,
    matchSignIn: () => unavailable,
    forSession: () =>
      Effect.succeed({
        agentAccess: options.agentAccess ?? true,
        accounts: options.accounts ?? [],
        profiles: options.profiles ?? [],
      }),
    authorize: (_scope, target, action) =>
      Effect.sync(() => {
        calls.push(`authorize:${target.type}:${action}`);
        return options.denied
          ? { decision: "denied" as const, reason: "off" as const }
          : { decision: "allowed" as const };
      }),
    resolveBound: () => unavailable,
    listBindable: () => unavailable,
    resolveSecrets: (_id, fields) =>
      Effect.sync(() => {
        calls.push("resolve");
        return Object.fromEntries(
          fields.flatMap((field) =>
            options.values?.[field] === undefined
              ? []
              : [[field, Redacted.make(options.values[field])]],
          ),
        );
      }),
    recordUse: (entry) =>
      Effect.sync(() => {
        uses.push(entry);
      }),
  });
  return { service, calls, uses };
}
