// @effect-diagnostics nodeBuiltinImport:off -- Opaque record ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import {
  ACCOUNT_SECRET_FIELDS,
  AccountId,
  AccountSaveInput,
  AccountMatchSignInInput,
  AccountsError,
  defaultAccountControls,
  type AccountActivityEntry,
  type AccountApproval,
  type AccountApprovalDecision,
  type AccountControls,
  type AccountSecretSummary,
  type AccountsSnapshot,
  type AccountSummary,
  type AccountTarget,
  type BrowserProfileRecord,
  type AccountValueSource,
  type AccountWriteStore,
} from "@t3tools/contracts";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  PubSub,
  Redacted,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { TOTP, URI } from "otpauth";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import {
  AccountsService,
  type AccountKeyConsumer,
  type AccountSessionScope,
  type AccountAuthorization,
} from "./AccountsService.ts";
import { AccountVault } from "./AccountVault.ts";
import {
  AccountPersistence,
  AccountsState,
  Activity,
  decodePrivateJson,
  emptyState,
  encodePrivateJson,
  type StoredAccount,
} from "./AccountPersistence.ts";
import { AccountSources, type OnePasswordClient } from "./AccountSources.ts";
import {
  applyApprovalDecision,
  agentAccessOff,
  authorizationDecision,
  effectiveProfile,
  inScope,
  sameTarget,
  siteMatches,
} from "./AccountDecisions.ts";
import { accountTokenRef, boundAccountId } from "./AccountBoundRef.ts";
import { planSecretStores, type CopyDestination } from "./copyPlan.ts";
import { parsePasswordImport } from "./PasswordImport.ts";

const failure = (reason: AccountsError["reason"], message: string) =>
  new AccountsError({ reason, message });
const missing = () => failure("not-found", "The account no longer exists.");
const valueName = () => `accounts-value-${NodeCrypto.randomUUID()}`;
const decodeSave = Schema.decodeEffect(AccountSaveInput);
const decodeMatch = Schema.decodeEffect(AccountMatchSignInInput);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const safeDetail = (detail: string | undefined) => {
  if (!detail) return undefined;
  try {
    return new URL(detail).origin;
  } catch {
    return /^[A-Z]{3,7} [a-z0-9.-]+(?::\d+)?$/.test(detail) || pluginKeyDetail.test(detail)
      ? detail.slice(0, 200)
      : undefined;
  }
};
const pluginKeyDetail = /^plugin [\w@./:-]{1,100} [A-Za-z_]\w{0,63} on [\w.-]{1,24}$/;
/** Plugin keys name the plugin, variable and agent; connectors name the site. */
const consumerActivity = (consumer: AccountKeyConsumer) =>
  consumer.kind === "connector"
    ? { detail: consumer.origin }
    : {
        detail: `plugin ${consumer.pluginId} ${consumer.envName} on ${consumer.agent}`,
        ...(consumer.projectId ? { projectId: consumer.projectId } : {}),
      };

export const layer = Layer.effect(
  AccountsService,
  Effect.gen(function* () {
    const persistence = yield* AccountPersistence;
    const sources = yield* AccountSources;
    const cliStores = sources.passwordStores;
    const vault = yield* AccountVault;
    const serviceScope = yield* Scope.Scope;
    const sourceControl = yield* Effect.serviceOption(SourceControlProviderRegistry);
    const writes = yield* Semaphore.make(1);
    const events = yield* PubSub.sliding<AccountsSnapshot>({ capacity: 1, replay: 1 });
    let state: AccountsState = emptyState;
    let recentActivity: ReadonlyArray<AccountActivityEntry> = [];
    let initialized = false;
    let bindingRevision = 0;
    let protection: "keychain" | "file" = "file";
    let onePasswordClient: OnePasswordClient | undefined;
    const cache = new Map<
      string,
      { until: number; values: Map<string, Redacted.Redacted<string>> }
    >();
    const conversationGrants = new Set<string>();
    const grantKey = (threadId: string, target: AccountTarget) =>
      JSON.stringify([
        threadId,
        target.type,
        target.type === "account" ? target.accountId : target.profileId,
      ]);
    const pending = new Map<
      string,
      {
        approval: AccountApproval;
        scope: AccountSessionScope;
        answer: Deferred.Deferred<AccountApprovalDecision>;
      }
    >();

    const snapshotNow = Effect.gen(function* () {
      const customModelKeys = yield* sources.customModelKeys.pipe(Effect.orElseSucceed(() => []));
      const providers = Option.isSome(sourceControl) ? yield* sourceControl.value.discover : [];
      const github = providers.find((provider) => provider.kind === "github");
      const githubAccounts =
        github?.auth.accounts?.filter((account) => account.authenticated) ?? [];
      if (
        github &&
        githubAccounts.length === 0 &&
        github.auth.status === "authenticated" &&
        Option.isSome(github.auth.account)
      ) {
        githubAccounts.push({
          account: github.auth.account.value,
          host: Option.getOrElse(github.auth.host, () => "github.com"),
          active: true,
          authenticated: true,
        });
      }
      const managedElsewhere: NonNullable<AccountsSnapshot["managedElsewhere"]> = [
        ...githubAccounts.map((account) => ({
          kind: "github" as const,
          id: `${account.host}:${account.account}`,
          name: account.account,
          detail: account.host,
          href: "/settings/source-control" as const,
        })),
        ...customModelKeys.map((connection) => ({
          kind: "custom-model" as const,
          id: connection.connectionId,
          name: connection.name,
          detail: connection.origin,
          href: "/settings/custom-models" as const,
        })),
      ];
      return {
        agentAccess: state.agentAccess,
        accounts: state.accounts.map((account) => account.summary),
        profiles: state.profiles,
        stores: {
          scient: { protection },
          keychain: { available: protection === "keychain", platform: sources.platform },
          onePassword: state.onePasswordStatus,
          cli: cliStores.statuses(),
        },
        approvals: [...pending.values()].map((entry) => entry.approval),
        recentActivity,
        customModelKeys,
        managedElsewhere,
      } satisfies AccountsSnapshot;
    });
    const publish = Effect.fn("AccountsService.publish")(function* (invalidateKeys = true) {
      if (invalidateKeys) bindingRevision++;
      yield* PubSub.publish(events, yield* snapshotNow);
    });
    const initialize = Effect.gen(function* () {
      if (initialized) return;
      protection = yield* vault.protection;
      const saved = yield* persistence.read("accounts-state");
      const activity = yield* persistence.read("accounts-activity");
      const loaded = Option.isSome(saved)
        ? yield* decodePrivateJson(AccountsState, saved.value)
        : emptyState;
      const log = Option.isSome(activity) ? yield* decodePrivateJson(Activity, activity.value) : [];
      cache.clear();
      onePasswordClient = undefined;
      state = loaded;
      recentActivity = log.slice(-500);
      initialized = true;
      yield* publish();
    });
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      writes.withPermits(1)(Effect.uninterruptible(initialize.pipe(Effect.andThen(effect))));
    const commit = Effect.fn("AccountsService.commit")(function* (
      next: AccountsState,
      usageOnly = false,
    ) {
      // Invalidate before the first write: cache hits must not bypass an in-flight revocation.
      if (!usageOnly) bindingRevision++;
      yield* persistence
        .write("accounts-state", yield* encodePrivateJson(AccountsState, next))
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              initialized = false;
            }),
          ),
        );
      state = next;
      yield* publish(!usageOnly);
    });
    const appendActivity = Effect.fn("AccountsService.appendActivity")(function* (
      entry: Omit<AccountActivityEntry, "at">,
    ) {
      const { detail, ...rest } = entry;
      const sanitized = safeDetail(detail);
      const next = [
        ...recentActivity,
        { ...rest, at: yield* now, ...(sanitized ? { detail: sanitized } : {}) },
      ].slice(-500);
      yield* persistence.write("accounts-activity", yield* encodePrivateJson(Activity, next));
      recentActivity = next;
      yield* publish(false);
    });
    const findAccount = (accountId: AccountId) =>
      state.accounts.find((account) => account.summary.accountId === accountId);
    const targetControls = (target: AccountTarget) =>
      target.type === "account"
        ? findAccount(target.accountId)?.summary.controls
        : effectiveProfile(state.profiles, target.profileId);
    const replaceAccount = (next: StoredAccount) => ({
      ...state,
      accounts: [
        ...state.accounts.filter((account) => account.summary.accountId !== next.summary.accountId),
        next,
      ],
    });
    const writeControls = Effect.fn("AccountsService.writeControls")(function* (
      target: AccountTarget,
      controls: AccountControls | BrowserProfileRecord,
    ) {
      if (target.type === "account") {
        const existing = findAccount(target.accountId);
        if (!existing || !("permission" in controls)) return yield* missing();
        yield* commit(
          replaceAccount({
            ...existing,
            summary: { ...existing.summary, controls, updatedAt: yield* now },
          }),
        );
      } else {
        if (!("profileId" in controls)) return yield* missing();
        yield* commit({
          ...state,
          profiles: [
            ...state.profiles.filter((profile) => profile.profileId !== target.profileId),
            controls,
          ],
        });
      }
    });
    const denyRevoked = Effect.gen(function* () {
      for (const { approval, scope, answer } of pending.values()) {
        const controls = targetControls(approval.target);
        if (
          !controls ||
          authorizationDecision(state.agentAccess, controls, scope).decision === "denied"
        )
          yield* Deferred.succeed(answer, "deny");
      }
    });
    const removeValues = Effect.fn("AccountsService.removeValues")(function* (
      names: ReadonlyArray<string>,
    ) {
      // Committed metadata is authoritative; inaccessible orphan blobs can be cleaned up later.
      for (const name of names) yield* persistence.remove(name).pipe(Effect.ignore);
    });
    const readValue = Effect.fn("AccountsService.readValue")(function* (name: string | undefined) {
      if (!name) return yield* failure("unavailable", "Stored account value is missing.");
      const stored = yield* persistence.read(name);
      if (Option.isNone(stored))
        return yield* failure("unavailable", "Stored account value is missing.");
      return Redacted.make(new TextDecoder().decode(Redacted.value(stored.value)));
    });
    const getOnePasswordClient = Effect.gen(function* () {
      if (onePasswordClient) return onePasswordClient;
      const config = state.onePassword;
      if (!config) return yield* failure("unavailable", "1Password is not connected.");
      const input =
        config.mode === "desktop"
          ? config
          : {
              mode: "service-account" as const,
              token: Redacted.value(yield* readValue(config.tokenRef)),
            };
      onePasswordClient = yield* sources.onePassword(Redacted.make(input));
      return onePasswordClient;
    });
    const resolve = Effect.fn("AccountsService.resolveSecrets")(function* (
      accountId: AccountId,
      fields: ReadonlyArray<string>,
    ) {
      const account = findAccount(accountId);
      if (!account) return yield* missing();
      const result: Record<string, Redacted.Redacted<string>> = Object.create(null);
      for (const field of fields) {
        const secret = Object.hasOwn(account.summary.secrets, field)
          ? account.summary.secrets[field]
          : undefined;
        if (!secret) continue;
        const source: AccountValueSource = secret.source;
        switch (source.type) {
          case "bitwarden":
          case "proton-pass":
            result[field] = yield* cliStores.resolve(source);
            break;
          case "scient":
            result[field] = yield* readValue(account.values[field]);
            break;
          case "keychain":
            result[field] = yield* sources.keychain(source);
            break;
          case "custom-model":
            result[field] = yield* sources.customModel(source.connectionId);
            break;
          case "1password": {
            if (
              field === "totp" ||
              field === "otp" ||
              source.reference.endsWith("?attribute=otp")
            ) {
              result[field] = yield* (yield* getOnePasswordClient).resolve(source.reference);
              break;
            }
            const time = yield* Clock.currentTimeMillis;
            let entry = cache.get(accountId);
            if (!entry || entry.until <= time) {
              entry = { until: time + 5 * 60_000, values: new Map() };
              cache.set(accountId, entry);
            }
            let value = entry.values.get(source.reference);
            if (!value) {
              value = yield* (yield* getOnePasswordClient).resolve(source.reference);
              entry.values.set(source.reference, value);
            }
            result[field] = value;
            break;
          }
        }
      }
      return result;
    });
    const save = Effect.fn("AccountsService.save")(function* (input: AccountSaveInput) {
      const existing = input.accountId ? findAccount(input.accountId) : undefined;
      if (input.accountId && !existing) return yield* missing();
      const permitted =
        input.details.kind === "cli-login"
          ? input.details.variables
              .filter((variable) => variable.secret)
              .map((variable) => variable.name)
          : ACCOUNT_SECRET_FIELDS[input.details.kind];
      if (Object.keys(input.secrets).some((field) => !permitted.includes(field)))
        return yield* failure(
          "invalid-input",
          "This secret field is not valid for the account kind.",
        );
      const timestamp = yield* now;
      const accountId =
        existing?.summary.accountId ?? AccountId.make(`acc_${NodeCrypto.randomUUID()}`);
      const values: Record<string, string> = Object.create(null);
      const secrets: Record<string, AccountSecretSummary> = Object.create(null);
      for (const field of permitted) {
        const old =
          existing && Object.hasOwn(existing.summary.secrets, field)
            ? existing.summary.secrets[field]
            : undefined;
        if (old) secrets[field] = old;
        if (existing && Object.hasOwn(existing.values, field))
          values[field] = existing.values[field]!;
      }
      const warnings: string[] = [];
      const pendingCopies: Record<string, ReadonlyArray<AccountWriteStore>> = Object.assign(
        Object.create(null),
        Object.fromEntries(
          Object.entries(existing?.pendingCopies ?? {}).filter(([field]) =>
            permitted.includes(field),
          ),
        ),
      );
      const updates: Array<{
        field: string;
        value: Redacted.Redacted<string>;
        destinations: ReadonlyArray<CopyDestination>;
        primary?: AccountValueSource;
      }> = [];
      for (const [field, change] of Object.entries(input.secrets)) {
        delete values[field];
        const previousPending = pendingCopies[field];
        delete pendingCopies[field];
        if (change.type === "clear") {
          delete secrets[field];
          continue;
        }
        const old = secrets[field];
        const readOnlyLink = change.type === "bitwarden" || change.type === "proton-pass";
        const linked = change.type !== "scient" && !readOnlyLink && Boolean(old?.copies?.length);
        const linkedValue = !linked
          ? undefined
          : change.type === "keychain"
            ? yield* sources.keychain(change)
            : change.type === "custom-model"
              ? yield* sources.customModel(change.connectionId)
              : change.type === "1password"
                ? yield* (yield* getOnePasswordClient).resolve(change.reference)
                : undefined;
        if (change.type === "scient" || linkedValue) {
          const value = change.type === "scient" ? Redacted.make(change.value) : linkedValue!;
          const name = valueName();
          yield* persistence.write(
            name,
            Redacted.make(new TextEncoder().encode(Redacted.value(value))),
          );
          values[field] = name;
          const replacingLink =
            change.type === "scient" &&
            change.saveTo === undefined &&
            old?.source.type !== "scient" &&
            !old?.copies?.length;
          const planned = planSecretStores(
            accountId,
            input.details,
            field,
            replacingLink ? undefined : old,
            change.type === "scient" ? change.saveTo : undefined,
            replacingLink ? undefined : previousPending,
          );
          const destinations =
            change.type === "scient"
              ? planned
              : [
                  ...new Map(
                    [change, ...planned].map((source) => [JSON.stringify(source), source]),
                  ).values(),
                ];
          const actual = destinations.filter(
            (destination): destination is AccountValueSource =>
              !(destination.type === "1password" && "vaultId" in destination),
          );
          pendingCopies[field] = destinations.flatMap((destination) =>
            destination.type === "1password" && "vaultId" in destination ? [destination] : [],
          );
          secrets[field] = {
            source: { type: "scient" },
            copies: actual.filter((source) => source.type !== "scient"),
            ...(input.details.kind === "api-key" && Redacted.value(value).length > 4
              ? { hint: Redacted.value(value).slice(-4) }
              : {}),
          };
          updates.push({
            field,
            value,
            destinations,
            ...(change.type === "scient" ? {} : { primary: change }),
          });
        } else secrets[field] = { source: change };
      }
      const summary = (): AccountSummary => ({
        accountId,
        name: input.name,
        details: input.details,
        secrets: structuredClone(secrets),
        controls:
          input.controls ??
          existing?.summary.controls ??
          defaultAccountControls(input.details.kind),
        status:
          warnings.length || Object.values(pendingCopies).some((targets) => targets.length)
            ? "needs-attention"
            : "ready",
        ...(warnings.length ? { statusMessage: warnings[0] } : {}),
        ...(!input.secrets?.password && !input.secrets?.totp && existing?.summary.lastSignInOutcome
          ? { lastSignInOutcome: existing.summary.lastSignInOutcome }
          : {}),
        createdAt: existing?.summary.createdAt ?? timestamp,
        updatedAt: timestamp,
        ...(existing?.summary.lastUsedAt ? { lastUsedAt: existing.summary.lastUsedAt } : {}),
      });
      // Persist the new value before external writes; a rejected copy never loses the user's password.
      yield* commit(
        replaceAccount({
          summary: summary(),
          values: { ...values },
          pendingCopies: { ...pendingCopies },
        }),
      );
      const stagedValues = Object.values(values);
      for (const { field, value, destinations, primary: preferred } of updates) {
        const completed: AccountValueSource[] = [];
        const retry: AccountWriteStore[] = [];
        let failed = false;
        for (const destination of destinations) {
          if (destination.type === "scient") {
            completed.push(destination);
            continue;
          }
          if (
            destination.type === "custom-model" ||
            destination.type === "bitwarden" ||
            destination.type === "proton-pass"
          )
            continue;
          const vaultId =
            destination.type === "1password"
              ? "vaultId" in destination
                ? destination.vaultId
                : destination.reference.split("/")[2]
              : undefined;
          const status = state.onePasswordStatus;
          const vaultInfo =
            status.state === "connected"
              ? status.vaults?.find((vault) => vault.id === vaultId || vault.name === vaultId)
              : undefined;
          const operation: Effect.Effect<AccountValueSource, AccountsError> =
            destination.type === "keychain"
              ? sources.writeKeychain(destination, value).pipe(Effect.as(destination))
              : Effect.gen(function* () {
                  if (vaultInfo?.readOnly)
                    return yield* failure("denied", "1Password vault is read-only.");
                  const client = yield* getOnePasswordClient;
                  if ("reference" in destination) {
                    if (!client.write)
                      return yield* failure("unsupported", "1Password writes are unavailable.");
                    yield* client.write(destination.reference, value);
                    return destination;
                  }
                  if (!client.createLogin)
                    return yield* failure("unsupported", "1Password writes are unavailable.");
                  return yield* client.createLogin({
                    vaultId: destination.vaultId,
                    copyId: `${accountId}:${field}`,
                    title: input.name,
                    details: input.details,
                    field,
                    value,
                  });
                });
          const result = yield* operation.pipe(Effect.result);
          if (result._tag === "Success") completed.push(result.success);
          else {
            failed = true;
            if (destination.type === "keychain") retry.push({ type: "keychain" });
            else if (vaultId) retry.push({ type: "1password", vaultId });
            if (
              destination.type === "1password" &&
              result.failure.reason === "denied" &&
              status.state === "connected"
            ) {
              state = {
                ...state,
                onePasswordStatus: {
                  ...status,
                  vaults:
                    status.vaults?.map((vault) =>
                      vault === vaultInfo ? { ...vault, readOnly: true } : vault,
                    ) ?? [],
                },
              };
            }
            warnings.push(
              destination.type === "keychain"
                ? "Could not save to System keychain."
                : result.failure.reason === "denied"
                  ? `Vault ${vaultInfo?.name ?? vaultId ?? "1Password"} is read-only.`
                  : `Could not save to ${vaultInfo?.name ?? "1Password"}.`,
            );
            if ("reference" in destination || destination.type === "keychain")
              completed.push(destination);
          }
        }
        pendingCopies[field] = retry;
        const primary = failed
          ? { type: "scient" as const }
          : (preferred ??
            (destinations.some((target) => target.type === "scient")
              ? { type: "scient" as const }
              : completed[0]));
        if (!primary) continue;
        secrets[field] = {
          ...secrets[field]!,
          source: primary,
          copies: completed.filter((source) => JSON.stringify(source) !== JSON.stringify(primary)),
        };
        if (
          primary.type !== "scient" &&
          !secrets[field]?.copies?.some((source) => source.type === "scient")
        )
          delete values[field];
      }
      if (updates.length)
        yield* commit(
          replaceAccount({
            summary: summary(),
            values: { ...values },
            pendingCopies: { ...pendingCopies },
          }),
        );
      cache.delete(accountId);
      yield* removeValues(
        [...Object.values(existing?.values ?? {}), ...stagedValues].filter(
          (name) => !Object.values(values).includes(name),
        ),
      );
      yield* denyRevoked;
      return { accountId, ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}) };
    });

    const service = AccountsService.of({
      snapshot: locked(snapshotNow),
      recordBoundDenial: Effect.fn("AccountsService.recordBoundDenial")((ref, consumer) => {
        const id = boundAccountId(ref);
        return Option.isSome(id)
          ? locked(
              appendActivity({
                target: { type: "account", accountId: id.value },
                action: "request",
                decision: "denied",
                ...consumerActivity(consumer),
              }),
            ).pipe(Effect.ignore)
          : Effect.void;
      }),
      bindingRevision: Effect.sync(() => (initialized ? bindingRevision : undefined)),
      changes: Stream.fromPubSub(events),
      save: Effect.fn("AccountsService.saveInput")((input) =>
        locked(
          decodeSave(input).pipe(
            Effect.mapError(() => failure("invalid-input", "Account input is invalid.")),
            Effect.flatMap(save),
          ),
        ),
      ),
      remove: Effect.fn("AccountsService.remove")((accountId) =>
        locked(
          Effect.gen(function* () {
            const existing = findAccount(accountId);
            if (!existing) return yield* missing();
            yield* commit({
              ...state,
              accounts: state.accounts.filter((account) => account !== existing),
            });
            cache.delete(accountId);
            yield* removeValues(Object.values(existing.values));
            yield* denyRevoked;
          }),
        ),
      ),
      test: Effect.fn("AccountsService.test")((accountId) =>
        locked(
          Effect.gen(function* () {
            const existing = findAccount(accountId);
            if (!existing) return yield* missing();
            const result = yield* resolve(accountId, Object.keys(existing.summary.secrets)).pipe(
              Effect.result,
            );
            const hasPending = Object.values(existing.pendingCopies ?? {}).some(
              (targets) => targets.length,
            );
            const { statusMessage: _, ...summary } = existing.summary;
            yield* commit(
              replaceAccount({
                ...existing,
                summary: {
                  ...summary,
                  status: result._tag === "Success" && !hasPending ? "ready" : "needs-attention",
                  ...(result._tag === "Failure"
                    ? { statusMessage: result.failure.message }
                    : hasPending
                      ? {
                          statusMessage:
                            existing.summary.statusMessage ?? "A password copy needs attention.",
                        }
                      : {}),
                },
              }),
            );
            if (result._tag === "Failure") return yield* result.failure;
          }),
        ),
      ),
      setControls: Effect.fn("AccountsService.setControls")((input) =>
        locked(
          Effect.gen(function* () {
            const controls = targetControls(input.target);
            if (!controls) return yield* missing();
            const next = {
              ...controls,
              ...(input.access ? { access: input.access, allowedProjects: [] } : {}),
              ...(input.scope ? { scope: input.scope } : {}),
            };
            yield* writeControls(
              input.target,
              "profileId" in next
                ? {
                    ...next,
                    ...(input.scriptSignIn === undefined
                      ? {}
                      : { scriptSignIn: input.scriptSignIn }),
                  }
                : {
                    ...next,
                    ...(input.permission ? { permission: input.permission } : {}),
                    ...(input.visibility ? { visibility: input.visibility } : {}),
                  },
            );
            yield* denyRevoked;
          }),
        ),
      ),
      setAgentAccess: Effect.fn("AccountsService.setAgentAccess")((enabled) =>
        locked(
          Effect.suspend(() =>
            commit({ ...state, agentAccess: enabled }).pipe(Effect.andThen(denyRevoked)),
          ),
        ),
      ),
      updateProfile: Effect.fn("AccountsService.updateProfile")((input) =>
        locked(
          Effect.gen(function* () {
            const next = { ...effectiveProfile(state.profiles, input.profileId) };
            for (const key of ["picture", "color", "source"] as const) {
              if (input[key] === null) delete next[key];
            }
            yield* commit({
              ...state,
              profiles: [
                ...state.profiles.filter((profile) => profile.profileId !== input.profileId),
                {
                  ...next,
                  ...(input.picture ? { picture: input.picture } : {}),
                  ...(input.color ? { color: input.color } : {}),
                  ...(input.source ? { source: input.source } : {}),
                },
              ],
            });
          }),
        ),
      ),
      removeProfile: Effect.fn("AccountsService.removeProfile")((profileId) =>
        locked(
          Effect.suspend(() =>
            commit({
              ...state,
              profiles: state.profiles.filter((profile) => profile.profileId !== profileId),
            }),
          ),
        ),
      ),
      respondApproval: Effect.fn("AccountsService.respondApproval")((approvalId, decision) =>
        locked(
          Effect.gen(function* () {
            const entry = pending.get(approvalId);
            if (!entry || (yield* Deferred.isDone(entry.answer)))
              return yield* failure("not-found", "The approval is no longer pending.");
            if (decision === "project" && entry.scope.projectId === undefined)
              return yield* failure("invalid-input", "This approval has no project.");
            const controls = targetControls(entry.approval.target);
            if (
              controls &&
              authorizationDecision(state.agentAccess, controls, entry.scope).decision !== "denied"
            )
              yield* writeControls(
                entry.approval.target,
                applyApprovalDecision(controls, decision, entry.scope.projectId),
              );
            if (
              decision === "once" &&
              controls &&
              authorizationDecision(state.agentAccess, controls, entry.scope).decision !== "denied"
            )
              conversationGrants.add(grantKey(entry.scope.threadId, entry.approval.target));
            yield* Deferred.succeed(entry.answer, decision);
          }),
        ),
      ),
      activity: Effect.fn("AccountsService.activity")((input) =>
        locked(
          Effect.sync(() =>
            recentActivity
              .filter((entry) => !input.target || sameTarget(entry.target, input.target))
              .slice(-(input.limit ?? 500))
              .toReversed(),
          ),
        ),
      ),
      passwordStore: Effect.fn("AccountsService.passwordStore")((input) =>
        locked(
          Effect.gen(function* () {
            const result = yield* cliStores.command(input);
            yield* publish;
            return result;
          }),
        ),
      ),
      keychainCandidates: sources.candidates,
      connectOnePassword: Effect.fn("AccountsService.connectOnePassword")((input) =>
        locked(
          Effect.gen(function* () {
            const connected = yield* sources.onePassword(Redacted.make(input)).pipe(Effect.result);
            if (connected._tag === "Failure") {
              yield* commit({
                ...state,
                onePasswordStatus: {
                  state: "error",
                  mode: input.mode,
                  message: connected.failure.message,
                },
              });
              return (yield* snapshotNow).stores;
            }
            const previous = state.onePassword;
            const tokenRef = input.mode === "service-account" ? valueName() : undefined;
            if (tokenRef && input.mode === "service-account")
              yield* persistence.write(
                tokenRef,
                Redacted.make(new TextEncoder().encode(input.token)),
              );
            yield* commit({
              ...state,
              onePassword:
                input.mode === "desktop" ? input : { mode: "service-account", tokenRef: tokenRef! },
              onePasswordStatus: {
                state: "connected",
                mode: input.mode,
                label: connected.success.label,
                vaults: connected.success.vaults ?? [],
              },
            });
            onePasswordClient = connected.success;
            cache.clear();
            if (previous?.mode === "service-account") yield* removeValues([previous.tokenRef]);
            return (yield* snapshotNow).stores;
          }),
        ),
      ),
      disconnectOnePassword: locked(
        Effect.gen(function* () {
          const previous = state.onePassword;
          const { onePassword: _, ...next } = state;
          yield* commit({ ...next, onePasswordStatus: { state: "not-connected" } });
          onePasswordClient = undefined;
          cache.clear();
          if (previous?.mode === "service-account") yield* removeValues([previous.tokenRef]);
          return (yield* snapshotNow).stores;
        }),
      ),
      importPasswords: Effect.fn("AccountsService.importPasswords")((input) =>
        locked(
          Effect.gen(function* () {
            const parsed = yield* Effect.try({
              try: () => parsePasswordImport(input.content, input.format),
              catch: () =>
                failure("invalid-input", "The password export is not a supported CSV file."),
            });
            const result = { created: 0, updated: 0, skipped: parsed.skipped };
            for (const entry of parsed.entries) {
              const existing = state.accounts.find(
                (account) =>
                  account.summary.details.kind === "website" &&
                  account.summary.details.sites.includes(entry.site) &&
                  (account.summary.details.username ?? "") === entry.username,
              );
              if (existing) {
                const current = yield* resolve(existing.summary.accountId, ["password", "totp"]);
                const details = existing.summary.details;
                if (
                  details.kind === "website" &&
                  (input.profileId === undefined || details.profileId === input.profileId) &&
                  current.password &&
                  Redacted.value(current.password) === entry.password &&
                  (current.totp ? Redacted.value(current.totp) : undefined) === entry.totp
                ) {
                  result.skipped++;
                  continue;
                }
              }
              // A new subdomain sign-in is never more open than the user's own account covering it.
              const covering = existing
                ? undefined
                : state.accounts.find(
                    (account) =>
                      account.summary.details.kind === "website" &&
                      (account.summary.details.username ?? "") === entry.username &&
                      siteMatches(account.summary.details.sites, `https://${entry.site}`),
                  );
              yield* save({
                ...(existing ? { accountId: existing.summary.accountId } : {}),
                ...(covering ? { controls: covering.summary.controls } : {}),
                // An import refreshes values; the user's own name and sign-in address stay.
                name: existing?.summary.name ?? entry.name,
                details: {
                  kind: "website",
                  sites: [entry.site],
                  username: entry.username,
                  loginUrl:
                    (existing?.summary.details.kind === "website"
                      ? existing.summary.details.loginUrl
                      : undefined) ?? entry.loginUrl,
                  ...(input.profileId
                    ? { profileId: input.profileId }
                    : existing?.summary.details.kind === "website" &&
                        existing.summary.details.profileId
                      ? { profileId: existing.summary.details.profileId }
                      : {}),
                },
                secrets: {
                  password: { type: "scient", value: entry.password },
                  totp: entry.totp ? { type: "scient", value: entry.totp } : { type: "clear" },
                },
              });
              if (existing) result.updated++;
              else result.created++;
            }
            return result;
          }),
        ),
      ),
      matchSignIn: Effect.fn("AccountsService.matchSignIn")((raw) =>
        locked(
          Effect.gen(function* () {
            const input = yield* decodeMatch(raw).pipe(
              Effect.mapError(() => failure("invalid-input", "Sign-in input is invalid.")),
            );
            const candidates = state.accounts
              .filter(
                ({ summary: { details } }) =>
                  (details.kind === "website" || details.kind === "library") &&
                  details.username === input.username &&
                  siteMatches(details.sites, input.origin),
              )
              .sort((a, b) => {
                const sameProfile = (account: StoredAccount) =>
                  "profileId" in account.summary.details &&
                  account.summary.details.profileId === input.profileId
                    ? 1
                    : 0;
                const exact = (account: StoredAccount) =>
                  "sites" in account.summary.details &&
                  account.summary.details.sites.includes(input.origin)
                    ? 1
                    : 0;
                return (
                  sameProfile(b) - sameProfile(a) ||
                  exact(b) - exact(a) ||
                  (b.summary.lastUsedAt ?? "").localeCompare(a.summary.lastUsedAt ?? "")
                );
              });
            const digest = (value: Redacted.Redacted<string>) =>
              NodeCrypto.createHash("sha256").update(Redacted.value(value)).digest();
            const submitted = digest(Redacted.make(input.password));
            for (const account of candidates) {
              cache.delete(account.summary.accountId);
              const resolved = yield* resolve(account.summary.accountId, ["password"]);
              if (
                resolved.password &&
                NodeCrypto.timingSafeEqual(submitted, digest(resolved.password))
              )
                return { result: "same" as const, accountId: account.summary.accountId };
            }
            return candidates[0]
              ? { result: "password-changed" as const, accountId: candidates[0].summary.accountId }
              : { result: "new" as const };
          }),
        ),
      ),
      fillValues: Effect.fn("AccountsService.fillValues")((accountId, origin) =>
        locked(
          Effect.gen(function* () {
            const account = findAccount(accountId);
            if (!account) return yield* missing();
            const details = account.summary.details;
            if (
              (details.kind !== "website" && details.kind !== "library") ||
              !siteMatches(details.sites, origin)
            )
              return yield* failure("denied", "The page does not match this account's sites.");
            const values = yield* resolve(accountId, ["password", "totp"]);
            let otp: string | undefined;
            if (values.totp) {
              const value = Redacted.value(values.totp);
              const timestamp = yield* Clock.currentTimeMillis;
              const source = account.summary.secrets.totp?.source;
              otp = yield* Effect.try({
                try: () => {
                  if (
                    ((source?.type === "bitwarden" || source?.type === "proton-pass") &&
                      /^\d{6,8}$/.test(value)) ||
                    (source?.type === "1password" && source.reference.endsWith("?attribute=otp"))
                  )
                    return value;
                  const generator = value.startsWith("otpauth://")
                    ? URI.parse(value)
                    : new TOTP({ secret: value.replace(/\s/g, "") });
                  if (!(generator instanceof TOTP))
                    throw failure("invalid-input", "The one-time password setup is invalid.");
                  return generator.generate({ timestamp });
                },
                catch: () => failure("unavailable", "A one-time password could not be generated."),
              });
            }
            yield* commit(
              replaceAccount({
                ...account,
                summary: { ...account.summary, lastUsedAt: yield* now },
              }),
            );
            return {
              ...(details.username === undefined ? {} : { username: details.username }),
              ...(values.password ? { password: Redacted.value(values.password) } : {}),
              ...(otp ? { otp } : {}),
            };
          }),
        ),
      ),
      forSession: Effect.fn("AccountsService.forSession")((scope, profileIds) =>
        locked(
          Effect.gen(function* () {
            const profiles = [
              ...new Set([
                ...(yield* sources.profiles),
                ...state.profiles.map((profile) => profile.profileId),
                ...(profileIds ?? []),
              ]),
            ];
            return {
              agentAccess: state.agentAccess,
              accounts: state.agentAccess
                ? state.accounts
                    .map((account) => account.summary)
                    .filter((account) => inScope(account.controls.scope, scope.projectId))
                : [],
              profiles: state.agentAccess
                ? profiles
                    .map((id) => effectiveProfile(state.profiles, id))
                    .filter((profile) => inScope(profile.scope, scope.projectId))
                : [],
            };
          }),
        ),
      ),
      authorize: Effect.fn("AccountsService.authorize")(function* (scope, target, action, options) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const prepared = yield* locked(
              Effect.gen(function* () {
                const controls = targetControls(target);
                if (!controls) return yield* missing();
                const baseDecision = authorizationDecision(state.agentAccess, controls, {
                  ...scope,
                  unattended: false,
                });
                const decision =
                  baseDecision.decision === "ask" &&
                  conversationGrants.has(grantKey(scope.threadId, target))
                    ? { decision: "allowed" as const }
                    : authorizationDecision(state.agentAccess, controls, scope);
                const audit = {
                  target,
                  action,
                  threadId: scope.threadId,
                  ...(scope.projectId ? { projectId: scope.projectId } : {}),
                  ...(options?.detail ? { detail: options.detail } : {}),
                };
                yield* appendActivity({
                  ...audit,
                  decision: decision.decision === "ask" ? "asked" : decision.decision,
                });
                if (decision.decision !== "ask") return { kind: "immediate" as const, decision };
                const approval: AccountApproval = {
                  approvalId: `apr_${NodeCrypto.randomUUID()}`,
                  target,
                  targetName:
                    target.type === "account"
                      ? findAccount(target.accountId)!.summary.name
                      : target.profileId,
                  action,
                  threadId: scope.threadId,
                  ...(scope.projectId ? { projectId: scope.projectId } : {}),
                  requestedAt: yield* now,
                };
                const answer = yield* Deferred.make<AccountApprovalDecision>();
                pending.set(approval.approvalId, { approval, scope, answer });
                yield* publish();
                return { kind: "pending" as const, approval, answer, audit };
              }),
            );
            if (prepared.kind === "immediate") return prepared.decision;
            return yield* Effect.gen(function* () {
              const response = yield* restore(
                Deferred.await(prepared.answer).pipe(Effect.timeoutOption("10 minutes")),
              );
              return yield* locked(
                Effect.gen(function* () {
                  const controls = targetControls(target);
                  const current = controls
                    ? authorizationDecision(state.agentAccess, controls, scope)
                    : { decision: "denied" as const, reason: "declined" as const };
                  const result: AccountAuthorization =
                    current.decision === "denied"
                      ? current
                      : Option.isNone(response)
                        ? { decision: "denied", reason: "timed-out" }
                        : response.value === "deny"
                          ? { decision: "denied", reason: "declined" }
                          : { decision: "allowed" };
                  yield* appendActivity({ ...prepared.audit, decision: result.decision });
                  return result;
                }),
              );
            }).pipe(
              Effect.ensuring(
                writes
                  .withPermits(1)(
                    Effect.uninterruptible(
                      Effect.gen(function* () {
                        pending.delete(prepared.approval.approvalId);
                        yield* publish();
                      }),
                    ),
                  )
                  .pipe(Effect.ignore),
              ),
            );
          }),
        );
      }),
      listBindable: Effect.fn("AccountsService.listBindable")(({ origin }) =>
        locked(
          Effect.sync(() =>
            state.accounts.flatMap(({ summary }) =>
              summary.details.kind === "api-key" &&
              (origin === undefined || siteMatches(summary.details.sites, origin))
                ? [{ ref: accountTokenRef(summary.accountId), name: summary.name }]
                : [],
            ),
          ),
        ),
      ),
      resolveBound: Effect.fn("AccountsService.resolveBound")((ref, consumer, options) =>
        locked(
          Effect.gen(function* () {
            const { origin } = consumer;
            const accountId = boundAccountId(ref);
            if (Option.isNone(accountId))
              return yield* failure("invalid-input", "The account reference is invalid.");
            const account = findAccount(accountId.value);
            if (!account) return yield* missing();
            const { details, controls } = account.summary;
            if (
              details.kind !== "api-key" ||
              (origin !== undefined && !siteMatches(details.sites, origin)) ||
              agentAccessOff(state.agentAccess, controls.access) ||
              (consumer.kind === "plugin-key" && !inScope(controls.scope, consumer.projectId))
            ) {
              if (consumer.kind !== "plugin-key")
                yield* appendActivity({
                  target: { type: "account", accountId: accountId.value },
                  action: "request",
                  decision: "denied",
                  ...consumerActivity(consumer),
                }).pipe(Effect.ignore);
              return yield* failure("denied", "The account is unavailable for this service.");
            }
            const values = yield* resolve(accountId.value, ["token"]);
            if (values.token === undefined)
              return yield* failure("not-found", "The account key is missing.");
            return values.token;
          }),
        ).pipe(
          Effect.tapError(() =>
            consumer.kind === "plugin-key"
              ? service.recordBoundDenial!(ref, consumer)
              : Effect.void,
          ),
          Effect.tap(() => {
            if (consumer.kind === "plugin-key" && options?.auditAllowed === false)
              return Effect.void;
            const accountId = boundAccountId(ref);
            return Option.isSome(accountId)
              ? service.recordUse({
                  target: { type: "account", accountId: accountId.value },
                  action: "request",
                  ...consumerActivity(consumer),
                })
              : Effect.void;
          }),
        ),
      ),
      resolveSecrets: Effect.fn("AccountsService.resolveSecretsInput")((accountId, fields) =>
        locked(resolve(accountId, fields)),
      ),
      recordUse: Effect.fn("AccountsService.recordUse")((entry) =>
        locked(
          Effect.gen(function* () {
            yield* appendActivity({ ...entry, decision: "allowed" });
            if (entry.target.type === "account") {
              const account = findAccount(entry.target.accountId);
              if (account)
                yield* commit(
                  replaceAccount({
                    ...account,
                    summary: {
                      ...account.summary,
                      lastUsedAt: yield* now,
                      ...(entry.signInOutcome ? { lastSignInOutcome: entry.signInOutcome } : {}),
                    },
                  }),
                  true,
                );
            }
          }),
        ).pipe(Effect.ignore, Effect.forkIn(serviceScope), Effect.asVoid),
      ),
    });
    return service;
  }),
);
