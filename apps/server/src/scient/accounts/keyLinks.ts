// @effect-diagnostics nodeBuiltinImport:off -- Digests of a followed value, never the value itself.
import * as NodeCrypto from "node:crypto";
import {
  AccountsError,
  keyServesUse,
  PROVIDER_DISPLAY_NAMES,
  type AccountId,
  type AccountKeyLink,
  type AccountLinkKeyInput,
  type AccountsSnapshot,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Semaphore from "effect/Semaphore";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../../serverSettings.ts";
import { keyReachesProviders } from "./AccountDecisions.ts";
import { AccountsService, type AccountsServiceShape } from "./AccountsService.ts";

const failure = (message: string) => new AccountsError({ reason: "unavailable", message });
const STARTUP_RECONCILE_LIMIT = Duration.seconds(10);

/**
 * API keys Scient holds itself, by value, to find one already kept. Keys in 1Password or the
 * Keychain aren't opened just to compare, and one that can't be read is skipped.
 */
export const heldApiKeys = Effect.fn("AccountKeyLinks.heldApiKeys")(function* (
  accounts: AccountsServiceShape,
) {
  const held = new Map<string, AccountId>();
  for (const account of (yield* accounts.snapshot).accounts) {
    const source = account.secrets.token?.source.type;
    if (
      !keyServesUse(account, { kind: "variable", id: "" }) ||
      (source !== "scient" && source !== "custom-model")
    )
      continue;
    const { token } = yield* accounts
      .resolveSecrets(account.accountId, ["token"])
      .pipe(Effect.orElseSucceed(() => ({ token: undefined })));
    const value = token === undefined ? undefined : Redacted.value(token);
    if (value !== undefined && !held.has(value)) held.set(value, account.accountId);
  }
  return held;
});

/**
 * Whether a followed variable may hold the account's key: a provider serves every project, so the
 * key must reach every project, with agent access on, and not be kept for another use.
 */
export const reachesEveryProject = (
  snapshot: Pick<AccountsSnapshot, "accounts" | "agentAccess">,
  accountId: AccountId,
) => {
  const account = snapshot.accounts.find((item) => item.accountId === accountId);
  return account !== undefined &&
    keyServesUse(account, { kind: "variable", id: "" }) &&
    keyReachesProviders(snapshot.agentAccess, account.controls)
    ? account
    : undefined;
};

/** A value is kept only as its digest, to tell the link's own copy from the person's. */
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("base64url");
/**
 * Whether the variable still holds what the link put there. A link from before copies were
 * recorded wrote whatever the variable held, as it always had; an empty variable is nobody's.
 */
const holdsCopy = (link: AccountKeyLink, value: unknown) =>
  typeof value === "string" &&
  (value === "" || link.copies === undefined || link.copies.includes(digest(value)));

/**
 * Lets a provider variable use a key from Accounts. Providers read their variables at start, so the
 * value is copied into the variable and copied again whenever the account's key changes. While the
 * key doesn't reach agents (Off, removed, limited to some projects) the variable is emptied. Only
 * the link's own copy is ever replaced: a value typed there since is the person's, and stays.
 */
export const makeAccountKeyLinks = Effect.fn("AccountKeyLinks.make")(function* (
  accounts: AccountsServiceShape,
) {
  const settings = yield* ServerSettingsService;
  // Read and written in one settings write, so an edit made meanwhile is never overwritten.
  const write = Effect.fn("AccountKeyLinks.write")(function* (
    link: AccountKeyLink,
    next: (value: unknown) => string | undefined,
  ) {
    if (!settings.updateProviderVariable)
      return yield* failure("Provider settings are unavailable.");
    const found = yield* settings
      .updateProviderVariable(link.instanceId as ProviderInstanceId, link.variable, next)
      .pipe(Effect.mapError(() => failure("The provider variable could not be updated.")));
    if (!found) return yield* failure("This variable no longer exists.");
  });
  const keyOf = (link: Pick<AccountKeyLink, "instanceId" | "variable">) =>
    `${link.instanceId}\u0000${link.variable}`;
  // Per variable: taking a copy back and writing a key never interleave, and a key read that began
  // before a take-back is not written after it.
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (key: string) => {
    let lock = locks.get(key);
    if (!lock) locks.set(key, (lock = Semaphore.makeUnsafe(1)));
    return lock;
  };
  const takenBack = new Map<string, number>();
  // No key is read to take one back, so a slow store never holds up a revocation.
  const takeBack = (link: AccountKeyLink) =>
    lockOf(keyOf(link)).withPermits(1)(
      Effect.suspend(() => {
        takenBack.set(keyOf(link), (takenBack.get(keyOf(link)) ?? 0) + 1);
        return write(link, (value) => (value !== "" && holdsCopy(link, value) ? "" : undefined));
      }),
    );
  /**
   * Writes the key over the link's own copy, or (the person linking) over `observed`, the value
   * the variable held when they linked it; never over a value typed there since.
   */
  const put = Effect.fn("AccountKeyLinks.put")(function* (
    link: AccountKeyLink,
    observed?: unknown,
    since = takenBack.get(keyOf(link)) ?? 0,
  ) {
    const { token } = yield* accounts.resolveSecrets(link.accountId, ["token"]);
    if (!token) return yield* failure("This account has no key to use.");
    const value = Redacted.value(token);
    // Recorded before it is written: a restart in between still knows the copy as the link's.
    const copies = [...new Set([...(link.copies ?? []).slice(-1), digest(value)])];
    yield* accounts.setKeyLink(link, link.accountId, copies, link.accountId);
    yield* lockOf(keyOf(link)).withPermits(1)(
      Effect.suspend(() =>
        (takenBack.get(keyOf(link)) ?? 0) !== since
          ? Effect.void
          : write(link, (current) =>
              current !== value &&
              (holdsCopy(link, current) || (observed !== undefined && current === observed))
                ? value
                : undefined,
            ),
      ),
    );
  });
  // Off, Remove and agent access turned off take the copies back before they are committed, so
  // no agent started meanwhile, or after a restart, gets the key.
  if (accounts.onAccessTaken)
    yield* accounts.onAccessTaken((links) => Effect.forEach(links, takeBack, { discard: true }));

  const seen = new Map<string, string>();
  const putting = yield* FiberMap.make<string>();
  const follow = (snapshot: AccountsSnapshot) =>
    Effect.forEach(
      [
        ...(snapshot.keyLinks ?? []).map((link) => ({ link, detached: false })),
        // A link retired with its key no longer follows it: the copy it left is taken back.
        ...(snapshot.detachedKeyLinks ?? []).map((link) => ({ link, detached: true })),
      ],
      ({ link, detached }) => {
        const account = detached ? undefined : reachesEveryProject(snapshot, link.accountId);
        const key = (detached ? "detached:" : "") + keyOf(link);
        const version = account ? account.accountId + ":" + account.updatedAt : "";
        if (seen.get(key) === version) return Effect.void;
        seen.set(key, version);
        const retry = Effect.sync(() => seen.delete(key));
        // A key read waiting on a prompt runs on its own; taking one back never waits for it.
        return account
          ? FiberMap.run(putting, key, put(link).pipe(Effect.catch(() => retry)))
          : FiberMap.remove(putting, key).pipe(
              Effect.andThen(takeBack(link)),
              Effect.catch(() => retry),
            );
      },
      { discard: true },
    );
  // Before the server takes its first session: a copy a failed take-back or an older build left
  // goes now, not when Accounts first opens. Only taking back, so no store is read at start; only
  // when an agent's settings hold a key at all; and never holding up the start for long.
  const settingsNow = yield* settings.getSettings.pipe(Effect.option);
  const holdsKeys = Option.exists(settingsNow, (current) =>
    Object.values(current.providerInstances).some((instance) =>
      (instance.environment ?? []).some(
        (variable) => variable.sensitive && typeof variable.value === "string" && variable.value,
      ),
    ),
  );
  if (holdsKeys)
    yield* accounts.snapshot.pipe(
      Effect.flatMap((snapshot) =>
        Effect.forEach(
          [
            ...(snapshot.keyLinks ?? []).filter(
              (link) => !reachesEveryProject(snapshot, link.accountId),
            ),
            ...(snapshot.detachedKeyLinks ?? []),
          ],
          (link) => takeBack(link).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
      Effect.timeoutOption(STARTUP_RECONCILE_LIMIT),
      Effect.ignore,
    );
  yield* Stream.runForEach(accounts.changes, follow).pipe(Effect.forkScoped);

  // After a settings change commits, links of agents that no longer exist go, so a later agent
  // with the same id starts clean and a removal that failed keeps its links. Only on a change, so
  // startup never opens Accounts.
  const dropRemoved = (current: ServerSettings) =>
    accounts.snapshot.pipe(
      Effect.flatMap((snapshot) =>
        Effect.forEach(
          (snapshot.keyLinks ?? []).filter(
            (link) => !(link.instanceId in current.providerInstances),
          ),
          (link) => accounts.setKeyLink(link),
          { discard: true },
        ),
      ),
      Effect.ignore,
    );
  yield* Effect.scoped(
    settings.subscribeChanges.pipe(
      Effect.flatMap((changes) => Stream.runForEach(changes, dropRemoved)),
    ),
  ).pipe(Effect.forkScoped);

  // The variable's key as an API key: an account already holding the same key, else a new one.
  const keep = Effect.fn("AccountKeyLinks.keep")(function* (
    target: Omit<AccountKeyLink, "accountId">,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => failure("Provider settings are unavailable.")),
    );
    const instance = current.providerInstances[target.instanceId as ProviderInstanceId];
    const value = instance?.environment?.find(
      (item) => item.name === target.variable && item.sensitive,
    )?.value;
    // A reference to another secret store has no value here to keep.
    if (!instance || typeof value !== "string" || !value)
      return yield* failure("This variable has no key Scient can keep.");
    // The same key under any name is one key: follow that account, so rotating it reaches here.
    const existing = (yield* heldApiKeys(accounts)).get(value);
    if (existing) return existing;
    const label =
      instance.displayName ??
      PROVIDER_DISPLAY_NAMES[instance.driver as ProviderDriverKind] ??
      instance.driver;
    const saved = yield* accounts.save({
      name: `${label} · ${target.variable}`.slice(0, 80),
      details: { kind: "api-key", sites: [], auth: { type: "bearer" }, envName: target.variable },
      secrets: { token: { type: "scient", value } },
    });
    return saved.accountId;
  });

  // The person's own choice: the variable takes the key over what it holds now, while the key
  // reaches. The link is recorded, owning nothing, before anything is written, so Off or Remove
  // meanwhile finds it; the link it replaces takes its own copy back first.
  return Effect.fn("AccountKeyLinks.link")(function* (input: AccountLinkKeyInput) {
    const accountId: AccountId = input.accountId ?? (yield* keep(input));
    const link = { instanceId: input.instanceId, variable: input.variable, accountId };
    const snapshot = yield* accounts.snapshot;
    const chosen = snapshot.accounts.find((account) => account.accountId === accountId);
    if (chosen && !keyServesUse(chosen, { kind: "variable", id: "" }))
      return yield* failure("This key stays with its own use.");
    const previous = (snapshot.keyLinks ?? []).find((item) => keyOf(item) === keyOf(link));
    if (previous && previous.accountId !== accountId) yield* takeBack(previous);
    const since = takenBack.get(keyOf(link)) ?? 0;
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => failure("Provider settings are unavailable.")),
    );
    const observed = current.providerInstances[
      link.instanceId as ProviderInstanceId
    ]?.environment?.find((item) => item.name === link.variable)?.value;
    const fresh = { ...link, copies: [] };
    yield* accounts.setKeyLink(link, accountId, []);
    if (reachesEveryProject(snapshot, accountId)) yield* put(fresh, observed ?? "", since);
  });
});

/** Server-lifetime, so a key changed in Accounts reaches its variables whenever it changes. */
export class AccountKeyLinks extends Context.Service<
  AccountKeyLinks,
  { readonly link: (input: AccountLinkKeyInput) => Effect.Effect<void, AccountsError> }
>()("t3/scient/accounts/keyLinks/AccountKeyLinks") {}

export const layer = Layer.effect(
  AccountKeyLinks,
  Effect.gen(function* () {
    return { link: yield* makeAccountKeyLinks(yield* AccountsService) };
  }),
);

/** The RPC side; a server without Accounts answers that it is unavailable. */
export const linkKeyForRpc = Effect.serviceOption(AccountKeyLinks).pipe(
  Effect.map(
    Option.match({
      onNone: () => () => Effect.fail(failure("Accounts is unavailable.")),
      onSome: (service) => service.link,
    }),
  ),
);
