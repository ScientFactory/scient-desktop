import {
  AccountId,
  AccountsError,
  defaultAccountControls,
  type AccountSaveInput,
  type AccountActivityEntry,
  type AccountHandoff,
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
    filledTab?: { accountId: AccountId; url: string };
  } = {},
) {
  const handoffs = new Map<string, AccountHandoff>();
  const cancelled = new Set<string>();
  const uses: Array<Omit<AccountActivityEntry, "at" | "decision">> = [];
  const calls: string[] = [];
  const accounts = [...(options.accounts ?? [])];
  const saves: Array<AccountSaveInput> = [];
  const unavailable = Effect.fail(
    new AccountsError({
      reason: "unsupported",
      message: "Not available in the synthetic account store.",
    }),
  );
  const service = AccountsService.of({
    setHandoff: (entry) =>
      Effect.sync(() => {
        handoffs.set(entry.handoffId, entry);
      }),
    removeHandoff: (id) =>
      Effect.sync(() => {
        handoffs.delete(id);
        cancelled.delete(id);
      }),
    handoffCancelled: (id) => Effect.sync(() => cancelled.has(id)),
    showHandoff: () => unavailable,
    cancelHandoff: (id) =>
      Effect.sync(() => {
        cancelled.add(id);
      }),
    passwordStore: () => unavailable,
    snapshot: unavailable,
    changes: Stream.empty,
    save: (input) =>
      Effect.sync(() => {
        saves.push(input);
        const accountId =
          input.accountId ?? AccountId.make(`acc_saved_${String(saves.length).padStart(4, "0")}`);
        const index = accounts.findIndex((account) => account.accountId === accountId);
        const saved: AccountSummary = {
          accountId,
          name: input.name,
          details: input.details,
          secrets: { token: { source: { type: "scient" } } },
          controls: accounts[index]?.controls ?? defaultAccountControls(input.details.kind),
          status: "ready",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        if (index === -1) accounts.push(saved);
        else accounts[index] = saved;
        return { accountId };
      }),
    remove: () => unavailable,
    test: () => unavailable,
    setControls: () => unavailable,
    setAgentAccess: () => unavailable,
    updateProfile: () => unavailable,
    removeProfile: () => unavailable,
    chooseProfile: () => unavailable,
    respondApproval: () => unavailable,
    activity: () => Effect.succeed([]),
    keychainCandidates: () => unavailable,
    connectOnePassword: () => unavailable,
    disconnectOnePassword: unavailable,
    importPasswords: () => unavailable,
    fillValues: () => unavailable,
    filledTab: () => Effect.succeed(options.filledTab),
    matchSignIn: () => unavailable,
    forSession: () =>
      Effect.succeed({
        agentAccess: options.agentAccess ?? true,
        accounts,
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
  return { service, calls, uses, handoffs, cancelled, saves };
}
