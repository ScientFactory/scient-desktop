import {
  ExtensionsError,
  type AccountsSnapshot,
  type PluginKeyBinding,
  type PluginKeyIdentity,
  type PluginKeyState,
  type PluginKeyTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { AccountsService, type AccountsServiceShape } from "../accounts/AccountsService.ts";
import { boundAccountId } from "../accounts/AccountBoundRef.ts";
import { makePluginKeyStateStore, pluginKeyIdentity } from "./PluginKeyStateStore.ts";

export const pluginKeyAccountsEligibilityKey = (snapshot: AccountsSnapshot) =>
  JSON.stringify([
    snapshot.agentAccess,
    snapshot.accounts.map(({ accountId, details, controls, secrets, status, updatedAt }) => ({
      accountId,
      details,
      controls,
      secrets,
      status,
      updatedAt,
    })),
  ]);

const unavailable = () =>
  new ExtensionsError({ reason: "state-unavailable", message: "Accounts is unavailable." });
export const makePluginKeyBindings = Effect.fn("PluginKeyBindings.make")(function* (
  stateDir: string,
  accounts: Pick<AccountsServiceShape, "resolveBound" | "listBindable"> | undefined,
) {
  const store = yield* makePluginKeyStateStore(stateDir);
  const events = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const notify = PubSub.publish(events, undefined).pipe(Effect.asVoid);
  const list = Effect.fn("PluginKeyBindings.list")(function* (
    target: PluginKeyTarget,
    requiredKeys: ReadonlyArray<string> | undefined,
    origins: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
  ) {
    const saved = yield* store.read;
    const choices = accounts
      ? yield* accounts.listBindable({}).pipe(Effect.orElseSucceed(() => []))
      : [];
    const keys = yield* Effect.forEach(
      requiredKeys ?? [],
      Effect.fn("PluginKeyBindings.keyStatus")(function* (envName) {
        const binding = saved.bindings.find(
          (item) => pluginKeyIdentity(item) === pluginKeyIdentity({ ...target, envName }),
        );
        const account = binding && choices.find((item) => item.ref === binding.accountRef);
        const available =
          accounts && binding && saved.writable
            ? yield* Effect.forEach(origins.get(envName) ?? [undefined], (origin) =>
                accounts.resolveBound(binding.accountRef, {
                  kind: "plugin-key",
                  agent: target.agent ?? "scient",
                  pluginId: target.pluginId,
                  envName,
                  ...(target.projectId ? { projectId: target.projectId } : {}),
                  ...(origin ? { origin } : {}),
                }),
              ).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              )
            : false;
        return {
          envName,
          origins: origins.get(envName) ?? [],
          available,
          ...(binding ? { accountRef: binding.accountRef } : {}),
          ...(account ? { accountName: account.name } : {}),
        };
      }),
    );
    return {
      status:
        saved.writable && requiredKeys !== undefined && keys.every((key) => key.available)
          ? "ready"
          : "needs-key",
      requirementsKnown: requiredKeys !== undefined,
      writable: saved.writable && accounts !== undefined,
      keys,
      accounts: choices,
    } satisfies PluginKeyState;
  });
  const bind = Effect.fn("PluginKeyBindings.bind")(
    function* (input: PluginKeyBinding) {
      if (!accounts) return yield* unavailable();
      if (
        Option.isNone(boundAccountId(input.accountRef)) ||
        !(yield* accounts.listBindable({})).some((item) => item.ref === input.accountRef)
      )
        return yield* new ExtensionsError({
          reason: "invalid-input",
          message: "Choose an API-key account.",
        });
      yield* store.update(input, input);
      yield* notify;
    },
    Effect.mapError(
      () =>
        new ExtensionsError({
          reason: "state-unavailable",
          message: "Could not bind this account. Check Accounts and try again.",
        }),
    ),
  );
  const unbind = Effect.fn("PluginKeyBindings.unbind")(function* (input: PluginKeyIdentity) {
    yield* store.update(input);
    yield* notify;
  });
  const resolveKey = Effect.fn("PluginKeyBindings.resolveKey")(function* (
    input: PluginKeyTarget & {
      readonly envName: string;
      readonly origin?: string;
      readonly expectedRef?: import("@t3tools/contracts").VaultSecretRef | undefined;
    },
  ) {
    if (!accounts) return yield* unavailable();
    const state = yield* store.read;
    const binding = state.bindings.find(
      (binding) => pluginKeyIdentity(binding) === pluginKeyIdentity(input),
    );
    if (
      !state.writable ||
      !binding ||
      (input.expectedRef !== undefined && input.expectedRef !== binding.accountRef)
    )
      return yield* unavailable();
    return yield* accounts
      .resolveBound(binding.accountRef, {
        kind: "plugin-key",
        agent: input.agent ?? "scient",
        pluginId: input.pluginId,
        envName: input.envName,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      })
      .pipe(Effect.mapError(unavailable));
  });
  return { list, bind, unbind, resolveKey, changes: Stream.fromPubSub(events) };
});
export class PluginKeyBindings extends Context.Service<
  PluginKeyBindings,
  Effect.Success<ReturnType<typeof makePluginKeyBindings>>
>()("t3/scient/extensions/PluginKeyBindings") {}
export const layer = Layer.effect(
  PluginKeyBindings,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const accounts = yield* Effect.serviceOption(AccountsService);
    return yield* makePluginKeyBindings(config.stateDir, Option.getOrUndefined(accounts));
  }),
);
