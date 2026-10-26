// @effect-diagnostics nodeBuiltinImport:off -- Opaque record ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import {
  ACCOUNT_SECRET_FIELDS,
  AccountId,
  AccountSaveInput,
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
import {
  AccountsService,
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
  authorizationDecision,
  effectiveProfile,
  inScope,
  sameTarget,
  siteMatches,
} from "./AccountDecisions.ts";
import { parsePasswordImport } from "./PasswordImport.ts";

const failure = (reason: AccountsError["reason"], message: string) =>
  new AccountsError({ reason, message });
const missing = () => failure("not-found", "The account no longer exists.");
const valueName = () => `accounts-value-${NodeCrypto.randomUUID()}`;
const decodeSave = Schema.decodeEffect(AccountSaveInput);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const safeDetail = (detail: string | undefined) => {
  if (!detail) return undefined;
  try {
    return new URL(detail).origin;
  } catch {
    return /^[A-Z]{3,7} [a-z0-9.-]+(?::\d+)?$/.test(detail) ? detail.slice(0, 200) : undefined;
  }
};

export const layer = Layer.effect(
  AccountsService,
  Effect.gen(function* () {
    const persistence = yield* AccountPersistence;
    const sources = yield* AccountSources;
    const vault = yield* AccountVault;
    const serviceScope = yield* Scope.Scope;
    const writes = yield* Semaphore.make(1);
    const events = yield* PubSub.sliding<AccountsSnapshot>({ capacity: 1, replay: 1 });
    let state: AccountsState = emptyState;
    let recentActivity: ReadonlyArray<AccountActivityEntry> = [];
    let initialized = false;
    let protection: "keychain" | "file" = "file";
    let onePasswordClient: OnePasswordClient | undefined;
    const cache = new Map<
      string,
      { until: number; values: Map<string, Redacted.Redacted<string>> }
    >();
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
      return {
        agentAccess: state.agentAccess,
        accounts: state.accounts.map((account) => account.summary),
        profiles: state.profiles,
        stores: {
          scient: { protection },
          keychain: { available: protection === "keychain", platform: sources.platform },
          onePassword: state.onePasswordStatus,
        },
        approvals: [...pending.values()].map((entry) => entry.approval),
        recentActivity,
        customModelKeys,
      } satisfies AccountsSnapshot;
    });
    const publish = Effect.gen(function* () {
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
      yield* publish;
    });
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      writes.withPermits(1)(Effect.uninterruptible(initialize.pipe(Effect.andThen(effect))));
    const commit = Effect.fn("AccountsService.commit")(function* (next: AccountsState) {
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
      yield* publish;
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
      yield* publish;
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
      const write = Effect.gen(function* () {
        for (const [field, change] of Object.entries(input.secrets)) {
          delete values[field];
          if (change.type === "clear") {
            delete secrets[field];
            continue;
          }
          if (change.type === "scient") {
            const name = valueName();
            yield* persistence.write(name, Redacted.make(new TextEncoder().encode(change.value)));
            values[field] = name;
            secrets[field] = {
              source: { type: "scient" },
              ...(input.details.kind === "api-key" && change.value.length > 4
                ? { hint: change.value.slice(-4) }
                : {}),
            };
          } else secrets[field] = { source: change };
        }
        const summary: AccountSummary = {
          accountId,
          name: input.name,
          details: input.details,
          secrets,
          controls:
            input.controls ??
            existing?.summary.controls ??
            defaultAccountControls(input.details.kind),
          status: "ready",
          createdAt: existing?.summary.createdAt ?? timestamp,
          updatedAt: timestamp,
          ...(existing?.summary.lastUsedAt ? { lastUsedAt: existing.summary.lastUsedAt } : {}),
        };
        yield* commit(replaceAccount({ summary, values }));
      });
      yield* write;
      cache.delete(accountId);
      yield* removeValues(
        Object.values(existing?.values ?? {}).filter(
          (name) => !Object.values(values).includes(name),
        ),
      );
      yield* denyRevoked;
      return { accountId };
    });

    const service = AccountsService.of({
      snapshot: locked(snapshotNow),
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
            const { statusMessage: _, ...summary } = existing.summary;
            yield* commit(
              replaceAccount({
                ...existing,
                summary: {
                  ...summary,
                  status: result._tag === "Success" ? "ready" : "needs-attention",
                  ...(result._tag === "Failure" ? { statusMessage: result.failure.message } : {}),
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
                  existing.summary.name === entry.name &&
                  details.kind === "website" &&
                  details.loginUrl === entry.loginUrl &&
                  (input.profileId === undefined || details.profileId === input.profileId) &&
                  current.password &&
                  Redacted.value(current.password) === entry.password &&
                  (current.totp ? Redacted.value(current.totp) : undefined) === entry.totp
                ) {
                  result.skipped++;
                  continue;
                }
              }
              yield* save({
                ...(existing ? { accountId: existing.summary.accountId } : {}),
                name: entry.name,
                details: {
                  kind: "website",
                  sites: [entry.site],
                  username: entry.username,
                  loginUrl: entry.loginUrl,
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
                  if (source?.type === "1password" && source.reference.endsWith("?attribute=otp"))
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
                    .filter(
                      (account) =>
                        account.controls.access !== "off" &&
                        inScope(account.controls.scope, scope.projectId),
                    )
                : [],
              profiles: state.agentAccess
                ? profiles
                    .map((id) => effectiveProfile(state.profiles, id))
                    .filter(
                      (profile) =>
                        profile.access !== "off" && inScope(profile.scope, scope.projectId),
                    )
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
                const decision = authorizationDecision(state.agentAccess, controls, scope);
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
                yield* publish;
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
                        yield* publish;
                      }),
                    ),
                  )
                  .pipe(Effect.ignore),
              ),
            );
          }),
        );
      }),
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
                    summary: { ...account.summary, lastUsedAt: yield* now },
                  }),
                );
            }
          }),
        ).pipe(Effect.ignore, Effect.forkIn(serviceScope), Effect.asVoid),
      ),
    });
    return service;
  }),
);
