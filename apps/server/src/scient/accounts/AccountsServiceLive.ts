// @effect-diagnostics nodeBuiltinImport:off -- Opaque record ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import * as Equal from "effect/Equal";
import {
  ACCOUNTS_PROTOCOL,
  GOOGLE_SITE,
  ACCOUNT_SECRET_FIELDS,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  AccountId,
  acceptsCustomModelKey,
  type CustomModelProtocol,
  AccountSaveInput,
  AccountMatchSignInInput,
  AccountsError,
  defaultAccountControls,
  type AccountActivityEntry,
  type AccountApproval,
  type AccountHandoff,
  type AccountSignInAttempt,
  type PaperQueueSummary,
  type AccountApprovalDecision,
  type AccountControls,
  type AccountSecretSummary,
  type AccountsSnapshot,
  type AccountSummary,
  isCustomModelAccountOrigin,
  isSpeechAccountOrigin,
  type AccountTarget,
  type BrowserProfileId,
  type BrowserProfileRecord,
  type AccountValueSource,
  type AccountWriteStore,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import {
  Cache,
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Redacted,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { GitHubSourceControlCredential } from "../extensions/connectors/GitHubSourceControlCredential.ts";
import {
  AccountsService,
  fail,
  SPEECH_KEY_OUTSIDE_PROJECT,
  type AccountKeyConsumer,
  type AccountSessionScope,
  type AccountAuthorization,
} from "./AccountsService.ts";
import { withoutProfile, withProfileAsMain, withThreadChoice } from "./profileChoices.ts";
import {
  mainRowFor,
  withMainSignOutsCleared,
  withRowsIntoMain,
  withSignedOutSite,
} from "./mainRecord.ts";
import { SignInAttempts } from "./agent/signInAttempts.ts";
import { clientProfile, issueJar, issueUnit, withSendLog, withShared } from "./sendLog.ts";
import { AccountVault } from "./AccountVault.ts";
import {
  AccountPersistence,
  AccountsState,
  Activity,
  decodePrivateJson,
  withStoredAccountsFolded,
  encodeAccountsState,
  customModelEscrowName,
  emptyState,
  encodePrivateJson,
  type StoredAccount,
} from "./AccountPersistence.ts";
import { AccountSources, type OnePasswordClient } from "./AccountSources.ts";
import {
  GOOGLE_RECHECK_WRITE_MS,
  isGoogleSessionRow,
  withSignIn,
  applyApprovalDecision,
  agentAccessOff,
  authorizationDecision,
  effectiveProfile,
  inScope,
  sameTarget,
  siteMatches,
  outcomeSignInState,
} from "./AccountDecisions.ts";
import { accountTokenRef, boundAccountId } from "./AccountBoundRef.ts";
import { planSecretStores, type CopyDestination } from "./copyPlan.ts";
import { parsePasswordImport } from "./PasswordImport.ts";
import { parseTotp } from "./signIn/totp.ts";
import { universityDetails } from "@t3tools/shared/scientPaperLinks";

const missing = () => fail("not-found", "The account no longer exists.");
/** Offline, Accounts still opens: GitHub's own answer is left out after this long. */
const GITHUB_IDENTITY_TIMEOUT = Duration.seconds(12);

/** A removed profile's sign-ins ended with it; a saved password stays, free of the profile. */
const withoutProfileSignIns = (accounts: ReadonlyArray<StoredAccount>, profileId: string) =>
  accounts.flatMap((account) => {
    const { details, secrets } = account.summary;
    if (!("profileId" in details) || details.profileId !== profileId) return [account];
    if (Object.keys(secrets).length === 0) return [];
    const { profileId: _, ...rest } = details;
    return [{ ...account, summary: { ...account.summary, details: rest } }];
  });
/** The secrets with the saved password, if any, marked as having just worked. */
const verifiedPassword = (secrets: AccountSummary["secrets"], at: string) => {
  const password = secrets["password"];
  return password ? { ...secrets, password: { ...password, verifiedAt: at } } : secrets;
};

const valueName = () => `accounts-value-${NodeCrypto.randomUUID()}`;
const decodeSave = Schema.decodeEffect(AccountSaveInput);
const decodeMatch = Schema.decodeEffect(AccountMatchSignInInput);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const safeDetail = (detail: string | undefined) => {
  if (!detail) return undefined;
  try {
    return new URL(detail).origin;
  } catch {
    return /^[A-Z]{3,7} [a-z0-9.-]+(?::\d+)?$/.test(detail) ||
      pluginKeyDetail.test(detail) ||
      speechKeyDetail.test(detail)
      ? detail.slice(0, 200)
      : undefined;
  }
};
const speechKeyDetail =
  /^Speech (?:compatible|openai|xai|openrouter) [\p{L}\p{N}\p{M}[\]-]{1,160}$/u;
const pluginKeyDetail = /^plugin [\w@./:-]{1,100} [A-Za-z_]\w{0,63} on [\w.-]{1,24}$/;
/** Plugin keys name the plugin, variable and agent; connectors name the site. */
const consumerActivity = (consumer: AccountKeyConsumer) =>
  consumer.kind === "connector"
    ? { detail: consumer.origin }
    : {
        detail:
          consumer.kind === "plugin-key"
            ? `plugin ${consumer.pluginId} ${consumer.envName} on ${consumer.agent}`
            : `connector ${consumer.connector} ${consumer.key}`,
        ...(consumer.projectId ? { projectId: consumer.projectId } : {}),
      };

export const layer = Layer.effect(
  AccountsService,
  Effect.gen(function* () {
    const persistence = yield* AccountPersistence;
    const sources = yield* AccountSources;
    const signInAttempts = yield* SignInAttempts;
    const cliStores = sources.passwordStores;
    const vault = yield* AccountVault;
    const serviceScope = yield* Scope.Scope;
    const sourceControl = yield* Effect.serviceOption(SourceControlProviderRegistry);
    const githubCredential = yield* Effect.serviceOption(GitHubSourceControlCredential);
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
    const handoffs = new Map<string, AccountHandoff>();
    const attempts = new Map<string, AccountSignInAttempt>();
    const paperQueues = new Map<string, PaperQueueSummary>();
    // In memory only, never trimmed while the server runs: a forgotten entry would expose a filled
    // page. The account autofill put into a tab, keyed by thread and tab.
    const filledTabs = new Map<string, { accountId: AccountId; url: string }>();
    const handoffReveals = new Map<string, Effect.Effect<void, AccountsError>>();
    const cancelledHandoffs = new Set<string>();
    const pending = new Map<
      string,
      {
        approval: AccountApproval;
        scope: AccountSessionScope;
        answer: Deferred.Deferred<AccountApprovalDecision>;
      }
    >();

    // Discovery runs the GitHub CLI and optional /user lookup: keep it off snapshots and the write
    // semaphore, probe only GitHub (never unrelated forges like Azure), and cache complete results
    // for 1 minute without pinning timed-out or failed credential lookups.
    const externalIdentitiesCache = yield* Cache.makeWith(
      (_key: "github") =>
        Effect.gen(function* () {
          const github = Option.isSome(sourceControl)
            ? Option.getOrUndefined(
                yield* sourceControl.value.discoverProvider(
                  SourceControlProviderKind.make("github"),
                ),
              )
            : undefined;
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
          // Source Control's own choice first, as GitHub names it; then gh's other logins.
          const effectiveProbe = Option.isSome(githubCredential)
            ? yield* githubCredential.value.get("github.com").pipe(
                Effect.timeoutOption(GITHUB_IDENTITY_TIMEOUT),
                Effect.map((timed) =>
                  Option.isSome(timed)
                    ? { effective: timed.value, complete: true }
                    : { effective: Option.none(), complete: false },
                ),
                Effect.orElseSucceed(() => ({ effective: Option.none(), complete: false })),
              )
            : { effective: Option.none(), complete: true };
          const { effective, complete } = effectiveProbe;
          const githubRows = [
            ...Option.toArray(effective).map((credential) => ({
              host: "github.com",
              account: credential.login,
              via: credential.via === "cli" ? ("gh" as const) : credential.via,
            })),
            ...githubAccounts
              .filter(
                (account) =>
                  !Option.exists(
                    effective,
                    (credential) =>
                      account.host.toLowerCase() === "github.com" &&
                      account.account.toLowerCase() === credential.login.toLowerCase(),
                  ),
              )
              .map((account) => ({ ...account, via: "gh" as const })),
          ];
          return {
            complete,
            identities: githubRows.map((account) => ({
              kind: "github" as const,
              id: `${account.host.toLowerCase()}:${account.account.toLowerCase()}`,
              name: account.account,
              detail: account.host,
              href: "/settings/source-control" as const,
              via: account.via,
            })) satisfies NonNullable<AccountsSnapshot["managedElsewhere"]>,
          };
        }),
      {
        capacity: 1,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.complete ? Duration.minutes(1) : Duration.zero,
      },
    );
    const externalIdentities = Cache.get(externalIdentitiesCache, "github");
    const readModelConsumers = sources.modelCatalog?.connections ?? Effect.succeed([]);
    const readTranscriptionConsumers = sources.transcriptionKeyConsumers ?? Effect.succeed([]);
    const snapshotNow = Effect.gen(function* () {
      const customModelKeys = yield* sources.customModelKeys.pipe(Effect.orElseSucceed(() => []));
      const connections = yield* readModelConsumers.pipe(Effect.result);
      const transcription = yield* readTranscriptionConsumers.pipe(Effect.result);
      const modelConsumers =
        connections._tag === "Success"
          ? connections.success.flatMap(({ accountId, id, name }) =>
              accountId ? [{ accountId, id, name, kind: "custom-model" as const }] : [],
            )
          : [];
      const unavailableCustomModelKeyIds: string[] = [];
      for (const connection of connections._tag === "Success" ? connections.success : []) {
        if (!connection.accountId) continue;
        const origin = URL.canParse(connection.baseUrl) ? new URL(connection.baseUrl).origin : "";
        const readable = yield* modelAccountKey(
          connection.accountId,
          origin,
          connection.protocol,
        ).pipe(Effect.option);
        if (Option.isNone(readable)) unavailableCustomModelKeyIds.push(connection.id);
      }
      const transcriptionConsumers = transcription._tag === "Success" ? transcription.success : [];
      const keyConsumersIncomplete =
        connections._tag === "Failure" || transcription._tag === "Failure";
      const migratedIds = new Set(modelConsumers.map(({ id }) => id));
      const managedElsewhere: NonNullable<AccountsSnapshot["managedElsewhere"]> = customModelKeys
        .filter(({ connectionId }) => !migratedIds.has(connectionId))
        .map((connection) => ({
          kind: "custom-model" as const,
          id: connection.connectionId,
          name: connection.name,
          detail: connection.origin,
          href: "/settings/custom-models" as const,
        }));
      return {
        agentAccess: state.agentAccess,
        accounts: state.accounts.map((account) => account.summary),
        profiles: state.profiles.map(clientProfile),
        ...(state.profileChoices ? { profileChoices: state.profileChoices } : {}),
        ...(state.codeSources ? { codeSources: state.codeSources } : {}),
        ...(state.keyLinks ? { keyLinks: state.keyLinks } : {}),
        ...(state.detachedKeyLinks ? { detachedKeyLinks: state.detachedKeyLinks } : {}),
        stores: {
          scient: { protection },
          keychain: { available: protection === "keychain", platform: sources.platform },
          onePassword: state.onePasswordStatus,
          cli: cliStores.statuses(),
        },
        handoffs: [...handoffs.values()],
        attempts: [...attempts.values()],
        paperQueues: [...paperQueues.values()],
        approvals: [...pending.values()].map((entry) => entry.approval),
        recentActivity,
        customModelKeys,
        unavailableCustomModelKeyIds,
        keyConsumers: [...modelConsumers, ...transcriptionConsumers],
        ...(keyConsumersIncomplete ? { keyConsumersIncomplete: true } : {}),
        managedElsewhere,
        accountsProtocol: ACCOUNTS_PROTOCOL,
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
        ? yield* decodePrivateJson(AccountsState, withStoredAccountsFolded(saved.value))
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
    /**
     * Set while a bulk change runs: commits only update `state`, written and published once at the
     * end, and replaced values are removed only after that write.
     */
    let batch: { dirty: boolean; removals: Array<string> } | undefined;
    const commit = Effect.fn("AccountsService.commit")(function* (
      proposed: AccountsState,
      usageOnly = false,
      previousAccounts: readonly StoredAccount[] = state.accounts,
    ) {
      // Every path that records a sign-in passes here, in the same locked write.
      const candidate = withSendLog(state, withMainSignOutsCleared(state, proposed));
      const expiredEscrows = (candidate.customModelEscrows ?? []).filter(
        (row) =>
          !candidate.accounts.some(
            ({ summary, values }) =>
              summary.accountId === row.accountId && values.token === row.tokenRef,
          ),
      );
      const next = expiredEscrows.length
        ? {
            ...candidate,
            customModelEscrows:
              candidate.customModelEscrows?.filter((row) => !expiredEscrows.includes(row)) ?? [],
          }
        : candidate;
      // Invalidate before the first write: cache hits must not bypass an in-flight revocation.
      if (!usageOnly) bindingRevision++;
      if (batch) {
        state = candidate;
        batch.dirty = true;
        return;
      }
      yield* persistence.write("accounts-state", yield* encodeAccountsState(next)).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            initialized = false;
          }),
        ),
      );
      state = next;
      for (const escrow of expiredEscrows) {
        yield* persistence
          .remove(customModelEscrowName(escrow.legacyId))
          .pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "Could not remove an expired Custom models escrow. Cleanup will retry.",
              ),
            ),
          );
        yield* (
          sources.modelCatalog
            ?.removeLegacy(escrow.legacyId)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not remove a restored Custom models slot."),
              ),
            ) ?? Effect.void
        );
      }
      const invalidate = sources.modelCatalog?.invalidate;
      if (invalidate && !usageOnly) {
        const current = new Map(next.accounts.map((row) => [row.summary.accountId, row]));
        const changed = new Set(
          previousAccounts.flatMap((before) => {
            const id = before.summary.accountId;
            if (before.summary.details.kind !== "api-key") return [];
            const after = current.get(id);
            return !after ||
              before.values.token !== after.values.token ||
              !Equal.equals(before.summary.details, after.summary.details) ||
              !Equal.equals(
                before.summary.secrets.token?.source,
                after.summary.secrets.token?.source,
              )
              ? [id]
              : [];
          }),
        );
        if (changed.size) yield* invalidate(changed, NodeCrypto.randomUUID());
      }
      yield* publish(!usageOnly);
    });
    // One write for hundreds of imported passwords; each commit rebuilt and sent the whole snapshot.
    const batched = Effect.fn("AccountsService.batched")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      const previousAccounts = state.accounts;
      const current = { dirty: false, removals: new Array<string>() };
      batch = current;
      const exit = yield* Effect.exit(effect);
      batch = undefined;
      if (current.dirty) yield* commit(state, false, previousAccounts);
      yield* removeValues(current.removals);
      return yield* exit;
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
    const speechOnly = (account: Pick<AccountSummary, "details">) =>
      account.details.kind === "api-key" && account.details.speechOnly === true;
    const privateModelKey = ({ details, controls }: AccountSummary) =>
      details.kind === "api-key" &&
      details.purpose === "custom-models" &&
      controls.access === "off";

    const targetControls = (target: AccountTarget) => {
      if (target.type === "account") {
        const summary = findAccount(target.accountId)?.summary;
        return summary && !speechOnly(summary) ? summary.controls : undefined;
      }
      const record = effectiveProfile(state.profiles, target.profileId);
      // Merged into Main: no agent uses it, whatever its controls were.
      return record.retired ? { ...record, access: "off" as const } : record;
    };
    const withProfile = (
      profileId: BrowserProfileId,
      change: (record: BrowserProfileRecord) => BrowserProfileRecord,
      profiles = state.profiles,
    ) => {
      const record = change(effectiveProfile(profiles, profileId));
      return {
        record,
        state: {
          ...state,
          profiles: [...profiles.filter((profile) => profile.profileId !== profileId), record],
        },
      };
    };
    /** A revision for the profile, committed on its own inside the caller's lock. */
    const issue = Effect.fn("AccountsService.issue")(function* (
      profileId: BrowserProfileId,
      change: (log: BrowserProfileRecord["send"]) => NonNullable<BrowserProfileRecord["send"]>,
      profiles = state.profiles,
    ) {
      const next = withProfile(
        profileId,
        // Merged into Main: nothing more goes out for it, and nothing is taken back.
        (record) => (record.retired ? record : { ...record, send: change(record.send) }),
        profiles,
      );
      yield* commit(next.state, true);
      return next.record.send?.head ?? 0;
    });
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
      if (batch) {
        batch.removals.push(...names);
        return;
      }
      for (const name of names) yield* persistence.remove(name).pipe(Effect.ignore);
    });
    const readValue = Effect.fn("AccountsService.readValue")(function* (name: string | undefined) {
      if (!name) return yield* fail("unavailable", "Stored account value is missing.");
      const stored = yield* persistence.read(name);
      if (Option.isNone(stored))
        return yield* fail("unavailable", "Stored account value is missing.");
      return Redacted.make(new TextDecoder().decode(Redacted.value(stored.value)));
    });
    const getOnePasswordClient = Effect.gen(function* () {
      if (onePasswordClient) return onePasswordClient;
      const config = state.onePassword;
      if (!config) return yield* fail("unavailable", "1Password is not connected.");
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
    const modelAccountKey = Effect.fn("AccountsService.modelAccountKey")(function* (
      accountId: AccountId,
      origin: string,
      protocol: CustomModelProtocol = "openai-completions",
      staged = false,
    ) {
      const account =
        findAccount(accountId) ?? (staged ? state.pendingCustomModelKeys?.[accountId] : undefined);
      if (!account) return yield* missing();
      if (!acceptsCustomModelKey(account.summary, origin, protocol))
        return yield* fail("denied", "Choose a saved API key for this exact endpoint.");
      const value = yield* readValue(account.values.token);
      const key = Redacted.value(value).trim();
      if (!key || key.length > 16384 || /[\r\n\0]/u.test(key))
        return yield* fail("unavailable", "The saved API key is unavailable.");
      return { name: account.summary.name, token: Redacted.make(key) };
    });
    const legacyModelKey = (connectionId: string) => sources.customModel(connectionId);

    const migrateModelKeys = locked(
      Effect.gen(function* () {
        const catalog = sources.modelCatalog;
        if (!catalog) return;
        const setPending = (id: AccountId, row: StoredAccount | undefined, promote = false) => {
          const pending = { ...state.pendingCustomModelKeys };
          const staged = pending[id];
          if (row) pending[id] = row;
          else delete pending[id];
          return commit({
            ...state,
            pendingCustomModelKeys: pending,
            accounts: promote && staged ? [...state.accounts, staged] : state.accounts,
          });
        };
        const retireModelAliases = Effect.fn("AccountsService.retireModelAliases")(function* (
          connectionId: string,
          targetId?: AccountId,
        ) {
          const retired = state.accounts.filter(({ summary }) => {
            const token = summary.secrets.token;
            return (
              summary.details.kind === "api-key" &&
              token?.source.type === "custom-model" &&
              token.source.connectionId === connectionId &&
              !token.copies?.length
            );
          });
          if (retired.length) {
            const retiredIds = new Set(retired.map(({ summary }) => summary.accountId));
            const detached = targetId
              ? []
              : (state.keyLinks ?? []).filter(({ accountId }) => retiredIds.has(accountId));
            yield* commit({
              ...state,
              accounts: state.accounts.filter(({ summary }) => !retiredIds.has(summary.accountId)),
              ...(state.keyLinks
                ? {
                    keyLinks: state.keyLinks.flatMap((link) =>
                      !retiredIds.has(link.accountId)
                        ? [link]
                        : targetId
                          ? [{ ...link, accountId: targetId }]
                          : [],
                    ),
                  }
                : {}),
              ...(detached.length
                ? { detachedKeyLinks: [...(state.detachedKeyLinks ?? []), ...detached].slice(-100) }
                : {}),
            });
          }
        });
        const connections = yield* catalog.connections;
        const migrationHashFor = (id: string, legacyId: string) =>
          NodeCrypto.createHash("sha256")
            .update(id + ":" + legacyId)
            .digest("hex");
        const migrationAccountId = (hash: string) =>
          AccountId.make(`acc_model_${hash.slice(0, 48)}`);
        const pendingIds = new Set(
          connections.flatMap(({ id, accountId, credentialId }) =>
            credentialId
              ? [accountId ?? migrationAccountId(migrationHashFor(id, credentialId))]
              : [],
          ),
        );
        const pending = state.pendingCustomModelKeys ?? {};
        const discarded = Object.entries(pending).filter(
          ([id]) => !pendingIds.has(AccountId.make(id)) || findAccount(AccountId.make(id)),
        );
        if (discarded.length) {
          const unused = { ...pending };
          for (const [id] of discarded) delete unused[id];
          const live = new Set(state.accounts.flatMap(({ values }) => Object.values(values)));
          yield* commit({ ...state, pendingCustomModelKeys: unused });
          yield* removeValues(
            discarded.flatMap(([, row]) =>
              Object.values(row.values).filter((ref) => !live.has(ref)),
            ),
          );
        }
        const migrateConnection = Effect.fn("AccountsService.migrateModelKey")(function* (
          connection: (typeof connections)[number],
        ) {
          const legacyId = connection.credentialId;
          if (!legacyId) {
            if (connection.accountId) {
              const original =
                state.migratedModelAccounts?.[connection.id] ??
                state.customModelEscrows?.find(({ connectionId }) => connectionId === connection.id)
                  ?.accountId;
              yield* retireModelAliases(
                connection.id,
                original === connection.accountId && findAccount(original) ? original : undefined,
              );
            }
            return;
          }
          if (yield* catalog.requiresDedicated?.(connection) ?? Effect.succeed(false)) return;
          const origin = URL.canParse(connection.baseUrl) ? new URL(connection.baseUrl).origin : "";
          if (!isCustomModelAccountOrigin(origin)) return;
          const migrationHash = migrationHashFor(connection.id, legacyId);
          const accountId = connection.accountId ?? migrationAccountId(migrationHash);
          if (!connection.accountId) {
            if (!findAccount(accountId) && !state.pendingCustomModelKeys?.[accountId]) {
              const key = yield* catalog.readLegacy(connection);
              if (!key) return;
              const valueRef = `accounts-value-${migrationHash.slice(0, 8)}-${migrationHash.slice(8, 12)}-${migrationHash.slice(12, 16)}-${migrationHash.slice(16, 20)}-${migrationHash.slice(20, 32)}`;
              yield* persistence.write(
                valueRef,
                Redacted.make(new TextEncoder().encode(Redacted.value(key))),
              );
              const written = yield* readValue(valueRef);
              if (Redacted.value(written) !== Redacted.value(key))
                return yield* fail("unavailable", "Could not verify the migrated key.");
              const timestamp = yield* now;
              yield* setPending(accountId, {
                summary: {
                  accountId,
                  name: connection.name,
                  details: {
                    kind: "api-key",
                    purpose: "custom-models",
                    sites: [origin],
                    auth:
                      connection.protocol === "anthropic-messages"
                        ? { type: "header", name: "x-api-key" }
                        : { type: "bearer" },
                  },
                  secrets: { token: { source: { type: "scient" } } },
                  status: "ready",
                  controls: { ...defaultAccountControls("api-key"), access: "off" },
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
                values: { token: valueRef },
              });
            }
            yield* modelAccountKey(accountId, origin, connection.protocol, true);
            if (!(yield* catalog.setBinding(connection, { accountId, credentialId: legacyId }))) {
              const staged = state.pendingCustomModelKeys?.[accountId];
              yield* setPending(accountId, undefined);
              if (staged) yield* removeValues(Object.values(staged.values));
              return;
            }
          }
          if (state.pendingCustomModelKeys?.[accountId]) {
            yield* modelAccountKey(accountId, origin, connection.protocol, true);
            yield* setPending(accountId, undefined, true);
          }
          const migrated = findAccount(accountId);
          const sameLineage =
            accountId === migrationAccountId(migrationHash) && migrated !== undefined;
          if (sameLineage && state.migratedModelAccounts?.[connection.id] !== accountId)
            yield* commit({
              ...state,
              migratedModelAccounts: { ...state.migratedModelAccounts, [connection.id]: accountId },
            });
          yield* retireModelAliases(connection.id, sameLineage ? accountId : undefined);
          const tokenRef = migrated?.values.token;
          if (tokenRef && !state.customModelEscrows?.some((row) => row.legacyId === legacyId)) {
            const legacy = yield* catalog.readLegacy({ ...connection, credentialId: legacyId });
            const current = yield* readValue(tokenRef);
            if (legacy && Redacted.value(legacy) === Redacted.value(current)) {
              yield* persistence.write(
                customModelEscrowName(legacyId),
                Redacted.make(new TextEncoder().encode(Redacted.value(legacy))),
              );
              yield* commit({
                ...state,
                customModelEscrows: [
                  ...(state.customModelEscrows ?? []),
                  {
                    accountId,
                    connectionId: connection.id,
                    legacyId,
                    baseUrl: connection.baseUrl,
                    protocol: connection.protocol,
                    tokenRef,
                  },
                ],
              });
            }
          }
          yield* catalog.removeLegacy(legacyId);
          yield* catalog.setBinding(
            { ...connection, accountId },
            { accountId, credentialId: null },
          );
        });
        for (const connection of connections)
          yield* migrateConnection(connection).pipe(
            Effect.catch(() =>
              Effect.logWarning(
                "A Custom models key migration could not be completed. It will be retried.",
              ),
            ),
          );
        const liveEscrows = new Set(
          (state.customModelEscrows ?? []).map(({ legacyId }) => customModelEscrowName(legacyId)),
        );
        const onDisk = yield* persistence.listModelEscrows.pipe(
          Effect.catch(() =>
            Effect.logWarning("Could not list Custom models escrows for cleanup.").pipe(
              Effect.as([]),
            ),
          ),
        );
        for (const name of onDisk) {
          if (!liveEscrows.has(name))
            yield* persistence
              .remove(name)
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning(
                    "Could not remove an orphaned Custom models escrow. Cleanup will retry.",
                  ),
                ),
              );
        }
      }),
    );
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
            result[field] = yield* legacyModelKey(source.connectionId);
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
    const save = Effect.fn("AccountsService.save")(function* (
      input: AccountSaveInput,
      migrationId?: AccountId,
    ) {
      const existing = input.accountId ? findAccount(input.accountId) : undefined;
      if (input.accountId && !existing) return yield* missing();
      const isSpeech = speechOnly(input);
      const tokenInput = input.secrets.token;
      if (
        (existing && speechOnly(existing.summary) !== isSpeech) ||
        (isSpeech &&
          input.details.kind === "api-key" &&
          (!input.details.sites.every(isSpeechAccountOrigin) ||
            input.details.auth.type !== "bearer" ||
            input.details.envName ||
            input.details.keptFrom ||
            (tokenInput &&
              tokenInput.type !== "clear" &&
              (tokenInput.type !== "scient" || tokenInput.saveTo?.length))))
      )
        return yield* fail("invalid-input", "Speech accounts use only the Scient sealed vault.");
      const permitted =
        input.details.kind === "cli-login"
          ? input.details.variables
              .filter((variable) => variable.secret)
              .map((variable) => variable.name)
          : ACCOUNT_SECRET_FIELDS[input.details.kind];
      if (Object.keys(input.secrets).some((field) => !permitted.includes(field)))
        return yield* fail("invalid-input", "This secret field is not valid for the account kind.");
      const timestamp = yield* now;
      const accountId =
        existing?.summary.accountId ??
        migrationId ??
        AccountId.make(`acc_${NodeCrypto.randomUUID()}`);
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
        if (
          change.type === "custom-model" &&
          sources.modelCatalog &&
          !(yield* sources.customModelKeys).some(
            ({ connectionId }) => connectionId === change.connectionId,
          )
        )
          return yield* fail("invalid-input", "Choose the saved API key directly in Accounts.");
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
              ? yield* legacyModelKey(change.connectionId)
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
            ...(input.details.kind === "api-key" && !isSpeech && Redacted.value(value).length > 4
              ? { hint: Redacted.value(value).slice(-4) }
              : {}),
            ...(change.type === "scient" && change.changedAt
              ? { changedAt: change.changedAt }
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
          (input.details.kind === "api-key" &&
          (input.details.purpose === "custom-models" || isSpeech)
            ? { ...defaultAccountControls("api-key"), access: "off" as const }
            : defaultAccountControls(input.details.kind)),
        status:
          warnings.length || Object.values(pendingCopies).some((targets) => targets.length)
            ? "needs-attention"
            : "ready",
        ...(warnings.length ? { statusMessage: warnings[0] } : {}),
        // A new password, code or key is untried: what the old one met no longer applies. On a
        // website that is the user's reset of a held sign-in, so it is written as an action.
        ...(!input.secrets?.password && !input.secrets?.totp && !input.secrets?.token
          ? existing?.summary.signIn
            ? { signIn: existing.summary.signIn }
            : {}
          : existing && input.details.kind === "website"
            ? {
                signIn: {
                  state: "unknown" as const,
                  at: timestamp,
                  detail: "Password changed",
                  by: "action" as const,
                },
              }
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
                    return yield* fail("denied", "1Password vault is read-only.");
                  const client = yield* getOnePasswordClient;
                  if ("reference" in destination) {
                    if (!client.write)
                      return yield* fail("unsupported", "1Password writes are unavailable.");
                    yield* client.write(destination.reference, value);
                    return destination;
                  }
                  if (!client.createLogin)
                    return yield* fail("unsupported", "1Password writes are unavailable.");
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
      const account = findAccount(accountId)?.summary;
      return {
        accountId,
        ...(account ? { account } : {}),
        ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
      };
    });

    const migrateOnUse = migrateModelKeys.pipe(Effect.ignore);
    const service = AccountsService.of({
      migrateCustomModelKeys: migrateOnUse,
      redactionValues: Effect.gen(function* () {
        const values: Array<Redacted.Redacted<string>> = [];
        for (const account of state.accounts) {
          for (const [field, secret] of Object.entries(account.summary.secrets)) {
            const source: AccountValueSource = secret.source;
            const value =
              source.type === "scient"
                ? readValue(account.values[field])
                : source.type === "custom-model"
                  ? legacyModelKey(source.connectionId)
                  : undefined;
            if (value === undefined) continue;
            const read = yield* value.pipe(Effect.option);
            if (Option.isSome(read)) values.push(read.value);
          }
        }
        return values;
      }).pipe(Effect.withSpan("AccountsService.redactionValues")),
      setHandoff: Effect.fn("AccountsService.setHandoff")((handoff, reveal) =>
        locked(
          Effect.gen(function* () {
            if (cancelledHandoffs.has(handoff.handoffId)) return;
            handoffs.set(handoff.handoffId, handoff);
            if (reveal) handoffReveals.set(handoff.handoffId, reveal);
            yield* publish(false);
          }),
        ),
      ),
      removeHandoff: Effect.fn("AccountsService.removeHandoff")((handoffId) =>
        locked(
          Effect.gen(function* () {
            handoffs.delete(handoffId);
            handoffReveals.delete(handoffId);
            cancelledHandoffs.delete(handoffId);
            yield* publish(false);
          }),
        ).pipe(Effect.ignore),
      ),
      attempts: Effect.sync(() => [...attempts.values()]),
      setAttempt: Effect.fn("AccountsService.setAttempt")((attempt) =>
        locked(
          Effect.gen(function* () {
            attempts.set(attempt.attemptId, attempt);
            yield* publish(false);
          }),
        ).pipe(Effect.ignore),
      ),
      removeAttempt: Effect.fn("AccountsService.removeAttempt")((attemptId) =>
        locked(
          Effect.gen(function* () {
            if (attempts.delete(attemptId)) yield* publish(false);
          }),
        ).pipe(Effect.ignore),
      ),
      handoffCancelled: Effect.fn("AccountsService.handoffCancelled")((handoffId) =>
        Effect.sync(() => cancelledHandoffs.has(handoffId)),
      ),
      setPaperQueue: Effect.fn("AccountsService.setPaperQueue")((queue) =>
        locked(
          Effect.gen(function* () {
            paperQueues.set(queue.root, queue);
            yield* publish(false);
          }),
        ).pipe(Effect.ignore),
      ),
      showHandoff: Effect.fn("AccountsService.showHandoff")(function* (handoffId) {
        const reveal = yield* locked(
          Effect.sync(() => (handoffs.has(handoffId) ? handoffReveals.get(handoffId) : undefined)),
        );
        if (!reveal) return yield* fail("not-found", "The sign-in is no longer waiting.");
        yield* reveal;
      }),
      cancelHandoff: Effect.fn("AccountsService.cancelHandoff")((handoffId) =>
        locked(
          Effect.gen(function* () {
            if (!handoffs.has(handoffId))
              return yield* fail("not-found", "The sign-in is no longer waiting.");
            cancelledHandoffs.add(handoffId);
            handoffs.delete(handoffId);
            yield* publish(false);
          }),
        ),
      ),
      snapshot: locked(snapshotNow),
      externalIdentities,
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
            Effect.mapError(() => fail("invalid-input", "Account input is invalid.")),
            Effect.flatMap(save),
          ),
        ),
      ),
      remove: Effect.fn("AccountsService.remove")((accountId) =>
        locked(
          Effect.gen(function* () {
            const existing = findAccount(accountId);
            if (!existing) return yield* missing();
            if (existing.summary.details.kind === "api-key")
              yield* readModelConsumers.pipe(
                Effect.andThen(readTranscriptionConsumers),
                Effect.mapError(() =>
                  fail(
                    "unavailable",
                    "Could not check what uses this key. Try again before removing it.",
                  ),
                ),
              );
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
            if (input.madeInScient) next.madeInScient = input.madeInScient;
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
              accounts: withoutProfileSignIns(state.accounts, profileId),
              profiles: state.profiles.filter((profile) => profile.profileId !== profileId),
              ...(state.profileChoices
                ? { profileChoices: withoutProfile(state.profileChoices, profileId) }
                : {}),
            }),
          ),
        ),
      ),
      retireProfile: Effect.fn("AccountsService.retireProfile")((profileId, change) =>
        locked(
          Effect.gen(function* () {
            const current = effectiveProfile(state.profiles, profileId);
            const profiles = (next: BrowserProfileRecord) => [
              ...state.profiles.filter((profile) => profile.profileId !== profileId),
              next,
            ];
            if (change === "undo") {
              if (!current.retired) return;
              const { retired: _, ...record } = current;
              yield* commit({ ...state, profiles: profiles({ ...record, undone: yield* now }) });
              return;
            }
            // A launch that read the profile before Undo can't merge it again.
            if (current.undone)
              return yield* fail("conflict", "This profile was brought back from Main.");
            yield* commit({
              ...state,
              // Again on a retry: a row named for the profile since joins Main too.
              accounts: withoutProfileSignIns(
                withRowsIntoMain(state.accounts, profileId),
                profileId,
              ),
              profiles: profiles({
                ...current,
                retired: current.retired ?? { at: yield* now, into: "main", name: change.name },
              }),
              ...(state.profileChoices
                ? { profileChoices: withProfileAsMain(state.profileChoices, profileId) }
                : {}),
            });
          }),
        ),
      ),
      mainFilled: Effect.fn("AccountsService.mainFilled")(({ accountId, profileName }) =>
        locked(
          Effect.gen(function* () {
            const source = findAccount(accountId);
            if (!source) return yield* missing();
            const { details } = source.summary;
            // University rows are made in Main by their own sign-in, never by a copy.
            if (details.kind !== "website" || details.institution) return;
            const signIn = {
              state: "unknown" as const,
              at: yield* now,
              detail: `Copied from ${profileName}`,
              by: "look" as const,
              from: "copy" as const,
            };
            const existing = mainRowFor(state.accounts, source.summary);
            if (!existing) {
              const { accountId: created } = yield* save({
                name: source.summary.name,
                details: {
                  kind: "website",
                  sites: details.sites,
                  ...(details.loginUrl ? { loginUrl: details.loginUrl } : {}),
                  ...(details.username === undefined ? {} : { username: details.username }),
                  profileId: DEFAULT_BROWSER_PROFILE_ID,
                  origin: "browser-session",
                },
                secrets: {},
              });
              const row = findAccount(created);
              if (row)
                yield* commit(replaceAccount({ ...row, summary: { ...row.summary, signIn } }));
              yield* issue(DEFAULT_BROWSER_PROFILE_ID, (log) =>
                issueUnit(log, details.sites, "copy"),
              );
              return;
            }
            const main = existing.summary;
            if (main.details.kind !== "website") return;
            const username = main.details.username ?? details.username;
            yield* commit(
              replaceAccount({
                ...existing,
                summary: {
                  ...main,
                  details: {
                    ...main.details,
                    sites: [...new Set([...main.details.sites, ...details.sites])].slice(0, 16),
                    ...(username === undefined ? {} : { username }),
                    // A row with nothing to type is now the copied session; a saved password stays fillable.
                    ...(Object.keys(main.secrets).length === 0
                      ? { origin: "browser-session" as const }
                      : {}),
                  },
                  // A copy says nothing new about a Main session already seen working.
                  ...(main.signIn?.state === "signed-in" ? {} : { signIn }),
                  updatedAt: signIn.at,
                },
              }),
            );
            yield* issue(DEFAULT_BROWSER_PROFILE_ID, (log) =>
              issueUnit(log, details.sites, "copy"),
            );
          }),
        ),
      ),
      mainBackfilled: Effect.fn("AccountsService.mainBackfilled")((profileIds) =>
        locked(
          Effect.suspend(() => {
            const main = effectiveProfile(state.profiles, DEFAULT_BROWSER_PROFILE_ID);
            return commit(
              {
                ...state,
                profiles: [
                  ...state.profiles.filter((profile) => profile.profileId !== main.profileId),
                  {
                    ...main,
                    main: {
                      ...main.main,
                      backfilled: [...new Set([...(main.main?.backfilled ?? []), ...profileIds])],
                    },
                  },
                ],
              },
              true,
            );
          }),
        ),
      ),
      mainFolded: Effect.fn("AccountsService.mainFolded")((profiles) =>
        locked(
          Effect.gen(function* () {
            const main = effectiveProfile(state.profiles, DEFAULT_BROWSER_PROFILE_ID);
            if (main.main?.folded) return;
            yield* commit(
              {
                ...state,
                profiles: [
                  ...state.profiles.filter((profile) => profile.profileId !== main.profileId),
                  { ...main, main: { ...main.main, folded: { at: yield* now, profiles } } },
                ],
              },
              true,
            );
          }),
        ),
      ),
      profileSignedOut: Effect.fn("AccountsService.profileSignedOut")((profileId, site) =>
        locked(
          issue(
            profileId,
            (log) => issueUnit(log, [site], "delete"),
            profileId === DEFAULT_BROWSER_PROFILE_ID
              ? withSignedOutSite(state.profiles, site)
              : state.profiles,
          ),
        ),
      ),
      mainWithdrawn: Effect.fn("AccountsService.mainWithdrawn")((sites) =>
        locked(
          issue(DEFAULT_BROWSER_PROFILE_ID, (log) =>
            issueUnit(log, sites, "delete", { copyOnly: true }),
          ),
        ),
      ),
      profileResend: Effect.fn("AccountsService.profileResend")((profileId) =>
        locked(issue(profileId, issueJar)),
      ),
      profileSendLog: Effect.fn("AccountsService.profileSendLog")((profileId) =>
        locked(
          Effect.sync(
            () => effectiveProfile(state.profiles, profileId).send ?? { head: 0, units: [] },
          ),
        ),
      ),
      profileShared: Effect.fn("AccountsService.profileShared")((profileId, share) =>
        locked(
          Effect.suspend(() =>
            commit(
              withProfile(profileId, (record) => withShared(record, share.environmentId, share))
                .state,
              true,
            ),
          ),
        ),
      ),
      profilesUnshared: Effect.fn("AccountsService.profilesUnshared")((environmentId, forgetKey) =>
        locked(
          Effect.suspend(() =>
            commit(
              {
                ...state,
                ...(state.senderKeys && forgetKey
                  ? {
                      senderKeys: state.senderKeys.filter(
                        (entry) => entry.environmentId !== environmentId,
                      ),
                    }
                  : {}),
                profiles: state.profiles.map((profile) =>
                  profile.sharedWith?.some((entry) => entry.environmentId === environmentId)
                    ? withShared(profile, environmentId, undefined)
                    : profile,
                ),
              },
              true,
            ),
          ),
        ),
      ),
      sessionsSeen: Effect.fn("AccountsService.sessionsSeen")((input) =>
        locked(
          batched(
            Effect.gen(function* () {
              const created: Array<AccountId> = [];
              if (input.profileId === INCOGNITO_BROWSER_PROFILE_ID) return { created };
              const sessionRow = (site: string) =>
                state.accounts.find(
                  ({ summary }) =>
                    summary.details.kind === "website" &&
                    summary.details.profileId === input.profileId &&
                    summary.secrets.password === undefined &&
                    !universityDetails(summary.details) &&
                    !isGoogleSessionRow(summary) &&
                    siteMatches(summary.details.sites, `https://${site}`),
                );
              for (const { site, how, from } of input.sessions) {
                // Google's sessions are its own rows, one per address (`googleSessionsSeen`).
                if (site === GOOGLE_SITE || site.endsWith(`.${GOOGLE_SITE}`)) continue;
                const at = yield* now;
                const row = sessionRow(site);
                if (row) {
                  if (how === "imported") continue;
                  yield* commit(
                    replaceAccount({
                      ...row,
                      summary: withSignIn(
                        row.summary,
                        { state: "signed-in", at },
                        yield* Clock.currentTimeMillis,
                        "attempt",
                      ),
                    }),
                  );
                  continue;
                }
                const { accountId } = yield* save({
                  name: site,
                  details: {
                    kind: "website",
                    sites: [site],
                    profileId: input.profileId,
                    origin: "browser-session",
                  },
                  secrets: {},
                });
                const saved = findAccount(accountId);
                if (!saved) continue;
                const signIn =
                  how === "imported"
                    ? {
                        state: "unknown" as const,
                        at,
                        detail: `Imported from ${from ?? "another browser"}`,
                        by: "look" as const,
                        from: "import" as const,
                      }
                    : { state: "signed-in" as const, at, by: "action" as const };
                yield* commit(replaceAccount({ ...saved, summary: { ...saved.summary, signIn } }));
                created.push(accountId);
              }
              return { created };
            }),
          ),
        ),
      ),
      keepTyped: Effect.fn("AccountsService.keepTyped")((accountId, typed) =>
        locked(
          Effect.gen(function* () {
            const row = findAccount(accountId);
            if (!row || row.summary.details.kind !== "website") return "dropped" as const;
            const { summary } = row;
            const details = summary.details;
            if (summary.controls.access === "off") return "dropped" as const;
            const target = { type: "account", accountId } as const;
            const linked = summary.secrets.password?.source.type;
            if (linked !== undefined && linked !== "scient") {
              yield* appendActivity({
                target,
                action: "sign-in",
                decision: "allowed",
                keptTyped: "linked",
              });
              return "linked" as const;
            }
            yield* save({
              accountId,
              name: summary.name,
              details:
                details.kind === "website" && details.username === undefined && typed.username
                  ? { ...details, username: typed.username }
                  : details,
              secrets: { password: { type: "scient", value: Redacted.value(typed.password) } },
            });
            // The sign-in it came from stands. The password is not verified: nothing showed it was
            // the one that worked, so only a later sign-in where Scient types it verifies it.
            const kept = findAccount(accountId);
            if (kept) {
              const { signIn: _, ...rest } = kept.summary;
              yield* commit(
                replaceAccount({
                  ...kept,
                  summary: { ...rest, ...(summary.signIn ? { signIn: summary.signIn } : {}) },
                }),
              );
            }
            yield* appendActivity({
              target,
              action: "sign-in",
              decision: "allowed",
              keptTyped: "kept",
            });
            return "kept" as const;
          }),
        ),
      ),
      signInAttempts: Effect.succeed(signInAttempts),
      // Nothing stored means no senders: answered without opening the vault or reading Accounts,
      // so a server nobody has used yet starts without touching the keychain or Source Control.
      remoteSenders: Effect.suspend(() =>
        initialized
          ? locked(Effect.sync(() => state.senders ?? []))
          : persistence
              .exists("accounts-state")
              .pipe(
                Effect.flatMap((stored) =>
                  stored ? locked(Effect.sync(() => state.senders ?? [])) : Effect.succeed([]),
                ),
              ),
      ),
      setRemoteSender: Effect.fn("AccountsService.setRemoteSender")((source, sender) =>
        locked(
          Effect.suspend(() =>
            commit(
              {
                ...state,
                senders: [
                  ...(state.senders ?? []).filter((entry) => entry.source !== source),
                  ...(sender ? [sender] : []),
                ],
              },
              true,
            ),
          ),
        ),
      ),
      senderKey: Effect.fn("AccountsService.senderKey")((environmentId) =>
        locked(
          Effect.sync(
            () => state.senderKeys?.find((entry) => entry.environmentId === environmentId)?.key,
          ),
        ),
      ),
      keepSenderKey: Effect.fn("AccountsService.keepSenderKey")((environmentId, key) =>
        locked(
          Effect.suspend(() =>
            commit(
              {
                ...state,
                senderKeys: [
                  ...(state.senderKeys ?? []).filter(
                    (entry) => entry.environmentId !== environmentId,
                  ),
                  { environmentId, key },
                ],
              },
              true,
            ),
          ),
        ),
      ),
      receivedProfiles: locked(
        Effect.sync(() =>
          state.profiles.filter((profile) => profile.received?.length && !profile.retired),
        ),
      ),
      updateReceived: Effect.fn("AccountsService.updateReceived")((profileId, change) =>
        locked(
          Effect.gen(function* () {
            const before = effectiveProfile(state.profiles, profileId);
            // Merged into Main here: nothing more arrives in its jar. A receive already writing when
            // the merge commits may still land there; that jar is kept, hidden, and back with Undo.
            if (before.retired)
              return yield* fail("denied", "This profile was merged into Main on this computer.");
            const { received, controls } = change(before);
            const same =
              received === before.received || (!before.received && received.length === 0);
            if (controls === undefined && same) return before;
            const next = withProfile(profileId, (record) => {
              const { received: _, ...rest } = record;
              return {
                ...rest,
                ...controls,
                ...(controls ? { allowedProjects: [] } : {}),
                ...(received.length ? { received } : {}),
              };
            });
            yield* commit(next.state, controls === undefined);
            return before;
          }),
        ),
      ),
      googleSessionsSeen: Effect.fn("AccountsService.googleSessionsSeen")((input) =>
        locked(
          batched(
            Effect.gen(function* () {
              const rows = () =>
                state.accounts.filter(
                  ({ summary }) =>
                    isGoogleSessionRow(summary) &&
                    "profileId" in summary.details &&
                    summary.details.profileId === input.profileId,
                );
              const address = ({ summary }: StoredAccount) =>
                summary.details.kind === "website" ? summary.details.username : undefined;
              for (const { email } of input.sessions)
                if (!rows().some((account) => address(account) === email))
                  yield* save({
                    name: "Google",
                    details: {
                      kind: "website",
                      sites: [GOOGLE_SITE],
                      loginUrl: "https://accounts.google.com/",
                      username: email,
                      profileId: input.profileId,
                      origin: "browser-session",
                    },
                    secrets: {},
                  });
              const at = yield* now;
              const nowMs = Date.parse(at);
              for (const account of rows()) {
                const valid = input.sessions.some(
                  (session) => session.email === address(account) && session.valid,
                );
                const seen = valid ? ("signed-in" as const) : ("signed-out" as const);
                const last = account.summary.signIn;
                // Google lists this address in the profile, so the row is that session.
                const { details } = account.summary;
                const recorded =
                  details.kind === "website" &&
                  details.origin === undefined &&
                  input.sessions.some((session) => session.email === address(account))
                    ? { ...details, origin: "browser-session" as const }
                    : details;
                if (
                  recorded === details &&
                  last?.state === seen &&
                  nowMs - Date.parse(last.at) < GOOGLE_RECHECK_WRITE_MS
                )
                  continue;
                // Google's own answer for a password-free row: nothing to refuse or limit here.
                // A new account, or one Google shows signed in again, is an action; the rest are looks.
                const by = seen === "signed-in" && last?.state !== "signed-in" ? "action" : "look";
                yield* commit(
                  replaceAccount({
                    ...account,
                    summary: {
                      ...account.summary,
                      details: recorded,
                      signIn: { state: seen, at, by },
                    },
                  }),
                  true,
                );
              }
            }),
          ),
        ),
      ),
      setCodeSources: Effect.fn("AccountsService.setCodeSources")((codeSources) =>
        locked(Effect.suspend(() => commit({ ...state, codeSources }, true))),
      ),
      setKeyLink: Effect.fn("AccountsService.setKeyLink")((target, accountId) =>
        locked(
          Effect.suspend(() =>
            commit(
              {
                ...state,
                ...(state.detachedKeyLinks
                  ? {
                      detachedKeyLinks: state.detachedKeyLinks.filter(
                        (link) =>
                          link.instanceId !== target.instanceId ||
                          link.variable !== target.variable,
                      ),
                    }
                  : {}),
                keyLinks: [
                  ...(state.keyLinks ?? []).filter(
                    (link) =>
                      link.instanceId !== target.instanceId || link.variable !== target.variable,
                  ),
                  ...(accountId === undefined ? [] : [{ ...target, accountId }]),
                ],
              },
              true,
            ),
          ),
        ),
      ),
      chooseProfile: Effect.fn("AccountsService.chooseProfile")((input) =>
        locked(
          Effect.gen(function* () {
            const current = state.profileChoices ?? { projects: {}, threads: {} };
            yield* commit(
              {
                ...state,
                profileChoices:
                  "threadId" in input
                    ? withThreadChoice(current, input, yield* now)
                    : {
                        ...current,
                        projects: Object.fromEntries([
                          ...Object.entries(current.projects).filter(
                            ([projectId]) => projectId !== input.projectId,
                          ),
                          ...(input.profileId === null ? [] : [[input.projectId, input.profileId]]),
                        ]),
                      },
              },
              true,
            );
          }),
        ),
      ),
      respondApproval: Effect.fn("AccountsService.respondApproval")((approvalId, decision) =>
        locked(
          Effect.gen(function* () {
            const entry = pending.get(approvalId);
            if (!entry || (yield* Deferred.isDone(entry.answer)))
              return yield* fail("not-found", "The approval is no longer pending.");
            if (decision === "project" && entry.scope.projectId === undefined)
              return yield* fail("invalid-input", "This approval has no project.");
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
            yield* publish();
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
          batched(
            Effect.gen(function* () {
              const parsed = yield* Effect.try({
                try: () => parsePasswordImport(input.content, input.format),
                catch: () =>
                  fail("invalid-input", "The password export is not a supported CSV file."),
              });
              const result = { created: 0, updated: 0, skipped: parsed.skipped };
              for (const entry of parsed.entries) {
                const existing = state.accounts.find(
                  (account) =>
                    account.summary.details.kind === "website" &&
                    account.summary.details.sites.includes(entry.site) &&
                    (account.summary.details.username ?? "") === entry.username &&
                    // The same login in another profile is that profile's own row.
                    (input.profileId === undefined ||
                      account.summary.details.profileId === undefined ||
                      account.summary.details.profileId === input.profileId),
                );
                if (existing) {
                  const current = yield* resolve(existing.summary.accountId, ["password", "totp"]);
                  const details = existing.summary.details;
                  const changedAt = existing.summary.secrets["password"]?.changedAt;
                  if (
                    details.kind === "website" &&
                    (input.profileId === undefined || details.profileId === input.profileId) &&
                    current.password &&
                    Redacted.value(current.password) === entry.password &&
                    (current.totp ? Redacted.value(current.totp) : undefined) === entry.totp
                  ) {
                    // Same values: only a newer date is kept; its sign-in evidence stays as it is.
                    const password = existing.summary.secrets["password"];
                    if (password && entry.changedAt && (!changedAt || entry.changedAt > changedAt))
                      yield* commit(
                        replaceAccount({
                          ...existing,
                          summary: {
                            ...existing.summary,
                            secrets: {
                              ...existing.summary.secrets,
                              password: { ...password, changedAt: entry.changedAt },
                            },
                          },
                        }),
                      );
                    result.skipped++;
                    continue;
                  }
                  // An older copy of the same sign-in never replaces a newer password.
                  if (entry.changedAt && changedAt && entry.changedAt < changedAt) {
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
                    password: {
                      type: "scient",
                      value: entry.password,
                      ...(entry.changedAt ? { changedAt: entry.changedAt } : {}),
                    },
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
      ),
      matchSignIn: Effect.fn("AccountsService.matchSignIn")((raw) =>
        locked(
          Effect.gen(function* () {
            const input = yield* decodeMatch(raw).pipe(
              Effect.mapError(() => fail("invalid-input", "Sign-in input is invalid.")),
            );
            const candidates = state.accounts
              .filter(
                ({ summary: { details } }) =>
                  details.kind === "website" &&
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
      filledTab: Effect.fn("AccountsService.filledTab")((threadId, tabId) =>
        Effect.sync(() => filledTabs.get(`${threadId}\u0000${tabId}`)),
      ),
      fillValues: Effect.fn("AccountsService.fillValues")((accountId, origin, tab) =>
        locked(
          Effect.gen(function* () {
            const account = findAccount(accountId);
            if (!account) return yield* missing();
            const details = account.summary.details;
            if (details.kind !== "website" || !siteMatches(details.sites, origin))
              return yield* fail("denied", "The page does not match this account's sites.");
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
                  return parseTotp(value).generate({ timestamp });
                },
                catch: () => fail("unavailable", "A one-time password could not be generated."),
              });
            }
            yield* commit(
              replaceAccount({
                ...account,
                summary: { ...account.summary, lastUsedAt: yield* now },
              }),
            );
            if (tab) {
              const key = `${tab.threadId}\u0000${tab.tabId}`;
              filledTabs.delete(key);
              filledTabs.set(key, { accountId, url: tab.url });
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
                        !speechOnly(account) &&
                        !privateModelKey(account) &&
                        inScope(account.controls.scope, scope.projectId),
                    )
                : [],
              profiles: state.agentAccess
                ? profiles
                    .map((id) => effectiveProfile(state.profiles, id))
                    // A profile merged into Main is no agent's to pick, however it was named.
                    .filter(
                      (profile) => !profile.retired && inScope(profile.scope, scope.projectId),
                    )
                : [],
              profileChoices: state.profileChoices,
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
                const decision = authorizationDecision(
                  state.agentAccess,
                  controls,
                  scope,
                  conversationGrants.has(grantKey(scope.threadId, target)),
                );
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
              !speechOnly(summary) &&
              !privateModelKey(summary) &&
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
            const origin = consumer.kind === "local-connector" ? undefined : consumer.origin;
            const accountId = boundAccountId(ref);
            if (Option.isNone(accountId))
              return yield* fail("invalid-input", "The account reference is invalid.");
            const account = findAccount(accountId.value);
            if (!account) return yield* missing();
            const { details, controls } = account.summary;
            if (
              details.kind !== "api-key" ||
              speechOnly(account.summary) ||
              (origin !== undefined && !siteMatches(details.sites, origin)) ||
              agentAccessOff(state.agentAccess, controls.access) ||
              (consumer.kind !== "connector" && !inScope(controls.scope, consumer.projectId))
            ) {
              if (consumer.kind === "connector")
                yield* appendActivity({
                  target: { type: "account", accountId: accountId.value },
                  action: "request",
                  decision: "denied",
                  ...consumerActivity(consumer),
                }).pipe(Effect.ignore);
              return yield* fail("denied", "The account is unavailable for this service.");
            }
            const values = yield* resolve(accountId.value, ["token"]);
            if (values.token === undefined)
              return yield* fail("not-found", "The account key is missing.");
            return values.token;
          }),
        ).pipe(
          Effect.tapError(() =>
            consumer.kind !== "connector" ? service.recordBoundDenial!(ref, consumer) : Effect.void,
          ),
          Effect.tap(() => {
            if (consumer.kind !== "connector" && options?.auditAllowed === false)
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
      saveLegacySpeechKey: Effect.fn("AccountsService.saveLegacySpeechKey")(
        (accountId: AccountId, origin: string, name: string, token: Redacted.Redacted<string>) =>
          locked(
            Effect.gen(function* () {
              const existing = findAccount(accountId);
              const prior = existing?.summary.details;
              if (
                prior &&
                (prior.kind !== "api-key" || !prior.speechOnly || !prior.sites.includes(origin))
              ) {
                return yield* fail("denied", "The legacy speech binding is unavailable.");
              }
              yield* save(
                {
                  ...(existing ? { accountId } : {}),
                  name: existing?.summary.name ?? name,
                  details: {
                    kind: "api-key",
                    sites: [origin],
                    auth: { type: "bearer" },
                    speechOnly: true,
                  },
                  secrets: { token: { type: "scient", value: Redacted.value(token) } },
                },
                accountId,
              );
            }),
          ),
      ),
      resolveCustomModelAccountKey: Effect.fn("AccountsService.resolveCustomModelAccountKey")(
        (accountId, origin, protocol) => locked(modelAccountKey(accountId, origin, protocol)),
      ),
      resolveSpeechKey: Effect.fn("AccountsService.resolveSpeechKey")(
        (accountId, origin, usage, projectId) =>
          locked(
            Effect.gen(function* () {
              const account = findAccount(accountId);
              if (!account) return yield* missing();
              const details = account.summary.details;
              if (
                details?.kind !== "api-key" ||
                details.auth.type !== "bearer" ||
                !isSpeechAccountOrigin(origin) ||
                !details.sites.includes(origin) ||
                account.summary.secrets.token?.source.type !== "scient"
              )
                return yield* fail(
                  "denied",
                  "Choose a saved API key for this exact speech endpoint.",
                );
              if (!inScope(account.summary.controls.scope, projectId))
                return yield* fail("denied", SPEECH_KEY_OUTSIDE_PROJECT);
              const { token } = yield* resolve(accountId, ["token"]);
              if (!token) return yield* missing();
              if (usage)
                yield* appendActivity({
                  target: { type: "account", accountId },
                  action: "request",
                  decision: "allowed",
                  detail:
                    "Speech " +
                    usage.provider +
                    " " +
                    usage.jobId.replaceAll(Redacted.value(token), "[redacted]"),
                });
              return { name: account.summary.name, token };
            }),
          ),
      ),
      resolveSecrets: Effect.fn("AccountsService.resolveSecretsInput")((accountId, fields) =>
        locked(
          Effect.gen(function* () {
            const account = findAccount(accountId);
            if (account && speechOnly(account.summary)) return yield* missing();
            return yield* resolve(accountId, fields);
          }),
        ),
      ),
      recordCheck: Effect.fn("AccountsService.recordCheck")((accountId, { username, ...check }) =>
        locked(
          Effect.gen(function* () {
            const account = findAccount(accountId);
            if (!account) return;
            const { details } = account.summary;
            // A page naming who is signed in names a session row that had no one yet.
            const named =
              username !== undefined &&
              check.state === "signed-in" &&
              details.kind === "website" &&
              details.username === undefined &&
              account.summary.secrets.password === undefined
                ? {
                    ...account.summary,
                    details: { ...details, username, origin: "browser-session" as const },
                  }
                : account.summary;
            const summary = withSignIn(
              named,
              { ...check, at: yield* now },
              yield* Clock.currentTimeMillis,
              "look",
            );
            if (summary === account.summary) return;
            yield* commit(replaceAccount({ ...account, summary }), true);
          }),
        ),
      ),
      recordUse: Effect.fn("AccountsService.recordUse")(
        ({ savedPasswordUsed, ...entry }, message, wait) =>
          locked(
            Effect.gen(function* () {
              yield* appendActivity({ ...entry, decision: "allowed" });
              if (entry.target.type === "account") {
                const account = findAccount(entry.target.accountId);
                if (account) {
                  const at = yield* now;
                  yield* commit(
                    replaceAccount({
                      ...account,
                      summary: entry.signInOutcome
                        ? withSignIn(
                            {
                              ...account.summary,
                              lastUsedAt: at,
                              ...(entry.signInOutcome === "signed-in" && savedPasswordUsed
                                ? { secrets: verifiedPassword(account.summary.secrets, at) }
                                : {}),
                            },
                            {
                              state: outcomeSignInState(entry.signInOutcome),
                              at,
                              ...(message === undefined ? {} : { detail: message }),
                            },
                            yield* Clock.currentTimeMillis,
                            "attempt",
                          )
                        : { ...account.summary, lastUsedAt: at },
                    }),
                    true,
                  );
                }
              }
            }),
          ).pipe(
            Effect.ignore,
            (record) => (wait ? record : record.pipe(Effect.forkIn(serviceScope))),
            Effect.asVoid,
          ),
      ),
    });
    if (sources.modelCatalog) {
      const migrate = migrateModelKeys.pipe(Effect.ignore);
      yield* sources.modelCatalog.installResolver(service.resolveCustomModelAccountKey, migrate);
    }
    return service;
  }),
);
