import type { SignInFactor } from "./signInCodes.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Opaque record ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import * as Equal from "effect/Equal";
import { getDomain } from "tldts";
import {
  type AccountCodeNotice,
  ACCOUNTS_PROTOCOL,
  GOOGLE_SITE,
  ACCOUNT_SECRET_FIELDS,
  BACKUP_CODE_ID,
  DEFAULT_BROWSER_PROFILE_ID,
  defaultBrowserProfileRecord,
  isBuiltInBrowserProfileId,
  INCOGNITO_BROWSER_PROFILE_ID,
  SessionCookie,
  type ProfileOperation,
  type ProfileStoreOutcome,
  type ProjectId,
  type ProfileOperateResult,
  type ThreadId as ProfileThreadId,
  AccountId,
  acceptsCustomModelKey,
  accountName,
  acceptsTextGeneratorKey,
  sameAuthStyle,
  acceptsSpeechKey,
  type CustomModelProtocol,
  AccountSaveInput,
  AccountMatchSignInInput,
  AccountsError,
  defaultAccountControls,
  type AccountActivityEntry,
  type AccountKeyLink,
  type AccountSaveResult,
  type AccountApproval,
  type AccountHandoff,
  type AccountSignInAttempt,
  type AccountSignInEnd,
  type UniversitySignOut,
  type UniversitySignOutTarget,
  type PaperQueueSummary,
  type AccountApprovalDecision,
  type AccountControls,
  type AccountSecretInput,
  type AccountSecretSummary,
  type AccountsSnapshot,
  type AccountSummary,
  type AccountChange,
  type AccountSetControlsInput,
  isCustomModelAccountOrigin,
  isSpeechAccountOrigin,
  keyServesUse,
  type AccountTarget,
  type BrowserProfileId,
  type BrowserProfileRecord,
  type BrowserProfileSource,
  type AccountValueSource,
  type AccountWriteStore,
  linksBrowserProfile,
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
  privateKeyId,
  SPEECH_KEY_OUTSIDE_PROJECT,
  typedDigest,
  type AccountKeyConsumer,
  type AccountSessionScope,
  type AccountUseScope,
  type AccountsServiceShape,
  type AccountAuthorization,
  type AccountChangeBy,
  type FoundValue,
  type ProfileStore,
} from "./AccountsService.ts";
import { withoutProfile, withProfileAsMain, withThreadChoice } from "./profileChoices.ts";
import {
  mainRowFor,
  withMainSignOutsCleared,
  withRowsIntoMain,
  withSignedOutSite,
} from "./mainRecord.ts";
import { SignInAttempts } from "./agent/signInAttempts.ts";
import {
  backupCodeList,
  backupCodesValue,
  USED_CODES_KEPT,
  usedCodeDigest,
} from "./backupCodes.ts";
import { sourceIdOf, sourceName, SOURCES_EXPIRE_MS, SOURCES_FRESH_MS } from "./browserSources.ts";
import { codeSourcesReadable } from "./signIn/codeSourcesHelper.ts";
import { signedOutOfSite, withoutSignOuts, withSignOut } from "./signOuts.ts";
import { withNeedsYouSettled } from "./needsYou.ts";
import {
  pinBinds,
  pinRefusal,
  taskPinIn,
  readTaskPins,
  UNKNOWN_RUN,
  UNKNOWN_RUN_REFUSAL,
  UNREADABLE_PIN,
} from "./taskPinRules.ts";
import { clientProfile, issueJar, issueUnit, withSendLog, withShared } from "./sendLog.ts";
import { AccountVault } from "./AccountVault.ts";
import {
  AccountPersistence,
  AccountsState,
  Activity,
  decodePrivateJson,
  withStoredAccountsFolded,
  storedRecords,
  encodeAccountsState,
  customModelEscrowName,
  emptyState,
  encodePrivateJson,
  type SignOut,
  type RemovedLogin,
  type StoredAccount,
} from "./AccountPersistence.ts";
import { AccountSources, type OnePasswordClient } from "./AccountSources.ts";
import {
  GOOGLE_OUT_CONFIRM_MS,
  GOOGLE_RECHECK_WRITE_MS,
  isGoogleSessionRow,
  signedOutOnPurpose,
  withSignIn,
  applyApprovalDecision,
  turnOnDecision,
  agentAccessOff,
  authorizationDecision,
  effectiveProfile,
  inScope,
  keyReachesProviders,
  sameTarget,
  siteMatches,
  outcomeSignInState,
} from "./AccountDecisions.ts";
import { accountTokenRef, boundAccountId } from "./AccountBoundRef.ts";
import { withKeyUse } from "./keyRefusals.ts";
import { editedDetails, profileVersion, tightensOnly } from "./agentChanges.ts";
import { planSecretStores, type CopyDestination } from "./copyPlan.ts";
import { parsePasswordImport } from "./PasswordImport.ts";
import {
  authenticatorTargets,
  isAuthenticatorExport,
  parseAuthenticatorExport,
} from "./authenticatorImport.ts";
import {
  healthFindings,
  passwordFacts,
  pwnedSuffixes,
  type PasswordFacts,
} from "./passwordHealth.ts";
import {
  readRemovedAccounts,
  REMOVED_ACCOUNTS_RECORD,
  RemovedAccounts,
  removedLoginsOf,
  UNDO_FOR_MS,
  unexpired,
  withoutRemovedLogins,
  withRemovedLogins,
} from "./removedAccounts.ts";
import { parseTotp } from "./signIn/totp.ts";
import { universityDetails } from "@t3tools/shared/scientPaperLinks";
import { signInStopped } from "@t3tools/shared/scientAccountSignIn";
import { sameCookie } from "@t3tools/shared/scientSessionCookies";
import {
  isLogin,
  isLoginRow,
  loginCandidates,
  loginCopies,
  loginKeysOf,
  loginSiteKey,
  loginUserKey,
  sameLoginKey,
  type LoginKey,
} from "@t3tools/shared/scientLoginIdentity";
import type { CustomModelAccountResolver } from "../../customModels.ts";

const missing = () => fail("not-found", "The account no longer exists.");
// Unattended work waits for the store to open with the person there.
const unopened = () => fail("unavailable", "Scient Accounts has not been opened yet.");
/** Offline, Accounts still opens: GitHub's own answer is left out after this long. */
const GITHUB_IDENTITY_TIMEOUT = Duration.seconds(12);
/** How often the leak check looks for passwords it hasn't asked about, and how long an answer holds. */
const LEAK_CHECK_GAP = Duration.minutes(1);
const LEAK_RECHECK_MS = 24 * 60 * 60_000;
/** Between two prefixes of one turn: a gentle pace for a free service. */
const LEAK_PREFIX_GAP = Duration.seconds(2);

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
  if (!password) return secrets;
  const { refusedAt: _, ...rest } = password;
  return { ...secrets, password: { ...rest, verifiedAt: at } };
};
const refusedPassword = (secrets: AccountSummary["secrets"], at: string) => {
  const password = secrets["password"];
  return password ? { ...secrets, password: { ...password, refusedAt: at } } : secrets;
};

const valueName = () => `accounts-value-${NodeCrypto.randomUUID()}`;
const VALUE_REF = /^accounts-value-[a-f0-9-]{36}$/;
/** Every value name anywhere in `records` (rows, histories, receipts, pending, cookies…). */
const refsIn = (...records: ReadonlyArray<unknown>) => {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (VALUE_REF.test(value)) found.add(value);
    } else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (typeof value === "object" && value !== null)
      for (const item of Object.values(value)) walk(item);
  };
  for (const record of records) walk(record);
  return found;
};
/** Values deleted a pass, under one permit hold. */
const SWEEP_BATCH = 50;
/** Value names a bulk change journals on disk at a time, ahead of writing them. */
const STAGE_RESERVE = 64;
/** A field's write count, read as an own property: a field named `constructor` counts too. */
const ownCount = (counts: Readonly<Record<string, number>> | undefined, field: string) =>
  counts !== undefined && Object.hasOwn(counts, field) ? counts[field]! : 0;
/** A row's value for a field, read as an own property. */
const ownRef = (values: Readonly<Record<string, string>> | undefined, field: string) =>
  values !== undefined && Object.hasOwn(values, field) ? values[field] : undefined;
/** A row's write counts as one comparable line, fields in order. */
const writeCounts = (counts: Readonly<Record<string, number>> | undefined) =>
  Object.entries(counts ?? {})
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([field, count]) => `${field}\u0000${count}`)
    .join("\u0001");
/**
 * Each row's field write counts (`revisions`), one more for every field whose value this write
 * changed; a save names its own, even writing the same value again.
 */
const withRevisions = (before: AccountsState, after: AccountsState): AccountsState => {
  const was = new Map(before.accounts.map((row) => [row.summary.accountId, row]));
  let changed = false;
  const accounts = after.accounts.map((row) => {
    const old = was.get(row.summary.accountId);
    const fields = new Set([
      ...Object.keys(old?.values ?? {}),
      ...Object.keys(row.values),
      ...Object.keys(old?.revisions ?? {}),
      ...Object.keys(row.revisions ?? {}),
    ]);
    const revisions: Record<string, number> = Object.create(null);
    for (const field of fields) {
      const prior = ownCount(old?.revisions, field);
      const moved = ownRef(old?.values, field) !== ownRef(row.values, field);
      const count = Math.max(ownCount(row.revisions, field), moved ? prior + 1 : prior);
      if (count > 0) revisions[field] = count;
    }
    const same =
      Object.keys(revisions).length === Object.keys(row.revisions ?? {}).length &&
      Object.entries(revisions).every(([field, count]) => ownCount(row.revisions, field) === count);
    if (same) return row;
    changed = true;
    return { ...row, revisions: { ...revisions } };
  });
  return changed ? { ...after, accounts } : after;
};
/** Values kept for an unreadable record of a login the person removed in this write: let go. */
const withUnreadableReleased = (before: AccountsState, after: AccountsState): AccountsState => {
  if (!after.unreadable?.length) return after;
  const now = new Set(after.accounts.map((row) => row.summary.accountId as string));
  const gone = new Set(
    before.accounts.flatMap((row) =>
      now.has(row.summary.accountId) ? [] : [row.summary.accountId as string],
    ),
  );
  if (gone.size === 0) return after;
  return {
    ...after,
    unreadable: after.unreadable.filter(
      (entry) => entry.accountId === undefined || !gone.has(entry.accountId),
    ),
  };
};
/**
 * The Custom models escrows a row, a record that didn't read, or the quarantine names: never
 * journaled nor deleted.
 */
const namedEscrows = (state: AccountsState) =>
  new Set([
    ...(state.customModelEscrows ?? []).map(({ legacyId }) => customModelEscrowName(legacyId)),
    ...(state.unreadable ?? []).flatMap((entry) => (entry.escrow ? [entry.escrow] : [])),
    ...(state.unreferencedEscrows ?? []),
  ]);
/** An escrow record held without its name (an earlier build's hold): no escrow is deleted. */
const escrowsUncertain = (state: AccountsState) =>
  (state.unreadable ?? []).some(
    (entry) => entry.list === "customModelEscrows" && entry.escrow === undefined,
  );
/** Key refusals of a value the login no longer holds (rotated): gone, so they name no value. */
const withCurrentRefusals = (after: AccountsState): AccountsState => {
  if (!after.keyRefusals?.length) return after;
  const tokens = new Map(after.accounts.map((row) => [row.summary.accountId, row.values.token]));
  const current = after.keyRefusals.filter(
    (entry) => tokens.get(entry.accountId) === entry.version,
  );
  return current.length === after.keyRefusals.length ? after : { ...after, keyRefusals: current };
};
/** A removed version its login holds again (the same value saved anew): no longer removed. */
const withRemovedInUse = (after: AccountsState): AccountsState => {
  if (!after.removedVersions?.length) return after;
  const held = new Set(
    after.accounts.flatMap((row) => [row.values["password"], row.previous?.password]),
  );
  const left = after.removedVersions.filter((entry) => !held.has(entry.version.ref));
  return left.length === after.removedVersions.length ? after : { ...after, removedVersions: left };
};
/** What a stored record names about its login: its own id, or its row's. */
const recordAccountId = (record: unknown): string | undefined => {
  if (typeof record !== "object" || record === null) return undefined;
  if ("accountId" in record && typeof record.accountId === "string") return record.accountId;
  const row = "row" in record ? record.row : record;
  const summary = typeof row === "object" && row !== null && "summary" in row ? row.summary : null;
  return typeof summary === "object" &&
    summary !== null &&
    "accountId" in summary &&
    typeof summary.accountId === "string"
    ? summary.accountId
    : undefined;
};
/**
 * Values the raw stored lists name that the same lists, decoded, don't: records (or parts) that
 * didn't read. Each kept by its list and login, never deleted, whatever else names them.
 */
const lostRefs = (
  raw: ReadonlyArray<readonly [string, unknown]>,
  decoded: (list: string) => ReadonlySet<string>,
): Array<{ list: string; accountId?: string; refs: Array<string> }> =>
  raw.flatMap(([list, value]) => {
    const known = decoded(list);
    return (Array.isArray(value) ? value : [value]).flatMap((record) => {
      const refs = [...refsIn(record)].filter((ref) => !known.has(ref));
      if (refs.length === 0) return [];
      const accountId = recordAccountId(record);
      return [{ list, ...(accountId === undefined ? {} : { accountId }), refs }];
    });
  });
/** A stored state's lists (each top-level field) as raw JSON. */
const rawLists = (raw: unknown): ReadonlyArray<readonly [string, unknown]> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) ? Object.entries(raw) : [];
/** A stored record's raw JSON, before any fold drops what doesn't read; none if it isn't JSON. */
const rawRecord = (bytes: Redacted.Redacted<Uint8Array>): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(Redacted.value(bytes)));
  } catch {
    return undefined;
  }
};

/** Off, Ask, Allowed: an imported login's access is never above its profile's. */
const ACCESS_ORDER = { off: 0, ask: 1, allowed: 2 } as const;
/** An operation with one desktop's part recorded: another desktop's by its computer, else its own. */
const withDesktopPart = (
  operation: ProfileOperation,
  phase: "do" | "undo",
  computer: string | undefined,
  outcome: ProfileStoreOutcome,
): ProfileOperation => {
  const replace = (others: ProfileOperation["others"]) =>
    others?.map((part) => (part.computer.id === computer ? { ...part, outcome } : part));
  const other = (phase === "do" ? operation.others : operation.undone?.others)?.some(
    (part) => part.computer.id === computer,
  );
  if (phase === "do")
    return other
      ? { ...operation, others: replace(operation.others) }
      : { ...operation, desktop: outcome };
  if (!operation.undone) return operation;
  return {
    ...operation,
    undone: other
      ? { ...operation.undone, others: replace(operation.undone.others) }
      : { ...operation.undone, desktop: outcome },
  };
};
/**
 * One browser profile links to one Scient profile (round 6h): `profileId`'s link to it stands, and
 * any other profile's link to the same browser profile on the same desktop goes.
 */
const sameBrowserProfile = (a: BrowserProfileSource, b: BrowserProfileSource) =>
  linksBrowserProfile(a, {
    browser: b.browser,
    name: b.profileName,
    directory: b.directory,
    computerId: b.computer?.id,
  });
const soleLink = (
  profiles: ReadonlyArray<BrowserProfileRecord>,
  profileId: BrowserProfileId,
  link: BrowserProfileSource,
): Array<BrowserProfileRecord> =>
  profiles.map((profile) => {
    if (profile.profileId === profileId || !profile.source) return profile;
    if (!sameBrowserProfile(profile.source, link)) return profile;
    const { source: _, ...unlinked } = profile;
    return unlinked;
  });
/** Still being done: some store hasn't ended. Its Undo hour hasn't started (round 6d). */
const stillPending = (operation: ProfileOperation) =>
  [
    operation.server,
    operation.desktop,
    ...(operation.others ?? []).map(({ outcome }) => outcome),
  ].some((store) => store?.state === "pending");
/** In its hour, or not yet ended: kept, resumed, its seals left alone. */
const live = (operation: ProfileOperation, atMs: number) =>
  stillPending(operation) || Date.parse(operation.until) > atMs;
/** Every receipt still live, and the newest 200 of the rest. */
const keptReceipts = (operations: ReadonlyArray<ProfileOperation>, atMs: number) => {
  const ended = operations.filter((operation) => !live(operation, atMs));
  const kept = new Set(ended.slice(-200));
  return operations.filter((operation) => live(operation, atMs) || kept.has(operation));
};
const isTabList = <T>(
  openIn: ReadonlyArray<T> | Effect.Effect<ReadonlyArray<T>>,
): openIn is ReadonlyArray<T> => Array.isArray(openIn);

/**
 * Whether a profile's sign-ins would reach further in `into` than in `from`: more access, more
 * projects (scope or approvals), scripts, or another computer to send them to.
 */
/** What a profile gives agents in a project (undefined: one it names nowhere): Off, Ask, Allowed. */
const grantIn = (record: BrowserProfileRecord, projectId: ProjectId | undefined) =>
  !inScope(record.scope, projectId)
    ? 0
    : record.access === "allowed" ||
        (record.access === "ask" &&
          projectId !== undefined &&
          (record.allowedProjects ?? []).includes(projectId))
      ? 2
      : record.access === "ask"
        ? 1
        : 0;
/**
 * Whether sign-ins of `from` would reach further in `into`: in any project, counting its approvals
 * ("Always in this project"), for scripts, or on another computer it is sent to.
 */
const widensInto = (from: BrowserProfileRecord, into: BrowserProfileRecord) => {
  const named = new Set<ProjectId>([
    ...(from.scope.type === "projects" ? from.scope.projectIds : []),
    ...(into.scope.type === "projects" ? into.scope.projectIds : []),
    ...(from.allowedProjects ?? []),
    ...(into.allowedProjects ?? []),
  ]);
  return (
    [undefined, ...named].some(
      (projectId) => grantIn(into, projectId) > grantIn(from, projectId),
    ) ||
    (into.scriptSignIn && !from.scriptSignIn) ||
    (into.sharedWith ?? []).some(
      ({ environmentId }) =>
        !(from.sharedWith ?? []).some((shared) => shared.environmentId === environmentId),
    )
  );
};
/** A login row of `from` that a copy of these sites (all when none) takes along. */
const takenAlong = (sites: ReadonlyArray<string> | undefined, rowSites: ReadonlyArray<string>) =>
  sites === undefined ||
  rowSites.some((site) =>
    sites.some(
      (chosen) => site === chosen || site.endsWith(`.${chosen}`) || chosen.endsWith(`.${site}`),
    ),
  );

/** A cookie's identity in a seal: its name, where it is sent, and its partition. */
const sealKey = (cookie: SessionCookie) =>
  JSON.stringify([
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.partitionKey?.topLevelSite ?? null,
    cookie.partitionKey?.hasCrossSiteAncestor ?? null,
  ]);
/** A sign-out's cookies from this server's browser, as kept for its Undo. */
const SavedCookies = Schema.fromJsonString(Schema.Array(SessionCookie));
const encodeSavedCookies = Schema.encodeEffect(SavedCookies);
const decodeSavedCookies = Schema.decodeEffect(SavedCookies);

/** What binds agents on a profile; a change to it gives the record a new version. */
const profileBinding = ({
  access,
  scope,
  allowedProjects,
  scriptSignIn,
  retired,
  removed,
  generation,
  source,
  sharedWith,
}: BrowserProfileRecord) =>
  JSON.stringify([
    access,
    scope,
    allowedProjects ?? [],
    scriptSignIn,
    retired ?? null,
    removed ?? null,
    generation ?? 0,
    // Where its sign-ins come from and the computers they go to (round 6c).
    source ? [source.browser, source.directory ?? source.profileName] : null,
    (sharedWith ?? []).map(({ environmentId }) => environmentId).toSorted(),
  ]);

/** Each profile record whose controls or retirement changed is stamped with `at`. */
const withProfileVersions = (
  before: AccountsState,
  next: AccountsState,
  at: string,
): AccountsState => {
  if (next.profiles === before.profiles) return next;
  const earlier = new Map(before.profiles.map((record) => [record.profileId, record]));
  let changed = false;
  const profiles = next.profiles.map((record) => {
    const was = earlier.get(record.profileId);
    if (was && profileBinding(was) === profileBinding(record)) return record;
    if (!was && record.updatedAt) return record;
    changed = true;
    return { ...record, updatedAt: was?.updatedAt ? laterThan(was.updatedAt, at) : at };
  });
  return changed ? { ...next, profiles } : next;
};
/** A row's `updatedAt` only moves forward, so two edits in one millisecond still differ. */
const laterThan = (previous: string, at: string) =>
  Date.parse(at) > Date.parse(previous)
    ? at
    : DateTime.formatIso(DateTime.makeUnsafe(Date.parse(previous) + 1));
const APPROVAL_WAIT_MS = 10 * 60_000;
const CARDS_KEPT = 500;
const FALLBACK_GAP_MS = 24 * 60 * 60_000;
/** Pending secrets kept at once, and how long each kind waits; see `expirePending`. */
const PENDING_KEPT = 200;
const SETTLE_FOR_MS = 5 * 60_000;
/** A password filled but not (seen) sent yet: the person's to answer after this long. */
const RESERVE_FOR_MS = 15 * 60_000;
const FACTOR_KEPT_MS = 7 * 24 * 60 * 60_000;
const PENDING_LOOK_GAP = Duration.minutes(1);
/** A site with a failed or limited sign-in within this long gets no submit by itself. */
const FAILURE_WINDOW_MS = 60 * 60_000;
/** The site a lockout is shared across: its registrable domain (an IP or bare host: itself). */
const sharedSite = (site: string) => {
  const host = URL.parse(site.includes("://") ? site : `https://${site}`)?.hostname ?? site;
  return getDomain(host) ?? host;
};
/** A sign-in attempt in the person's tab answers once, within this long. */
const ATTEMPT_FOR_MS = 30 * 60_000;
const ATTEMPTS_KEPT = 500;

/** An imported entry as the login it names: its site (its port included) and tenant address. */
const importedLogin = (entry: { site: string; username: string; loginUrl: string }) => ({
  kind: "website" as const,
  sites: [entry.site],
  username: entry.username,
  loginUrl: entry.loginUrl,
});
const decodeSave = Schema.decodeEffect(AccountSaveInput);
const decodeMatch = Schema.decodeEffect(AccountMatchSignInInput);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
/** Activity lines Scient writes itself, which carry no value or address. */
const FIXED_DETAILS = new Set([
  "Password shown",
  "Previous password shown",
  "Earlier password shown",
  "Earlier password put back",
]);
/** A fill for another paired client: its own name for itself, and the page's origin. */
const fillDetail = /^Filled on [\p{L}\p{N} .·()-]{1,40}: https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/u;
const safeDetail = (detail: string | undefined) => {
  if (!detail) return undefined;
  if (FIXED_DETAILS.has(detail) || fillDetail.test(detail)) return detail;
  try {
    return new URL(detail).origin;
  } catch {
    return /^[A-Z]{3,7} [a-z0-9.-]+(?::\d+)?$/.test(detail) ||
      pluginKeyDetail.test(detail) ||
      speechKeyDetail.test(detail) ||
      unreadablePinDetail.test(detail)
      ? detail.slice(0, 200)
      : undefined;
  }
};
/** A scheduled task whose stored pin couldn't be read; its id is the scheduler's own. */
const unreadablePinDetail =
  /^Scheduled task [\w:.-]{1,80}: its pin couldn't be read\. Pin it again\.$/u;
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
    /** Cards this process opened and hasn't recorded; none survive a restart, nor need to. */
    const settlingCards = new Set<string>();
    /**
     * Password updates Undo can still take back, each copy with its own earlier value; and keys
     * Scient kept itself (`field`), each row with what it held before, or made new.
     */
    const passwordUndos = new Map<
      string,
      | {
          readonly accountId: AccountId;
          readonly name: string;
          readonly until: number;
          readonly field?: undefined;
          readonly copies: ReadonlyArray<{
            readonly accountId: AccountId;
            /** Its password before; absent for a row that had none, which Undo empties again. */
            readonly beforeRef?: string;
            readonly beforeSecret?: AccountSecretSummary;
            readonly afterRef: string;
            /** The login it was (`identityOf`): Undo applies only to that login still. */
            readonly identity?: string;
            /** The password field's write that made it: Undo applies only while it stands. */
            readonly afterRevision?: number;
            /** The write it replaced: an Undo back to it makes an older receipt current again. */
            readonly beforeRevision?: number;
          }>;
        }
      | {
          readonly accountId: AccountId;
          readonly name: string;
          readonly until: number;
          readonly field: FoundValue["field"];
          readonly rows: ReadonlyArray<{
            readonly accountId: AccountId;
            readonly afterRef: string;
            /** What the row held: a value, a link to another store, or nothing; absent when made. */
            readonly before?: Redacted.Redacted<string> | AccountSecretInput | undefined;
            /** Backup codes it held were one per line. */
            readonly beforeLines?: true;
            /** A login made for it, as it was then: given more since, Undo leaves it. */
            readonly created?: true;
            readonly createdUpdatedAt?: string;
          }>;
        }
    >();
    let state: AccountsState = emptyState;
    /** New passwords whose form was sent and whose site's answer is still being looked for. */
    const settling = new Set<string>();
    /**
     * Logins a page's 2FA key or backup codes could be for: this profile's website logins on the
     * page's own origin or exact host (a bare site's subdomains are other sites here).
     */
    const factorLogins = (origin: string, profileId: string | undefined) => {
      const host = URL.parse(origin)?.hostname;
      return state.accounts.flatMap(({ summary }) =>
        summary.details.kind === "website" &&
        summary.details.origin !== "browser-session" &&
        summary.details.institution === undefined &&
        (summary.details.profileId ?? DEFAULT_BROWSER_PROFILE_ID) ===
          (profileId ?? DEFAULT_BROWSER_PROFILE_ID) &&
        summary.details.sites.some((site) =>
          site.includes("://") ? URL.parse(site)?.origin === origin : site === host,
        )
          ? [summary]
          : [],
      );
    };
    /**
     * Which login a row is, as a new password's answer compares it: each of its sites with its
     * tenant and username, and its profile. A site, tenant, owner or profile edit is another login.
     */
    const identityOf = (summary: AccountSummary) =>
      summary.details.kind === "website"
        ? [
            summary.details.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
            ...loginKeysOf(summary.details)
              .map((key) => `${key.site} ${key.tenant} ${key.username}`)
              .sort(),
          ].join("\n")
        : "";
    /** A login's other copies, each with its password ref and which login it is, as now. */
    const copyRefsOf = (accountId: AccountId) =>
      loginCopies(
        state.accounts.map((account) => account.summary),
        accountId,
      ).map((copy) => {
        const row = findAccount(copy.accountId);
        const ref = row?.values["password"];
        return {
          accountId: copy.accountId,
          identity: identityOf(copy),
          revision: ownCount(row?.revisions, "password"),
          ...(ref ? { ref } : {}),
        };
      });
    let recentActivity: ReadonlyArray<AccountActivityEntry> = [];
    let takeAccess:
      | ((links: ReadonlyArray<AccountKeyLink>) => Effect.Effect<void, AccountsError>)
      | undefined;
    /** Followed copies of keys that stop reaching providers go first; a failure never blocks. */
    const takeBackLinks = (reaches: (link: AccountKeyLink) => boolean) => {
      const links = (state.keyLinks ?? []).filter((link) => !reaches(link));
      return takeAccess && links.length
        ? takeAccess(links).pipe(Effect.retry({ times: 1 }), Effect.ignore)
        : Effect.void;
    };
    /** Removed rows waiting for Undo, with their values still stored. */
    let removed: RemovedAccounts = [];
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
    const signInEnds = new Map<AccountId, AccountSignInEnd>();
    const paperQueues = new Map<string, PaperQueueSummary>();
    // In memory only, never trimmed while the server runs: a forgotten entry would expose a filled
    // page. The account autofill put into a tab, keyed by thread and tab.
    const filledTabs = new Map<string, { accountId: AccountId; url: string }>();
    const handoffReveals = new Map<string, Effect.Effect<void, AccountsError>>();
    const cancelledHandoffs = new Set<string>();
    const chosenCodes = new Map<string, string>();
    /** Hand-offs whose one click has been made: a second, from any device, is refused. */
    const claimedCodes = new Set<string>();
    /** The card revision each Use saved click was for, by hand-off. */
    const savedRequests = new Map<string, string>();
    /** The revisions the sign-in already took, by hand-off: a retried click is not queued again. */
    const savedTaken = new Map<string, Set<string>>();
    /** A hand-off's Use saved state goes with it, or with the card revision it was for. */
    const forgetSaved = (handoffId: string, unlessRevision?: string) => {
      if (unlessRevision === undefined || savedRequests.get(handoffId) !== unlessRevision)
        savedRequests.delete(handoffId);
      if (unlessRevision === undefined) savedTaken.delete(handoffId);
    };
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
          // Only an absent gh (missing without a probe-failure detail) is a complete unknown.
          const githubProbeComplete =
            github === undefined ||
            (github.auth.cliAuthStatus !== "unknown" &&
              (github.auth.status !== "unknown" ||
                (github.status === "missing" && Option.isNone(github.detail))));
          const { effective, complete: effectiveComplete } = effectiveProbe;
          const complete = githubProbeComplete && effectiveComplete;
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
    // The sources keep the reader's last answer briefly (`codesHost`); a snapshot shows that one,
    // so a fresh check is on every row at once.
    const codesHost = sources.codesHost ?? Effect.undefined;
    const externalIdentities = Cache.get(externalIdentitiesCache, "github");
    const readModelConsumers = sources.modelCatalog?.connections ?? Effect.succeed([]);
    const readTranscriptionConsumers = sources.transcriptionKeyConsumers ?? Effect.succeed([]);
    // Digests stay in this process; clients learn only which rows hold the same key.
    const keyDigests = new Map<string, string>();
    const sameKeys = Effect.gen(function* () {
      const byDigest = new Map<string, AccountId[]>();
      for (const { summary, values } of state.accounts) {
        const ref = values.token;
        if (summary.details.kind !== "api-key" || summary.secrets.token?.source.type !== "scient")
          continue;
        if (ref === undefined) continue;
        let digest = keyDigests.get(ref);
        if (digest === undefined) {
          const value = yield* Effect.option(readValue(ref));
          if (Option.isNone(value)) continue;
          digest = NodeCrypto.createHash("sha256")
            .update(Redacted.value(value.value))
            .digest("hex");
          keyDigests.set(ref, digest);
        }
        byDigest.set(digest, [...(byDigest.get(digest) ?? []), summary.accountId]);
      }
      return [...byDigest.values()].filter((ids) => ids.length > 1);
    });
    // Health stays in this process too: each stored password's SHA-1 and strength by value, and
    // the leak check's answer by SHA-1. Clients learn only each row's finding.
    const passwordFactsByRef = new Map<string, PasswordFacts>();
    const leakAnswers = new Map<string, { readonly leaked: boolean; readonly at: number }>();
    /** Saved passwords Scient stores itself; a linked one is never read just to check it. */
    const passwordHealth = Effect.gen(function* () {
      const rows: Array<{ summary: AccountSummary } & PasswordFacts> = [];
      const live = new Set<string>();
      for (const { summary, values } of state.accounts) {
        const ref = values["password"];
        if (
          summary.details.kind !== "website" ||
          summary.secrets["password"]?.source.type !== "scient" ||
          ref === undefined
        )
          continue;
        live.add(ref);
        let facts = passwordFactsByRef.get(ref);
        if (facts === undefined) {
          const value = yield* Effect.option(readValue(ref));
          if (Option.isNone(value)) continue;
          facts = passwordFacts(Redacted.value(value.value));
          passwordFactsByRef.set(ref, facts);
        }
        rows.push({ summary, ...facts });
      }
      for (const ref of passwordFactsByRef.keys())
        if (!live.has(ref)) passwordFactsByRef.delete(ref);
      return healthFindings(rows, (sha1) => leakAnswers.get(sha1)?.leaked === true);
    });
    const snapshotNow = Effect.gen(function* () {
      const unavailable = new Set(profileStore?.unavailable?.() ?? []);
      const snapshotAt = yield* Clock.currentTimeMillis;
      const undoable = unexpired(removed, snapshotAt);
      const health = yield* passwordHealth;
      const passwordUpdates = [...passwordUndos].flatMap(([undoId, entry]) =>
        entry.until > snapshotAt
          ? [
              {
                undoId,
                accountId: entry.accountId,
                name: entry.name,
                until: DateTime.formatIso(DateTime.makeUnsafe(entry.until)),
                ...(entry.field ? { field: entry.field } : {}),
              },
            ]
          : [],
      );
      // A new password still waiting for its site's answer isn't the person's to settle yet; one
      // whose answer never came by `settleBy` (a client closed or cut off) is, from then on.
      const pendingSecrets = (state.pending ?? []).flatMap((held) => {
        if (
          held.kind === "password" &&
          !held.unclear &&
          settling.has(held.pendingId) &&
          (held.settleBy === undefined || Date.parse(held.settleBy) > snapshotAt)
        )
          return [];
        const candidates =
          held.kind === "password" ? [] : factorLogins(held.origin, held.profileId);
        const named = candidates.filter(
          ({ details }) =>
            held.label !== undefined &&
            held.label !== "" &&
            details.kind === "website" &&
            details.username !== undefined &&
            loginUserKey(details.username) === loginUserKey(held.label),
        );
        // A factor's login: the one its label names, else the site's only saved login.
        const accountId =
          held.kind === "password"
            ? held.accountId
            : named.length === 1
              ? named[0]!.accountId
              : named.length === 0 && candidates.length === 1
                ? candidates[0]!.accountId
                : undefined;
        return [
          {
            pendingId: held.pendingId,
            kind: held.kind,
            site: held.origin,
            ...(held.profileId === undefined ? {} : { profileId: held.profileId }),
            ...(held.label ? { label: held.label } : {}),
            ...(accountId === undefined ? {} : { accountId }),
            ...(candidates.length
              ? { candidates: candidates.slice(0, 20).map((row) => row.accountId) }
              : {}),
            ...(held.unclear ? { unclear: true as const } : {}),
            ...(held.conflict ? { conflict: true as const } : {}),
            since: held.since,
          },
        ];
      });
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
      const host = yield* codesHost;
      const managedElsewhere: NonNullable<AccountsSnapshot["managedElsewhere"]> = customModelKeys
        .filter(({ connectionId }) => !migratedIds.has(connectionId))
        .map((connection) => ({
          kind: "custom-model" as const,
          id: connection.connectionId,
          name: connection.name,
          detail: connection.origin,
          href: "/settings/custom-models" as const,
        }));
      // One item per step: a sign-in's entry waits behind its live hand-off, which says the same.
      const waiting = new Set([...handoffs.values()].map((handoff) => handoff.accountId));
      const needsYou = (state.needsYou ?? []).filter(
        (need) =>
          !(
            need.accountId &&
            need.needId === `sign-in:${need.accountId}` &&
            waiting.has(need.accountId)
          ),
      );
      return {
        agentAccess: state.agentAccess,
        // Each login's earlier passwords for it as it is now, newest first, by an id that never
        // names its value.
        accounts: state.accounts.map((row) => {
          const { summary } = row;
          const password = summary.secrets["password"];
          const earlier = offeredVersions(row);
          // Each earlier password the person removed, its Undo open until it ends.
          const removedVersions = (state.removedVersions ?? []).flatMap((entry) =>
            entry.accountId === summary.accountId
              ? [
                  {
                    undoId: entry.undoId,
                    until: DateTime.formatIso(DateTime.makeUnsafe(entry.until)),
                  },
                ]
              : [],
          );
          if (!password || (earlier.length === 0 && removedVersions.length === 0)) return summary;
          const history = earlier.toReversed().map((entry) => {
            const savedAt = entry.savedAt ?? entry.usedAt;
            return {
              version: versionIdOf(entry.ref),
              ...(savedAt ? { savedAt } : {}),
              ...(entry.provenAt ? { provenAt: entry.provenAt } : {}),
              ...(entry.refused ? { refused: true as const } : {}),
            };
          });
          return {
            ...summary,
            secrets: {
              ...summary.secrets,
              password: {
                ...password,
                ...(history.length ? { history } : {}),
                ...(removedVersions.length ? { removedVersions } : {}),
              },
            },
          };
        }),
        profiles: state.profiles.map((profile) =>
          // Round 6l: held by this server's browser until it starts again.
          unavailable.has(profile.profileId)
            ? { ...clientProfile(profile), unavailable: true as const }
            : clientProfile(profile),
        ),
        ...(state.profileChoices ? { profileChoices: state.profileChoices } : {}),
        codeSources: state.codeSources ?? { messages: true },
        renewAutomatically: state.renewAutomatically ?? true,
        ...(state.codeNotices?.length ? { codeNotices: state.codeNotices } : {}),
        ...(host ? { codeSourcesHost: host } : {}),
        ...(state.neverAsk?.length ? { neverAsk: state.neverAsk } : {}),
        ...(state.cards && Object.keys(state.cards).length
          ? {
              cards: Object.entries(state.cards).map(([requestId, outcome]) => ({
                requestId,
                outcome,
                ...(state.cardAccounts?.[requestId] === undefined
                  ? {}
                  : { accountId: state.cardAccounts[requestId] }),
              })),
            }
          : {}),
        cardsSettling: [...settlingCards],
        ...(state.keyLinks ? { keyLinks: state.keyLinks } : {}),
        ...(state.detachedKeyLinks ? { detachedKeyLinks: state.detachedKeyLinks } : {}),
        stores: {
          scient: { protection },
          keychain: { available: protection === "keychain", platform: sources.platform },
          onePassword: state.onePasswordStatus,
          cli: cliStores.statuses(),
        },
        handoffs: [...handoffs.values()],
        ...(needsYou.length ? { needsYou } : {}),
        attempts: [...attempts.values()],
        signInEnds: [...signInEnds.values()],
        ...(state.universitySignOuts?.length
          ? { universitySignOuts: state.universitySignOuts }
          : {}),
        paperQueues: [...paperQueues.values()],
        approvals: [...pending.values()].map((entry) => entry.approval),
        ...(undoable.length
          ? {
              removed: undoable.map(({ row, removalId, operationId, until, threadId }) => ({
                accountId: row.summary.accountId,
                name: row.summary.name,
                removalId,
                ...(operationId === undefined ? {} : { operationId }),
                // Its own receipt says which chat removed it: the band names that one.
                ...(threadId === undefined ? {} : { threadId: threadId as ProfileThreadId }),
                until: DateTime.formatIso(DateTime.makeUnsafe(until)),
              })),
            }
          : {}),
        ...(passwordUpdates.length ? { passwordUpdates } : {}),
        ...(pendingSecrets.length ? { pendingSecrets } : {}),
        pendingFeatures: ["reserve", "page-seal"],
        recentActivity,
        customModelKeys,
        unavailableCustomModelKeyIds,
        keyConsumers: [...modelConsumers, ...transcriptionConsumers],
        ...(keyConsumersIncomplete ? { keyConsumersIncomplete: true } : {}),
        managedElsewhere,
        sameKeys: yield* sameKeys,
        ...(health.length ? { passwordHealth: health } : {}),
        ...(state.changes?.length ? { changes: state.changes } : {}),
        // Live ones: in their hour, or not ended yet (whose hour hasn't started).
        ...((state.profileOperations ?? []).some((operation) => live(operation, snapshotAt))
          ? {
              profileOperations: (state.profileOperations ?? []).filter((operation) =>
                live(operation, snapshotAt),
              ),
            }
          : {}),
        keyRefusals: (state.keyRefusals ?? []).flatMap(({ accountId, use, version, at }) =>
          findAccount(accountId)?.values.token === version ? [{ accountId, use, at }] : [],
        ),
        accountsProtocol: ACCOUNTS_PROTOCOL,
      } satisfies AccountsSnapshot;
    });
    const publish = Effect.fn("AccountsService.publish")(function* (invalidateKeys = true) {
      if (invalidateKeys) bindingRevision++;
      yield* PubSub.publish(events, yield* snapshotNow);
    });
    let resolutionWaitedForOpen = false;
    let reinstallModelKeyResolver: Effect.Effect<void> = Effect.void;
    const initialize = Effect.gen(function* () {
      if (initialized) return;
      protection = yield* vault.protection;
      const saved = yield* persistence.read("accounts-state");
      const activity = yield* persistence.read("accounts-activity");
      const loaded = Option.isSome(saved)
        ? yield* decodePrivateJson(AccountsState, withStoredAccountsFolded(saved.value))
        : emptyState;
      const log = Option.isSome(activity) ? yield* decodePrivateJson(Activity, activity.value) : [];
      const waiting = yield* persistence.read(REMOVED_ACCOUNTS_RECORD);
      // Removals read one by one: one that doesn't read loses only its own Undo (its values are
      // held below); one that isn't a list loses Undo, and the accounts themselves still open.
      const removedRaw = Option.isSome(waiting) ? rawRecord(waiting.value) : [];
      const removedParts = readRemovedAccounts(removedRaw);
      const removedRead = removedParts ? Option.some(removedParts.removed) : Option.none();
      removed = removedParts?.removed ?? [];
      cache.clear();
      onePasswordClient = undefined;
      state = loaded;
      recentActivity = log.slice(-500);
      initialized = true;
      // Values the stored records name that didn't read (a record, or part of one, dropped by
      // the fold): kept for good, never deleted, and nothing is swept this run.
      const lost = [
        ...(Option.isSome(saved) ? rawLists(rawRecord(saved.value)) : []),
        ...(Option.isSome(waiting) && Option.isNone(removedRead)
          ? [["removed", rawRecord(waiting.value)] as const]
          : []),
      ];
      const decodedLists = new Map<string, unknown>([
        ...Object.entries(loaded),
        ["removed", removed],
      ]);
      // Every dropped record (or entry within one) holds every value it names, whatever else
      // names it; every record that reads, what its stored form names that its reading doesn't
      // (a field this build doesn't know); then whatever else the read let go, list by list.
      const records = Option.isSome(saved)
        ? storedRecords(rawRecord(saved.value))
        : { dropped: [], read: [] };
      const droppedRaw = [
        ...records.dropped,
        ...(removedParts?.dropped ?? []).map((record) => ({
          list: "removed",
          record,
          within: undefined,
        })),
      ];
      const stripped = [
        ...records.read,
        ...(removedParts?.read ?? []).map(({ record, decoded }) => ({
          list: "removed",
          record,
          decoded,
        })),
      ].flatMap(({ list, record, decoded }) => {
        const kept = refsIn(decoded);
        const refs = [...refsIn(record)].filter((ref) => !kept.has(ref));
        if (refs.length === 0) return [];
        const accountId = recordAccountId(record);
        return [{ list, ...(accountId === undefined ? {} : { accountId }), refs }];
      });
      // An escrow journal entry that didn't read (no or unknown provenance): quarantined by name,
      // never swept (`unreferencedEscrows`).
      const quarantined = droppedRaw.flatMap(({ list, record }) =>
        list !== "escrowJournal"
          ? []
          : typeof record === "string"
            ? [record]
            : typeof record === "object" &&
                record !== null &&
                "name" in record &&
                typeof record.name === "string"
              ? [record.name]
              : [],
      );
      const dropped = droppedRaw.flatMap(({ list, record, within }) => {
        const refs = [...refsIn(record)];
        // An entry's own login first (an older build's held target names its login), else its
        // record's: the hold goes with that login's removal.
        const accountId =
          recordAccountId(record) ?? (within === undefined ? undefined : recordAccountId(within));
        // An escrow record that didn't read holds its escrow by its id, with or without a ref;
        // one with neither still leaves a nameless hold (`escrowsUncertain`).
        const legacyId =
          list === "customModelEscrows" &&
          typeof record === "object" &&
          record !== null &&
          "legacyId" in record &&
          typeof record.legacyId === "string"
            ? record.legacyId
            : undefined;
        return refs.length || legacyId !== undefined || list === "customModelEscrows"
          ? [
              {
                list,
                ...(accountId === undefined ? {} : { accountId }),
                refs,
                ...(legacyId === undefined ? {} : { escrow: customModelEscrowName(legacyId) }),
              },
            ]
          : [];
      });
      // A hold is its list's, its login's and its value's or escrow's: one already kept for
      // another login never stands in for this one (each goes with its own login).
      const holdKey = (entry: { list: string; accountId?: string | undefined }, name: string) =>
        `${entry.list}\u0000${entry.accountId ?? ""}\u0000${name}`;
      const held = new Set(
        (loaded.unreadable ?? []).flatMap((entry) => [
          ...entry.refs.map((ref) => holdKey(entry, ref)),
          ...(entry.escrow ? [holdKey(entry, entry.escrow)] : []),
        ]),
      );
      const unread = [
        ...dropped,
        ...stripped,
        ...lostRefs(lost, (list) => refsIn(decodedLists.get(list))),
      ].flatMap((entry) => {
        const refs = entry.refs.filter((ref) => !held.has(holdKey(entry, ref)));
        // Once per list, login and value this run too.
        for (const ref of refs) held.add(holdKey(entry, ref));
        const escrow: string | undefined =
          "escrow" in entry &&
          typeof entry.escrow === "string" &&
          !held.has(holdKey(entry, entry.escrow))
            ? entry.escrow
            : undefined;
        if (escrow !== undefined) held.add(holdKey(entry, escrow));
        // A nameless escrow hold stays whatever it shares: while it does, no escrow is swept.
        const nameless =
          entry.list === "customModelEscrows" &&
          !("escrow" in entry && typeof entry.escrow === "string");
        if (refs.length === 0 && escrow === undefined && !nameless) return [];
        return [
          {
            list: entry.list,
            ...(entry.accountId === undefined ? {} : { accountId: entry.accountId }),
            refs,
            ...(escrow === undefined ? {} : { escrow }),
          },
        ];
      });
      everyListRead = unread.length === 0 && Option.isSome(removedRead);
      if (unread.length || quarantined.length)
        yield* commit(
          {
            ...state,
            unreadable: [...(state.unreadable ?? []), ...unread],
            ...(quarantined.length
              ? {
                  unreferencedEscrows: [
                    ...new Set([...(state.unreferencedEscrows ?? []), ...quarantined]),
                  ],
                }
              : {}),
          },
          true,
        );
      // Named after the holds are on disk; an Activity that can't be written names them next start.
      yield* nameUnreadablePins.pipe(Effect.ignore);
      yield* keepRemoved(removed);
      yield* keepUsedCodesOnLogins;
      yield* keepUnconfirmedInHistory;
      // Password Undos come back with the state (`expirePending` prunes those past their hour).
      passwordUndos.clear();
      for (const { undoId, copies, ...receipt } of state.passwordUndos ?? [])
        passwordUndos.set(undoId, {
          ...receipt,
          copies: copies.map(
            ({ beforeRef, beforeSecret, identity, afterRevision, beforeRevision, ...copy }) => ({
              ...copy,
              ...(beforeRef === undefined ? {} : { beforeRef }),
              ...(beforeSecret === undefined ? {} : { beforeSecret }),
              ...(identity === undefined ? {} : { identity }),
              ...(afterRevision === undefined ? {} : { afterRevision }),
              ...(beforeRevision === undefined ? {} : { beforeRevision }),
            }),
          ),
        });
      yield* expirePending;
      // Values a write let go are deleted once the permit is free (then each minute).
      yield* sweepUnreferenced.pipe(Effect.ignore, Effect.forkIn(serviceScope));
      // This server's browser opens each profile in the generation Clear left it in.
      if (profileStore) yield* profileStore.generations(generations());
      // Attached before this first read: what it says of other desktops' lists applies (6i).
      if (profileStore) yield* dropForeignLists;
      yield* publish();
      if (profileStore) yield* resumeUnfinished;
      // Custom-model keys refused while the store was closed resolve again now.
      if (resolutionWaitedForOpen) {
        resolutionWaitedForOpen = false;
        yield* reinstallModelKeyResolver.pipe(Effect.forkIn(serviceScope));
      }
    });
    /** Keeps the list of rows Undo can bring back, deleting the values of those past their hour. */
    // An entry past its hour stays listed until its values are deleted, so a failed or cut-short
    // deletion is tried again; Undo can no longer take it.
    const keepRemoved = Effect.fn("AccountsService.keepRemoved")(function* (next: RemovedAccounts) {
      const now = yield* Clock.currentTimeMillis;
      const listed = next.filter((entry) => entry.until > now);
      // Past its hour a row's values are let go: journaled before the list drops it, for the
      // sweep to take what nothing else names.
      const lapsed = [...refsIn(next.filter((entry) => entry.until <= now))];
      if (lapsed.length)
        yield* commit(
          { ...state, unreferenced: [...new Set([...(state.unreferenced ?? []), ...lapsed])] },
          true,
        );
      if (listed.length || removed.length)
        yield* persistence.write(
          REMOVED_ACCOUNTS_RECORD,
          yield* encodePrivateJson(RemovedAccounts, listed),
        );
      const purged = listed.length < next.length;
      removed = listed;
      // A purged row's Custom models escrow goes with it, as a commit prunes it.
      if (purged && (state.customModelEscrows?.length ?? 0) > 0) yield* commit(state, true);
    });
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      writes.withPermits(1)(Effect.uninterruptible(initialize.pipe(Effect.andThen(effect))));
    /**
     * Set while a bulk change runs: commits only update `state`, written and published once at the
     * end. `written` is the state on disk meanwhile, `reserved` the value names journaled there.
     */
    let batch: { dirty: boolean; written: AccountsState; reserved: Array<string> } | undefined;
    /** Every stored list read whole at start: else nothing is swept this run. */
    let everyListRead = true;
    const commit = Effect.fn("AccountsService.commit")(function* (
      proposed: AccountsState,
      usageOnly = false,
      previousAccounts: readonly StoredAccount[] = state.accounts,
      /** What sign-ins are compared with: a row brought back by Undo signed in nothing new. */
      signInsBefore: AccountsState = state,
    ) {
      // Every path that records a sign-in passes here, in the same locked write.
      const at = yield* now;
      // Every password a login held stays in its history, in the same write as the new one.
      const { state: historied } = withPasswordHistory(
        state,
        withProfileVersions(
          state,
          withSendLog(
            signInsBefore,
            withNeedsYouSettled(withMainSignOutsCleared(signInsBefore, proposed)),
          ),
          at,
        ),
        at,
      );
      const revised = withRevisions(
        state,
        withCurrentRefusals(withRemovedInUse(withUnreadableReleased(state, historied))),
      );
      // An escrow whose row is gone goes, unless its token is held for a record that didn't read
      // (that row may be it). A bulk change prunes none: its one write at the end does.
      const unreadRefs = new Set((revised.unreadable ?? []).flatMap((entry) => entry.refs));
      const expiredEscrows = batch
        ? []
        : (revised.customModelEscrows ?? []).filter(
            (row) =>
              !unreadRefs.has(row.tokenRef) &&
              ![...revised.accounts, ...removed.map((entry) => entry.row)].some(
                ({ summary, values }) =>
                  summary.accountId === row.accountId && values.token === row.tokenRef,
              ),
          );
      const pruned = expiredEscrows.length
        ? {
            ...revised,
            customModelEscrows:
              revised.customModelEscrows?.filter((row) => !expiredEscrows.includes(row)) ?? [],
          }
        : revised;
      // Every value the final state lets go is journaled in this write, and every one it names
      // leaves the journal: the sweep, the one deleter, takes only what nothing names. An
      // expired escrow is journaled the same way, by name, unless a row or a hold still names it.
      const namedAfter = refsIn({ ...pruned, unreferenced: [] });
      const letGo = [...refsIn({ ...state, unreferenced: [] })].filter(
        (ref) => !namedAfter.has(ref),
      );
      const journal = [...new Set([...(pruned.unreferenced ?? []), ...letGo])].filter(
        (ref) => !namedAfter.has(ref),
      );
      const escrowsNamed = namedEscrows(pruned);
      const escrowsGone = expiredEscrows.filter(
        ({ legacyId }) => !escrowsNamed.has(customModelEscrowName(legacyId)),
      );
      // Journaled with its provenance: only entries this build wrote are ever swept.
      const before = pruned.escrowJournal ?? [];
      const escrowJournal = [
        ...new Set([
          ...before.map(({ name }) => name),
          ...escrowsGone.map(({ legacyId }) => customModelEscrowName(legacyId)),
        ]),
      ]
        .filter((name) => !escrowsNamed.has(name))
        .map((name) => ({ name, provenance: "decoded-row" as const }));
      const next = {
        ...pruned,
        ...(journal.length === (pruned.unreferenced ?? []).length && letGo.length === 0
          ? {}
          : { unreferenced: journal }),
        ...(escrowJournal.length === before.length && escrowsGone.length === 0
          ? {}
          : { escrowJournal }),
      };
      // Invalidate before the first write: cache hits must not bypass an in-flight revocation.
      if (!usageOnly) bindingRevision++;
      if (batch) {
        state = next;
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
      // A restored slot goes with the last row naming its escrow; the escrow itself, with the sweep.
      for (const escrow of escrowsGone)
        yield* (
          sources.modelCatalog
            ?.removeLegacy(escrow.legacyId)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not remove a restored Custom models slot."),
              ),
            ) ?? Effect.void
        );
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
      const current = { dirty: false, written: state, reserved: new Array<string>() };
      batch = current;
      const exit = yield* Effect.exit(effect);
      batch = undefined;
      if (current.dirty) yield* commit(state, false, previousAccounts);
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
    /** Each pin that can't be read, named once in Activity on the row it was for. */
    const nameUnreadablePins = Effect.gen(function* () {
      for (const pin of readTaskPins(state.taskPins).unreadable) {
        const detail = `Scheduled task ${pin.scheduledTaskId.slice(0, 80)}: its pin couldn't be read. Pin it again.`;
        const target: AccountTarget =
          pin.accountId !== undefined && findAccount(pin.accountId as AccountId)
            ? { type: "account", accountId: pin.accountId as AccountId }
            : { type: "profile", profileId: DEFAULT_BROWSER_PROFILE_ID };
        if (recentActivity.some((entry) => entry.detail === detail)) continue;
        yield* appendActivity({ target, action: "sign-in", decision: "denied", detail });
      }
    });
    const findAccount = (accountId: AccountId) =>
      state.accounts.find((account) => account.summary.accountId === accountId);
    /** Each write of only access or scope: its new `updatedAt`, mapped to the one it replaced. */
    const controlsWrites = new Map<string, string>();
    // Whether the row is the one read at `updatedAt`, but for access and scope: those are checked
    // live, so an approval in between leaves the use it approved standing.
    const unchangedSince = (row: StoredAccount | undefined, updatedAt: string) => {
      let at = row?.summary.updatedAt;
      while (at !== undefined && at !== updatedAt)
        at = controlsWrites.get(`${row!.summary.accountId}\u0000${at}`);
      return at !== undefined;
    };
    const speechOnly = (account: Pick<AccountSummary, "details">) =>
      account.details.kind === "api-key" && account.details.speechOnly === true;
    const privateUse = ({ details }: Pick<AccountSummary, "details">) =>
      details.kind === "api-key" ? details.privateTo : undefined;
    const privateModelKey = ({ details, controls }: AccountSummary) =>
      details.kind === "api-key" &&
      details.purpose === "custom-models" &&
      controls.access === "off";

    const targetControls = (target: AccountTarget) => {
      if (target.type === "account") {
        const summary = findAccount(target.accountId)?.summary;
        return summary && !privateUse(summary) ? summary.controls : undefined;
      }
      const record = effectiveProfile(state.profiles, target.profileId);
      // Merged into Main or removed: no agent uses it, whatever its controls were.
      return record.retired || record.removed ? { ...record, access: "off" as const } : record;
    };
    /** When each Google row was first answered absent or not valid, until a second answer. */
    const googleOutSince = new Map<string, number>();
    /** A run of a pinned scheduled task uses its pinned sign-in and profile only. */
    const pinnedRefusal = (scope: AccountUseScope, target: AccountTarget) => {
      if (scope.scheduledTaskId === UNKNOWN_RUN) {
        const row = target.type === "account" ? findAccount(target.accountId)?.summary : undefined;
        return row !== undefined && row.details.kind !== "website"
          ? undefined
          : UNKNOWN_RUN_REFUSAL;
      }
      if (scope.scheduledTaskId === undefined) return undefined;
      const pin = taskPinIn(state.taskPins, scope.scheduledTaskId);
      // A pin that can't be read binds its task to nothing until it is pinned again.
      if (pin === "unreadable") {
        const row = target.type === "account" ? findAccount(target.accountId)?.summary : undefined;
        return row !== undefined && row.details.kind !== "website" ? undefined : UNREADABLE_PIN;
      }
      return pin === undefined || !pinBinds(pin, scope.projectId)
        ? undefined
        : pinRefusal(
            pin,
            target,
            target.type === "account" ? findAccount(target.accountId)?.summary : undefined,
          );
    };
    /** `authorizeUse`'s check, for a caller already holding the lock. */
    const useRefusal = (
      scope: AccountUseScope,
      target: AccountTarget,
      use: Parameters<AccountsServiceShape["authorizeUse"]>[2],
    ): Effect.Effect<void, AccountsError> => {
      const controls = targetControls(target);
      const row = target.type === "account" ? findAccount(target.accountId) : undefined;
      const details = row?.summary.details;
      // Allowed now, or Ask with this conversation's approval: Allowed turned Ask meanwhile
      // is not the authorization the use was given.
      const allowed =
        controls !== undefined &&
        (use?.linked === true
          ? // A key kept for this one use reaches it as its typed key did: Off isn't for it.
            (row !== undefined && use.key !== undefined && privateUse(row.summary) !== undefined
              ? true
              : !agentAccessOff(state.agentAccess, controls.access)) &&
            inScope(controls.scope, scope.projectId)
          : authorizationDecision(
              state.agentAccess,
              controls,
              scope,
              scope.threadId !== undefined &&
                conversationGrants.has(grantKey(scope.threadId, target)),
            ).decision === "allowed") &&
        (use?.key === undefined || (row !== undefined && keyServesUse(row.summary, use.key))) &&
        (use?.since === undefined || unchangedSince(row, use.since.updatedAt)) &&
        (use?.origin === undefined ||
          (details !== undefined && "sites" in details && siteMatches(details.sites, use.origin)));
      const pinned = pinnedRefusal(scope, target);
      if (pinned !== undefined) return fail("denied", pinned);
      return allowed ? Effect.void : fail("denied", "Access to this account changed. Ask again.");
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
    /** Which desktop carries out each operation's part, by `operationId:phase:part`. */
    const claims = new Map<string, string>();
    /** Tabs being opened in each profile, by their chats, until the open has ended. */
    const admitting = new Map<string, Map<symbol, ProfileThreadId>>();
    const destinationLocks = new Map<string, Semaphore.Semaphore>();
    const changeNotice = (
      noticeId: string,
      change: (entry: AccountCodeNotice) => AccountCodeNotice,
      current?: () => boolean,
    ) =>
      locked(
        Effect.suspend(() => {
          if (current?.() === false) return Effect.void;
          const entries = state.codeNotices ?? [];
          const next = entries.map((entry) =>
            entry.noticeId === noticeId ? change(entry) : entry,
          );
          return next.every((entry, index) => entry === entries[index])
            ? Effect.void
            : commit({ ...state, codeNotices: next }, true);
        }),
      );
    /** One pin or trigger edit at a time per scheduled task (`withTaskEdit`). */
    const taskEdits = new Map<string, Semaphore.Semaphore>();
    const withTaskEdit = <A, E, R>(scheduledTaskId: string, effect: Effect.Effect<A, E, R>) => {
      const lock = taskEdits.get(scheduledTaskId) ?? Semaphore.makeUnsafe(1);
      taskEdits.set(scheduledTaskId, lock);
      return lock.withPermits(1)(effect);
    };
    const destinationLock = (item: string) => {
      let lock = destinationLocks.get(item);
      if (!lock) destinationLocks.set(item, (lock = Semaphore.makeUnsafe(1)));
      return lock;
    };
    let codeSourcesVersion = 0;
    /** Sign-outs this process recorded, by sequence: an attempt compares them at each write. */
    let signOutSequence = 0;
    let recentSignOuts: ReadonlyArray<SignOut & { readonly sequence: number }> = [];
    const signOutRecorded = (profileId: BrowserProfileId, site: string) => {
      signOutSequence++;
      recentSignOuts = [...recentSignOuts, { profileId, site, sequence: signOutSequence }].slice(
        -200,
      );
      return commit({ ...state, signedOut: withSignOut(state.signedOut, profileId, site) }, true);
    };
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
        const updatedAt = laterThan(existing.summary.updatedAt, yield* now);
        yield* commit(
          replaceAccount({ ...existing, summary: { ...existing.summary, controls, updatedAt } }),
        );
        const was = existing.summary.controls;
        if (was.permission === controls.permission && was.visibility === controls.visibility)
          controlsWrites.set(`${target.accountId}\u0000${updatedAt}`, existing.summary.updatedAt);
        cache.delete(target.accountId);
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
    /** The person's controls write; an agent's goes through `agentControls` first. */
    const applyControls = Effect.fn("AccountsService.applyControls")(function* (
      input: AccountSetControlsInput,
    ) {
      const controls = targetControls(input.target);
      if (!controls) return yield* missing();
      const next = {
        ...controls,
        ...(input.access ? { access: input.access, allowedProjects: [] } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
      };
      if (input.target.type === "account") {
        const accountId = input.target.accountId;
        yield* takeBackLinks(
          (link) => link.accountId !== accountId || keyReachesProviders(state.agentAccess, next),
        );
      }
      yield* writeControls(
        input.target,
        "profileId" in next
          ? {
              ...next,
              ...(input.scriptSignIn === undefined ? {} : { scriptSignIn: input.scriptSignIn }),
            }
          : {
              ...next,
              ...(input.permission ? { permission: input.permission } : {}),
              ...(input.visibility ? { visibility: input.visibility } : {}),
            },
      );
      yield* denyRevoked;
    });
    /** An agent's change, with its chat, for the person to see (AMENDMENTS 56). */
    const appendChange = Effect.fn("AccountsService.appendChange")(function* (
      entry: Omit<AccountChange, "at" | "threadId" | "projectId">,
      by: AccountChangeBy,
    ) {
      const change: AccountChange = {
        ...entry,
        at: yield* now,
        ...(by.threadId === undefined ? {} : { threadId: by.threadId }),
        ...(by.projectId === undefined ? {} : { projectId: by.projectId }),
      };
      yield* commit({ ...state, changes: [...(state.changes ?? []), change].slice(-200) }, true);
    });
    /**
     * The one deleter of journaled values and escrows, SWEEP_BATCH of each a pass, once every
     * list read; never one anything names, nor an escrow while an escrow hold lacks its name.
     * One still named, or not deleted, goes to its list's end.
     */
    const sweepUnreferenced: Effect.Effect<void, AccountsError> = locked(
      Effect.gen(function* () {
        if (!everyListRead) return;
        const kept = refsIn({ ...state, unreferenced: [] }, removed, [...passwordUndos.values()]);
        const escrowsKept = namedEscrows(state);
        const pass = Effect.fn("AccountsService.sweepPass")(function* (
          list: ReadonlyArray<string>,
          keep: (name: string) => boolean,
          remove: (name: string) => Effect.Effect<void, AccountsError>,
        ) {
          const waiting = list.slice(0, SWEEP_BATCH);
          const gone: string[] = [];
          for (const name of waiting.filter((name) => !keep(name))) {
            const deleted = yield* remove(name).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (deleted) gone.push(name);
          }
          if (gone.length === 0 && list.length <= SWEEP_BATCH) return undefined;
          return [
            ...list.filter((name) => !waiting.includes(name)),
            ...waiting.filter((name) => !gone.includes(name)),
          ];
        });
        const values = yield* pass(
          state.unreferenced ?? [],
          (ref) => kept.has(ref),
          (ref) => persistence.remove(ref),
        );
        // Only escrows this build journaled (`escrowJournal`); inherited names stay quarantined.
        const escrows = escrowsUncertain(state)
          ? undefined
          : yield* pass(
              (state.escrowJournal ?? []).map(({ name }) => name),
              (name) => escrowsKept.has(name),
              (name) => persistence.removeEscrow(name),
            );
        if (!values && !escrows) return;
        yield* commit(
          {
            ...state,
            ...(values ? { unreferenced: values } : {}),
            ...(escrows
              ? {
                  escrowJournal: escrows.map((name) => ({
                    name,
                    provenance: "decoded-row" as const,
                  })),
                }
              : {}),
          },
          true,
        );
      }),
    );
    /**
     * Writes a new value under a new name (or a derived one, `fixed`) journaled on disk first: a
     * write whose metadata never lands leaves it to the next sweep; the commit naming it takes it
     * off the journal. A bulk change reserves names on disk STAGE_RESERVE at a time instead.
     */
    const stageValue = Effect.fn("AccountsService.stageValue")(function* (
      value: Redacted.Redacted<Uint8Array>,
      fixed?: string,
    ) {
      if (batch && fixed === undefined) {
        if (batch.reserved.length === 0) {
          const names = Array.from({ length: STAGE_RESERVE }, () => valueName());
          const written: AccountsState = {
            ...batch.written,
            unreferenced: [...(batch.written.unreferenced ?? []), ...names],
          };
          yield* persistence.write("accounts-state", yield* encodeAccountsState(written));
          batch.written = written;
          batch.reserved.push(...names);
          state = { ...state, unreferenced: [...(state.unreferenced ?? []), ...names] };
        }
        const name = batch.reserved.shift()!;
        yield* persistence.write(name, value);
        return name;
      }
      const name = fixed ?? valueName();
      yield* commit({ ...state, unreferenced: [...(state.unreferenced ?? []), name] }, true);
      yield* persistence.write(name, value);
      return name;
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
      const client = yield* sources.onePassword(Redacted.make(input));
      // Made without the write permit: a disconnect meanwhile must not get it back.
      if (state.onePassword === config) onePasswordClient = client;
      return client;
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
        // A row that read its key from a connection's slot keeps its id and rights once the slot
        // is gone, since connectors, plugins and others may name it: it gets its own copy of the
        // key the connection now keeps in Accounts, and variable links move to that row so a
        // rotation reaches them. Without that key the row and its links stay as they are.
        const retireModelAliases = Effect.fn("AccountsService.retireModelAliases")(function* (
          connectionId: string,
          targetId?: AccountId,
        ) {
          const aliases = state.accounts.filter(({ summary }) => {
            const token = summary.secrets.token;
            return (
              summary.details.kind === "api-key" &&
              summary.accountId !== targetId &&
              token?.source.type === "custom-model" &&
              token.source.connectionId === connectionId &&
              !token.copies?.length
            );
          });
          const target = targetId ? findAccount(targetId) : undefined;
          if (!aliases.length || !target?.values.token) return;
          const value = yield* readValue(target.values.token);
          for (const alias of aliases) {
            const valueRef = yield* stageValue(
              Redacted.make(new TextEncoder().encode(Redacted.value(value))),
            );
            const latest = findAccount(alias.summary.accountId);
            if (!latest) continue;
            const hint = target.summary.secrets.token?.hint;
            const kept = replaceAccount({
              ...latest,
              summary: {
                ...latest.summary,
                secrets: {
                  ...latest.summary.secrets,
                  token: { source: { type: "scient" }, ...(hint ? { hint } : {}) },
                },
              },
              values: { ...latest.values, token: valueRef },
            });
            yield* commit({
              ...kept,
              ...(kept.keyLinks
                ? {
                    keyLinks: kept.keyLinks.map((link) =>
                      link.accountId === alias.summary.accountId
                        ? { ...link, accountId: target.summary.accountId }
                        : link,
                    ),
                  }
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
          // Their values are journaled by this write (`commit`).
          yield* commit({ ...state, pendingCustomModelKeys: unused });
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
              yield* stageValue(
                Redacted.make(new TextEncoder().encode(Redacted.value(key))),
                valueRef,
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
              yield* setPending(accountId, undefined);
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
        // No orphan pass: an escrow is journaled only by a write that read the record naming it
        // and drops it. One no record names stays on disk (a leak, never a loss).
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
    /** Where each field's value is kept: when it changes, a value read before is out of date. */
    /** Bumped on every 1Password connect and disconnect: a read through the old client is stale. */
    let storeGeneration = 0;
    const valuesVersion = (account: StoredAccount | undefined, fields: ReadonlyArray<string>) =>
      JSON.stringify([
        storeGeneration,
        ...fields.map((field) => [account?.summary.secrets[field]?.source, account?.values[field]]),
      ]);
    // External stores can wait on a prompt, so they are read without the write permit. The row
    // must hold the same values afterwards; if it changed meanwhile, it is read once more.
    const readOutside = Effect.fn("AccountsService.readOutside")(function* (
      accountId: AccountId,
      fields: ReadonlyArray<string>,
    ) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = yield* locked(
          Effect.sync(() => valuesVersion(findAccount(accountId), fields)),
        );
        const read = yield* resolve(accountId, fields).pipe(Effect.result);
        const version = yield* locked(
          Effect.sync(() => valuesVersion(findAccount(accountId), fields)),
        );
        if (version !== before) continue;
        if (read._tag === "Failure") return yield* read.failure;
        return { values: read.success, version };
      }
      return yield* fail("conflict", "The account changed while it was read. Try again.");
    });
    type SaveLater = { finish?: Effect.Effect<AccountSaveResult, AccountsError> };
    /** The ref a login already keeps `value` under: its password, Previous or history. */
    const keptRef = Effect.fn("AccountsService.keptRef")(function* (
      row: StoredAccount,
      value: string,
    ) {
      // Its removed versions too: saved again, the value comes back under its own ref (`commit`
      // then drops the removal).
      const refs = new Set(
        [
          row.values["password"],
          row.previous?.password,
          ...historyOf(row.summary.accountId).map((entry) => entry.ref),
          ...(state.removedVersions ?? [])
            .filter((entry) => entry.accountId === row.summary.accountId)
            .map((entry) => entry.version.ref),
        ].filter((ref): ref is string => ref !== undefined),
      );
      for (const ref of refs) {
        const held = yield* Effect.option(readValue(ref));
        if (Option.isSome(held) && Redacted.value(held.value) === value) return ref;
      }
      return undefined;
    });
    const save = Effect.fn("AccountsService.save")(function* (
      input: AccountSaveInput,
      migrationId?: AccountId,
      /** Linked values read before the write permit was taken. */
      linkedValues?: Readonly<Record<string, Redacted.Redacted<string>>>,
      /**
       * Given, the copies to the Keychain and 1Password are left in `later.finish` for the caller
       * to run once it has released the write permit; it returns the final result.
       */
      later?: { finish?: Effect.Effect<AccountSaveResult, AccountsError> },
      /** The password goes back to this ref of the login's history, no new value written. */
      reuse?: string,
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
      const copyWarnings: Record<string, string[]> = Object.create(null);
      let previous = existing?.previous;
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
        const replaced = values[field];
        delete values[field];
        // A website's replaced password is kept for recovery; clearing it lets it go. Saving the
        // same password again (a retry, a lost reply) keeps the one it replaced.
        const unchanged =
          replaced !== undefined &&
          change.type === "scient" &&
          (yield* readValue(replaced).pipe(
            Effect.map((value) => Redacted.value(value) === change.value),
            Effect.orElseSucceed(() => false),
          ));
        if (input.details.kind === "website" && field === "password" && !unchanged)
          previous =
            change.type === "clear"
              ? undefined
              : replaced && change.type === "scient"
                ? { password: replaced }
                : previous;
        const previousPending = pendingCopies[field];
        delete pendingCopies[field];
        if (change.type === "clear") {
          delete secrets[field];
          continue;
        }
        const old = secrets[field];
        const readOnlyLink = change.type === "bitwarden" || change.type === "proton-pass";
        const linked = change.type !== "scient" && !readOnlyLink && Boolean(old?.copies?.length);
        // The person's save read it before the permit; a copy added since asks them to save again.
        if (linked && linkedValues && !linkedValues[field])
          return yield* fail("conflict", "The account changed meanwhile. Save again.");
        const linkedValue = !linked
          ? undefined
          : linkedValues?.[field]
            ? linkedValues[field]
            : change.type === "keychain"
              ? yield* sources.keychain(change)
              : change.type === "custom-model"
                ? yield* legacyModelKey(change.connectionId)
                : change.type === "1password"
                  ? yield* (yield* getOnePasswordClient).resolve(change.reference)
                  : undefined;
        if (change.type === "scient" || linkedValue) {
          const value = change.type === "scient" ? Redacted.make(change.value) : linkedValue!;
          // A value the login already keeps (held, Previous, history) is saved again under its
          // own ref: never a second copy of it.
          const kept =
            field === "password" && existing && input.details.kind === "website"
              ? (reuse ?? (yield* keptRef(existing, Redacted.value(value))))
              : undefined;
          const name =
            kept ??
            (yield* stageValue(Redacted.make(new TextEncoder().encode(Redacted.value(value)))));
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
            ...(field === "recovery"
              ? {
                  left: backupCodeList(
                    Redacted.value(value),
                    change.type === "scient" && change.lines === true,
                  ).length,
                  ...(change.type === "scient" && change.lines ? { lines: true as const } : {}),
                }
              : {}),
            ...(change.type === "scient" && change.changedAt
              ? { changedAt: change.changedAt }
              : {}),
            ...(previous && field === "password" && input.details.kind === "website"
              ? { previousAt: previous === existing?.previous ? old?.previousAt : timestamp }
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
          // Everything new starts Allowed; a legacy speech key moved in keeps its reach, Off.
          (migrationId !== undefined && isSpeech
            ? { ...defaultAccountControls("api-key"), access: "off" as const }
            : defaultAccountControls(input.details.kind)),
        status:
          warnings.length || Object.values(pendingCopies).some((targets) => targets.length)
            ? "needs-attention"
            : "ready",
        ...(warnings.length ? { statusMessage: warnings[0] } : {}),
        // A new password, code or key is untried: a held attempt's result no longer applies, and
        // on a website that is the user's reset of the hold, written as an action. A live or
        // ended session is the site's own state and stays.
        ...(!input.secrets?.password && !input.secrets?.totp && !input.secrets?.token
          ? existing?.summary.signIn
            ? { signIn: existing.summary.signIn }
            : {}
          : existing && input.details.kind === "website"
            ? signedOutOnPurpose(existing.summary.signIn) ||
              (existing.summary.signIn && !signInStopped(existing.summary.signIn))
              ? { signIn: existing.summary.signIn }
              : {
                  signIn: {
                    state: "unknown" as const,
                    at: timestamp,
                    detail: "Password changed",
                    by: "action" as const,
                  },
                }
            : {}),
        createdAt: existing?.summary.createdAt ?? timestamp,
        updatedAt: existing ? laterThan(existing.summary.updatedAt, timestamp) : timestamp,
        ...(existing?.summary.lastUsedAt ? { lastUsedAt: existing.summary.lastUsedAt } : {}),
      });
      // Persist the new value before external writes; a rejected copy never loses the user's password.
      // Each field this save writes counts one write more, even the same value again: a receipt or
      // a deferred copy of an earlier write then no longer applies.
      const prior = existing?.revisions ?? {};
      yield* commit(
        replaceAccount({
          summary: summary(),
          values: { ...values },
          pendingCopies: { ...pendingCopies },
          ...(previous ? { previous } : {}),
          ...(existing?.usedCodes ? { usedCodes: existing.usedCodes } : {}),
          revisions: {
            ...prior,
            ...Object.fromEntries(
              Object.keys(input.secrets).map((field) => [field, ownCount(prior, field) + 1]),
            ),
          },
        }),
      );
      const wrote = { ...values };
      // Each field's copies count only while that field's own write stands: a later save of
      // another field leaves this one's settlement alone.
      const revisionNow = (field: string) => ownCount(findAccount(accountId)?.revisions, field);
      const firstWrite = new Map(
        Object.keys(input.secrets).map((field) => [field, revisionNow(field)]),
      );
      const fresh = (field: string) =>
        findAccount(accountId) !== undefined && revisionNow(field) === firstWrite.get(field);
      /** Every field's write count after this save's own: a later write changes one of them. */
      const writtenThen = writeCounts(findAccount(accountId)?.revisions);
      const readOnlyVaults: Array<unknown> = [];
      const copy = Effect.gen(function* () {
        for (const { field, value, destinations, primary: preferred } of updates) {
          if (!fresh(field)) continue;
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
            // One write at a time per item; a write a later save superseded is never made.
            // References can name one 1Password item in several ways: all of 1Password is one queue.
            const item =
              destination.type === "keychain"
                ? `keychain:${destination.service}:${destination.account}`
                : "1password";
            const written = yield* destinationLock(item).withPermits(1)(
              Effect.suspend(() =>
                fresh(field) ? operation.pipe(Effect.result) : Effect.undefined,
              ),
            );
            if (!written) break;
            const result = written;
            if (result._tag === "Success") completed.push(result.success);
            else {
              failed = true;
              if (destination.type === "keychain") retry.push({ type: "keychain" });
              else if (vaultId) retry.push({ type: "1password", vaultId });
              if (
                destination.type === "1password" &&
                result.failure.reason === "denied" &&
                vaultInfo
              )
                readOnlyVaults.push(vaultInfo);
              (copyWarnings[field] ??= []).push(
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
            copies: completed.filter(
              (source) => JSON.stringify(source) !== JSON.stringify(primary),
            ),
          };
          if (
            primary.type !== "scient" &&
            !secrets[field]?.copies?.some((source) => source.type === "scient")
          )
            delete values[field];
        }
      });
      const settle = Effect.gen(function* () {
        const status = state.onePasswordStatus;
        if (readOnlyVaults.length && status.state === "connected")
          state = {
            ...state,
            onePasswordStatus: {
              ...status,
              vaults:
                status.vaults?.map((vault) =>
                  readOnlyVaults.includes(vault) ? { ...vault, readOnly: true } : vault,
                ) ?? [],
            },
          };
        // Edited again while the copies were written: that later save keeps its own. Otherwise only
        // where each copied field's copies went (source, copies) goes onto the row as it is now:
        // never a ref nor a Previous captured before (another save may have let them go since).
        const current = findAccount(accountId);
        const settled = updates.filter(({ field }) => fresh(field));
        // Only a field still this save's reports its copies' failures: one a later save or a
        // Clear superseded is that save's to report.
        warnings.push(...settled.flatMap(({ field }) => copyWarnings[field] ?? []));
        if (settled.length && current) {
          // The row's status from what its copies wait on now, this save's own failures, and a
          // failure a later write recorded (a late copy never hides a newer one).
          const writtenSince = writeCounts(current.revisions) !== writtenThen;
          const laterFailure =
            writtenSince && current.summary.status === "needs-attention"
              ? (current.summary.statusMessage ?? "")
              : undefined;
          const merged = {
            secrets: { ...current.summary.secrets },
            values: { ...current.values },
            pendingCopies: { ...current.pendingCopies },
          };
          for (const { field } of settled) {
            const own = current.summary.secrets[field];
            const made = secrets[field];
            if (!own || !made) continue;
            const { copies: _, ...kept } = own;
            merged.secrets[field] = {
              ...kept,
              source: made.source,
              ...(made.copies ? { copies: made.copies } : {}),
            };
            // Kept only in another store now: the row lets its own copy go, if still this save's.
            if (values[field] === undefined && current.values[field] === wrote[field])
              delete merged.values[field];
            merged.pendingCopies[field] = pendingCopies[field] ?? [];
          }
          const { statusMessage: _, ...rest } = current.summary;
          const message = laterFailure || warnings[0];
          const waiting = Object.values(merged.pendingCopies).some((targets) => targets.length);
          yield* commit(
            replaceAccount({
              ...current,
              summary: {
                ...rest,
                secrets: merged.secrets,
                status:
                  waiting || warnings.length || laterFailure !== undefined
                    ? "needs-attention"
                    : "ready",
                ...(message ? { statusMessage: message } : {}),
              },
              values: merged.values,
              pendingCopies: merged.pendingCopies,
            }),
          );
        }
        cache.delete(accountId);
        yield* denyRevoked;
        const account = findAccount(accountId)?.summary;
        return {
          accountId,
          ...(account ? { account } : {}),
          ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
        };
      });
      const external = updates.some(({ destinations }) =>
        destinations.some(({ type }) => type === "keychain" || type === "1password"),
      );
      if (later && external) {
        later.finish = copy.pipe(Effect.andThen(locked(settle)));
        const account = findAccount(accountId)?.summary;
        return { accountId, ...(account ? { account } : {}) };
      }
      yield* copy;
      return yield* settle;
    });

    // Values past their hour go when it ends, even on a server nobody uses meanwhile. Never opens
    // Accounts just for this: before it opens, its start does the same.
    yield* Effect.gen(function* () {
      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        const next = Math.min(now + UNDO_FOR_MS, ...removed.map(({ until }) => until));
        yield* Effect.sleep(Duration.millis(Math.max(next - now, 1_000)));
        // An Undo past its hour leaves every screen. The list is read under the permit: one
        // read before it could drop a removal made while the timer waited.
        if (initialized)
          yield* locked(
            Effect.suspend(() => keepRemoved(removed)).pipe(Effect.andThen(publish(false))),
          ).pipe(Effect.ignore);
      }
    }).pipe(Effect.forkIn(serviceScope));
    // Leaks: each saved password's SHA-1 prefix goes to the range check once a day, one prefix at
    // a time, paced; the answer is matched here. A prefix that fails or answers oddly keeps what
    // was known and is asked again next turn, without holding up the others.
    const pwnedRange = sources.pwnedRange;
    if (pwnedRange)
      yield* Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(LEAK_CHECK_GAP);
          const now = yield* Clock.currentTimeMillis;
          const byPrefix = new Map<string, string[]>();
          for (const { sha1 } of passwordFactsByRef.values()) {
            const known = leakAnswers.get(sha1);
            if (known && now - known.at < LEAK_RECHECK_MS) continue;
            const prefix = sha1.slice(0, 5);
            byPrefix.set(prefix, [...new Set([...(byPrefix.get(prefix) ?? []), sha1])]);
          }
          let changed = false;
          let first = true;
          for (const [prefix, digests] of byPrefix) {
            if (!first) yield* Effect.sleep(LEAK_PREFIX_GAP);
            first = false;
            const answer = yield* Effect.option(pwnedRange(prefix));
            const listed = Option.isSome(answer) ? pwnedSuffixes(answer.value) : undefined;
            if (!listed) continue;
            for (const sha1 of digests) {
              const leaked = listed.has(sha1.slice(5));
              changed ||= leakAnswers.get(sha1)?.leaked !== leaked;
              leakAnswers.set(sha1, { leaked, at: now });
            }
          }
          if (changed && initialized) yield* locked(publish(false)).pipe(Effect.ignore);
        }
      }).pipe(Effect.forkIn(serviceScope));
    /**
     * A new password reaches every copy of the login, each through its own stores; a copy linked
     * to another store keeps its link. A second factor stays with the row it was saved on.
     */
    const updateCopies = Effect.fn("AccountsService.updateCopies")(function* (
      accountId: AccountId,
      changes: AccountSaveInput["secrets"],
      /** Only these copies take it (a held password: those as they were at its fill). */
      eligible?: (copy: StoredAccount) => boolean,
    ) {
      const change = changes["password"];
      const warnings: string[] = [];
      if (change?.type !== "scient") return warnings;
      const rows = state.accounts.map((account) => account.summary);
      for (const copy of loginCopies(rows, accountId)) {
        const stored = findAccount(copy.accountId);
        if (eligible && (!stored || !eligible(stored))) {
          warnings.push(`Kept the password of ${copy.name}: it changed since.`);
          continue;
        }
        if (copy.secrets["password"]?.source.type !== "scient") {
          warnings.push(`Kept the linked password of ${copy.name}.`);
          continue;
        }
        const result = yield* save({
          accountId: copy.accountId,
          name: copy.name,
          details: copy.details,
          secrets: { password: { type: "scient", value: change.value } },
        }).pipe(Effect.result);
        if (result._tag === "Success") {
          warnings.push(...(result.success.warnings ?? []));
          continue;
        }
        // The copy says so on its row; saving the password again there retries it.
        warnings.push(`Could not update ${copy.name}.`);
        const stale = findAccount(copy.accountId);
        if (stale)
          yield* commit(
            replaceAccount({
              ...stale,
              summary: {
                ...stale.summary,
                status: "needs-attention",
                statusMessage: "Not updated with the new password.",
              },
            }),
          );
      }
      return warnings;
    });
    /** A login row and its password as it is now (none, for a row without one), before a save. */
    const passwordOf = (accountId: AccountId) => {
      const row = findAccount(accountId);
      if (!row) return [];
      // A linked password has no value of Scient's own: its link is what Undo gives back.
      const beforeSecret = row.summary.secrets["password"];
      const beforeRef = beforeSecret?.source.type === "scient" ? row.values["password"] : undefined;
      return [
        {
          accountId,
          // The login as it was before the save: a receipt never crosses an identity change.
          identity: identityOf(row.summary),
          beforeRevision: row.revisions?.["password"] ?? 0,
          ...(beforeSecret ? { beforeSecret } : {}),
          ...(beforeRef ? { beforeRef } : {}),
        },
      ];
    };
    /** Each copy of a login and its password as it is now, before a new one is saved. */
    const loginPasswords = (accountId: AccountId) => {
      const rows = state.accounts.map((account) => account.summary);
      return [accountId, ...loginCopies(rows, accountId).map((copy) => copy.accountId)].flatMap(
        (id) => passwordOf(id).filter((entry) => entry.beforeRef !== undefined),
      );
    };
    /**
     * After a new password is saved: what Undo gives each row back, its own earlier password
     * (kept as its previous one), or none for a row that had none. Shown on every client for the
     * hour; its id is returned.
     */
    const rememberPasswordUpdate = Effect.fn("AccountsService.rememberPasswordUpdate")(function* (
      accountId: AccountId,
      before: ReturnType<typeof passwordOf>,
    ) {
      const copies = before.flatMap((entry) => {
        const row = findAccount(entry.accountId);
        const afterRef = row?.values["password"];
        return afterRef &&
          afterRef !== entry.beforeRef &&
          identityOf(row.summary) === entry.identity &&
          (entry.beforeRef === undefined || row.previous?.password === entry.beforeRef)
          ? [{ ...entry, afterRef, afterRevision: row.revisions?.["password"] ?? 0 }]
          : [];
      });
      const at = yield* Clock.currentTimeMillis;
      yield* pruneUndos(at);
      if (copies.length === 0) return undefined;
      const undoId = NodeCrypto.randomUUID();
      passwordUndos.set(undoId, {
        accountId,
        name: findAccount(accountId)?.summary.name ?? "",
        until: at + UNDO_FOR_MS,
        copies,
      });
      yield* keepReceipts();
      return undoId;
    });
    /**
     * The password Undos, kept with the state so a restart neither loses nor strands them. The
     * values those it forgets held are journaled by that write (`commit`).
     */
    const keepReceipts = Effect.fn("AccountsService.keepReceipts")(function* () {
      yield* commit(
        {
          ...state,
          passwordUndos: [...passwordUndos].flatMap(([undoId, entry]) =>
            entry.field === undefined
              ? [
                  {
                    undoId,
                    accountId: entry.accountId,
                    name: entry.name,
                    until: entry.until,
                    copies: entry.copies,
                  },
                ]
              : [],
          ),
        },
        true,
      );
    });
    /** Forgets password Undos past their hour (the values only they held are journaled). */
    const pruneUndos = Effect.fn("AccountsService.pruneUndos")(function* (at: number) {
      let gone = false;
      for (const [id, entry] of passwordUndos) {
        if (entry.until > at) continue;
        passwordUndos.delete(id);
        gone ||= entry.field === undefined;
      }
      if (gone) yield* keepReceipts();
    });
    /**
     * `AccountsService.keepFound`'s locked body, for a caller already under the write lock (a
     * pending secret's save, read and dropped in the same permit). Saves to the Keychain or
     * 1Password wait in `laters` for the permit to be free.
     */
    const keepFoundNow = Effect.fn("AccountsService.keepFoundNow")(function* (
      found: ReadonlyArray<FoundValue>,
      laters: SaveLater[],
    ) {
      const rows: Array<{
        accountId: AccountId;
        afterRef: string;
        before?: Redacted.Redacted<string> | AccountSecretInput;
        beforeLines?: true;
        created?: true;
        createdUpdatedAt?: string;
      }> = [];
      const ids: AccountId[] = [];
      for (const item of found) {
        const existing = item.accountId ? findAccount(item.accountId) : undefined;
        if (item.accountId ? existing?.summary.details.kind !== "website" : !item.login) continue;
        if (item.updatedAt !== undefined && existing?.summary.updatedAt !== item.updatedAt)
          continue;
        if (item.onlyIfEmpty && existing?.summary.secrets[item.field] !== undefined) continue;
        // A pending secret's login must still be on its page's site and profile.
        if (
          item.site &&
          existing &&
          !factorLogins(item.site.origin, item.site.profileId).some(
            (row) => row.accountId === existing.summary.accountId,
          )
        )
          continue;
        // Backup codes found again (a recapture, an Undo's page, another login of the site)
        // never bring back one used on any login of that site and profile.
        let value = item.value;
        if (item.field === "recovery") {
          const owners = codeOwners(existing, item.site);
          const fresh = backupCodeList(Redacted.value(item.value), true).filter(
            (code) =>
              !owners.some((owner) =>
                (owner.usedCodes ?? []).includes(usedCodeDigest(owner.summary.accountId, code)),
              ),
          );
          if (fresh.length === 0) continue;
          value = Redacted.make(backupCodesValue(fresh));
        }
        const held = existing?.summary.secrets[item.field];
        const before =
          held === undefined
            ? undefined
            : held.source.type === "scient"
              ? yield* readValue(existing?.values[item.field])
              : held.source;
        const same = (saved: string) =>
          item.field === "recovery"
            ? backupCodeList(saved, held?.lines === true).join("\n") ===
              backupCodeList(Redacted.value(value), true).join("\n")
            : saved === Redacted.value(value);
        if (before !== undefined && Redacted.isRedacted(before) && same(Redacted.value(before))) {
          ids.push(existing!.summary.accountId);
          continue;
        }
        const secrets: AccountSaveInput["secrets"] = {
          [item.field]: {
            type: "scient",
            value: Redacted.value(value),
            ...(item.field === "recovery" ? { lines: true as const } : {}),
          },
        };
        const later: SaveLater = {};
        const saved = yield* save(
          existing
            ? {
                accountId: existing.summary.accountId,
                name: existing.summary.name,
                details: existing.summary.details,
                secrets,
              }
            : { name: item.login!.name, details: item.login!.details, secrets },
          undefined,
          undefined,
          later,
        );
        laters.push(later);
        ids.push(saved.accountId);
        const afterRef = findAccount(saved.accountId)?.values[item.field];
        if (afterRef)
          rows.push({
            accountId: saved.accountId,
            afterRef,
            ...(before === undefined ? {} : { before }),
            ...(held?.lines ? { beforeLines: true as const } : {}),
            ...(existing
              ? {}
              : {
                  created: true as const,
                  createdUpdatedAt: findAccount(saved.accountId)!.summary.updatedAt,
                }),
          });
      }
      const first = rows[0];
      if (first) {
        passwordUndos.set(NodeCrypto.randomUUID(), {
          accountId: first.accountId,
          name: findAccount(first.accountId)?.summary.name ?? "",
          until: (yield* Clock.currentTimeMillis) + UNDO_FOR_MS,
          field: found[0]!.field,
          rows,
        });
        yield* publish(false);
      }
      return ids;
    });
    /** `AccountsService.keepFound`, here so an authenticator import uses it too. */
    const keepFound = Effect.fn("AccountsService.keepFound")(function* (
      found: ReadonlyArray<FoundValue>,
    ) {
      const laters: SaveLater[] = [];
      const kept = yield* locked(keepFoundNow(found, laters));
      // Copies to the Keychain or 1Password, once the permit is free.
      for (const later of laters) if (later.finish) yield* Effect.ignore(later.finish);
      return kept;
    });
    /**
     * Whose used backup codes a list's codes are checked against: every login of the site and
     * profile the list came from (or the target login's own sites), the target included, since
     * one list is the site's, whichever login it was saved on.
     */
    const codeOwners = (
      existing: StoredAccount | undefined,
      site: FoundValue["site"],
    ): ReadonlyArray<StoredAccount> => {
      const details = existing?.summary.details;
      const places = site
        ? [site]
        : details?.kind === "website"
          ? details.sites.flatMap((entry) => {
              const origin = URL.parse(entry.includes("://") ? entry : `https://${entry}`)?.origin;
              return origin ? [{ origin, profileId: details.profileId }] : [];
            })
          : [];
      const ids = new Set(
        places.flatMap((place) =>
          factorLogins(place.origin, place.profileId).map((row) => row.accountId),
        ),
      );
      if (existing) ids.add(existing.summary.accountId);
      return [...ids].flatMap((id) => findAccount(id) ?? []);
    };
    /** A saved login with this exact address still stands here. */
    const savedExactly = (key: LoginKey, profileId: string | undefined) =>
      state.accounts.some(
        ({ summary }) =>
          summary.details.kind === "website" &&
          summary.details.loginUrl !== undefined &&
          (summary.details.profileId === undefined || summary.details.profileId === profileId) &&
          isLoginRow(summary) &&
          loginKeysOf(summary.details).some((own) => sameLoginKey(own, key)),
      );
    /**
     * The person removed this login here; a profile-less removal covers every profile. A removal
     * with no saved address covers any page, except a tenant still saved with its own address.
     */
    const removedHere = (
      removed: NonNullable<AccountsState["removedLogins"]>[number],
      details: Parameters<typeof loginKeysOf>[0],
      profileId: string | undefined,
    ) =>
      (removed.profileId === undefined || removed.profileId === profileId) &&
      loginKeysOf(details).some((key) => {
        // A marker written before a username rule changed compares by today's rule too.
        const marker = { ...removed, username: loginUserKey(removed.username) };
        return removed.tenant === undefined
          ? sameLoginKey(key, { ...marker, tenant: key.tenant }) && !savedExactly(key, profileId)
          : sameLoginKey(key, { ...marker, tenant: removed.tenant });
      });
    const migrateOnUse = migrateModelKeys.pipe(Effect.ignore);
    /** Removes a row for Undo, under the write permit; `seenAt` is the version the caller read. */
    const removeNow = Effect.fn("AccountsService.removeNow")(function* (
      accountId: AccountId,
      seenAt: string | undefined,
      operationId: string | undefined,
      threadId?: string,
    ) {
      const existing = findAccount(accountId);
      if (!existing) return yield* missing();
      if (seenAt !== undefined && seenAt !== existing.summary.updatedAt)
        return yield* fail("conflict", "It changed since you opened it. Try again.");
      // The values wait for Undo; what refers to the row by its id is left as it is.
      yield* takeBackLinks((link) => link.accountId !== accountId);
      const removalId = NodeCrypto.randomUUID();
      yield* keepRemoved([
        ...removed.filter(({ row }) => row.summary.accountId !== accountId),
        {
          row: existing,
          until: (yield* Clock.currentTimeMillis) + UNDO_FOR_MS,
          removalId,
          ...(operationId === undefined ? {} : { operationId }),
          ...(threadId === undefined ? {} : { threadId }),
          ...(historyOf(accountId).length ? { history: historyOf(accountId) } : {}),
        },
      ]);
      yield* commit({
        ...state,
        accounts: state.accounts.filter((account) => account !== existing),
        ...(removedLoginsOf(existing).length
          ? {
              removedLogins: withRemovedLogins(state.removedLogins, removedLoginsOf(existing)),
            }
          : {}),
        ...(state.keptKeys?.some((entry) => entry.accountId === accountId)
          ? {
              keptKeys: state.keptKeys.map((entry) =>
                entry.accountId === accountId ? { ...entry, removed: true } : entry,
              ),
            }
          : {}),
      });
      cache.delete(accountId);
      yield* denyRevoked;
      return { removalId };
    });
    /** Brings a removed row back from its receipt, under the caller's permit. */
    const restoreNow = Effect.fn("AccountsService.restoreNow")(function* (
      accountId: AccountId,
      removalId: string,
    ) {
      const entry = unexpired(removed, yield* Clock.currentTimeMillis).find(
        (entry) => entry.row.summary.accountId === accountId && entry.removalId === removalId,
      );
      if (!entry) {
        yield* keepRemoved(removed);
        return yield* fail("not-found", "It can no longer be brought back.");
      }
      if (!findAccount(accountId)) {
        // A new version: what read the row before its removal can't write to it now.
        const updatedAt = laterThan(entry.row.summary.updatedAt, yield* now);
        const row = { ...entry.row, summary: { ...entry.row.summary, updatedAt } };
        const restored = {
          ...state,
          accounts: [...state.accounts, row],
          // Its password history comes back with it.
          ...(entry.history?.length
            ? {
                passwordHistory: [
                  ...(state.passwordHistory ?? []),
                  { accountId, versions: entry.history },
                ],
              }
            : {}),
          removedLogins: withoutRemovedLogins(state.removedLogins, removedLoginsOf(entry.row)),
          // Undo brings a kept key back for its use too.
          ...(state.keptKeys?.some((kept) => kept.accountId === accountId)
            ? {
                keptKeys: state.keptKeys.map((kept) =>
                  kept.accountId === accountId
                    ? { accountId: kept.accountId, digest: kept.digest }
                    : kept,
                ),
              }
            : {}),
        };
        yield* commit(restored, false, state.accounts, restored);
      }
      yield* keepRemoved(removed.filter((other) => other !== entry));
    });
    // Round 6b: a profile's Remove, Clear and sign-out, each with the person's Undo.
    let profileStore: ProfileStore | undefined;
    /** How many times Accounts signed Main out of a site. */
    const mainSignOuts = () =>
      effectiveProfile(state.profiles, DEFAULT_BROWSER_PROFILE_ID).main?.signOuts ?? 0;
    const operationOf = (operationId: string) =>
      (state.profileOperations ?? []).find((operation) => operation.operationId === operationId);
    const withOperation = (operation: ProfileOperation) => ({
      ...state,
      profileOperations: [
        ...(state.profileOperations ?? []).filter(
          (other) => other.operationId !== operation.operationId,
        ),
        operation,
      ].slice(-200),
    });
    const withRecord = (record: BrowserProfileRecord) =>
      state.profiles.filter((profile) => profile.profileId !== record.profileId).concat([record]);
    const generations = () =>
      new Map(
        state.profiles.flatMap((record) =>
          record.generation ? [[record.profileId, record.generation] as const] : [],
        ),
      );
    /** The store's outcome, recorded on the receipt as it stands now. */
    const recordStore = Effect.fn("AccountsService.recordStore")(function* (
      operationId: string,
      update: (operation: ProfileOperation) => ProfileOperation,
      /** What changes with it, in the same commit. */
      alongside?: Partial<AccountsState>,
    ) {
      const operation = operationOf(operationId);
      if (!operation) return undefined;
      const updated = update(operation);
      // Its Undo hour starts once it has ended, not when it was asked for (round 6d).
      if (operation.undone || !stillPending(operation) || stillPending(updated)) {
        yield* commit({ ...withOperation(updated), ...alongside }, true);
        return updated;
      }
      const until = DateTime.formatIso(
        DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + UNDO_FOR_MS),
      );
      const next = { ...updated, until };
      // A Clear's old data waits for that same hour.
      const record = effectiveProfile(state.profiles, operation.profileId);
      const retained =
        operation.kind === "clear"
          ? (record.retained ?? []).map((entry) =>
              entry.generation === operation.from && !entry.purgedAt ? { ...entry, until } : entry,
            )
          : undefined;
      yield* commit(
        {
          ...withOperation(next),
          ...alongside,
          ...(retained ? { profiles: withRecord({ ...record, retained }) } : {}),
        },
        true,
      );
      return next;
    });
    /** Each desktop's report with the profile linked to `link`'s browser profile, and no other. */
    const relink = (profileId: BrowserProfileId, link: BrowserProfileSource | undefined) =>
      (state.sourceProfiles ?? []).map((entry) => ({
        ...entry,
        sources: entry.sources.map((candidate) => {
          const { linkedTo: _, ...unlinked } = candidate;
          const linked =
            link !== undefined &&
            linksBrowserProfile(link, { ...candidate, computerId: entry.computer.id });
          return linked
            ? { ...unlinked, linkedTo: profileId }
            : candidate.linkedTo === profileId
              ? unlinked
              : candidate;
        }),
      }));
    const savedCookiesOf = (operationId: string) =>
      (state.signOutSaves ?? []).find((entry) => entry.operationId === operationId);
    /** Cookies kept for an operation's Undo, encrypted like every value. */
    const keepSaved = Effect.fn("AccountsService.keepSaved")(function* (
      key: string,
      cookies: ReadonlyArray<SessionCookie>,
    ) {
      const ref = yield* stageValue(
        Redacted.make(
          new TextEncoder().encode(yield* encodeSavedCookies(cookies).pipe(Effect.orDie)),
        ),
      );
      return { operationId: key, ref };
    });
    const readSaved = Effect.fn("AccountsService.readSaved")(function* (key: string) {
      const saved = savedCookiesOf(key);
      if (!saved) return [];
      const stored = yield* persistence.read(saved.ref);
      if (Option.isNone(stored)) return [];
      return yield* decodeSavedCookies(new TextDecoder().decode(Redacted.value(stored.value))).pipe(
        Effect.orElseSucceed(() => []),
      );
    });
    /**
     * Seals cookies for an operation's Undo, added to what is sealed there already: the earliest
     * seal of each cookie stays. A run resumed after a restart adds only what it hadn't sealed,
     * never replacing the backup of a site it signed out before (round 6d).
     */
    const sealMerged = Effect.fn("AccountsService.sealMerged")(function* (
      key: string,
      cookies: ReadonlyArray<SessionCookie>,
    ) {
      // Read, kept and recorded under one permit, from the state as it is then (round 6j): a
      // write that lands while the seal waits for the permit is never rolled back by it. The
      // seal it replaces is journaled by that write.
      yield* locked(
        Effect.gen(function* () {
          const existing = yield* readSaved(key);
          const held = new Set(existing.map(sealKey));
          const merged = [...existing, ...cookies.filter((cookie) => !held.has(sealKey(cookie)))];
          if (merged.length === existing.length && savedCookiesOf(key)) return;
          const sealed = yield* keepSaved(key, merged);
          yield* commit(
            {
              ...state,
              signOutSaves: [
                ...(state.signOutSaves ?? []).filter((entry) => entry.operationId !== key),
                sealed,
              ],
            },
            true,
          );
        }),
      );
    });
    /** The logins of `from` for these sites, as new rows in `into`: each value copied. */
    const copyLogins = Effect.fn("AccountsService.copyLogins")(function* (
      from: BrowserProfileId,
      into: BrowserProfileId,
      sites: ReadonlyArray<string> | undefined,
    ) {
      const added: AccountId[] = [];
      for (const row of state.accounts) {
        const { details } = row.summary;
        if (
          details.kind !== "website" ||
          details.institution ||
          (details.profileId ?? DEFAULT_BROWSER_PROFILE_ID) !== from ||
          !takenAlong(sites, details.sites)
        )
          continue;
        const target = { ...details, profileId: into };
        if (state.accounts.some((other) => isLogin(other.summary, target) && other !== row))
          continue;
        const secrets: Record<string, { type: "scient"; value: string }> = {};
        for (const [field, secret] of Object.entries(row.summary.secrets))
          if (secret.source.type === "scient" && row.values[field])
            secrets[field] = {
              type: "scient",
              value: Redacted.value(yield* readValue(row.values[field])),
            };
        // Saved with the row's own controls in one commit: never wider, not even for a moment.
        const { accountId } = yield* save({
          name: row.summary.name,
          details: target,
          secrets,
          controls: row.summary.controls,
        });
        added.push(accountId);
      }
      return added;
    });
    /**
     * Why an operation's part can't be carried out now, as Accounts stands: a profile removed or
     * changed since it was decided, a destination reaching further, or an agent's grant gone.
     */
    const blockedNow = (operation: ProfileOperation): string | undefined => {
      const from = effectiveProfile(state.profiles, operation.profileId);
      const into = operation.into ? effectiveProfile(state.profiles, operation.into) : undefined;
      const profiles = [from, ...(into ? [into] : [])];
      if (operation.undone) return "It was undone.";
      if (profiles.some((profile) => profile.removed || profile.retired))
        return "The profile was removed.";
      if (
        (operation.fromVersion !== undefined && profileVersion(from) !== operation.fromVersion) ||
        (into &&
          operation.intoVersion !== undefined &&
          profileVersion(into) !== operation.intoVersion)
      )
        return "The profile changed since; nothing was done.";
      if (into && widensInto(from, into)) return "Its sign-ins would reach further there.";
      // Main signed out of a site since a refresh of it was decided: what it copies may be that
      // site's sign-in (round 6j).
      if (
        operation.kind === "refresh" &&
        operation.profileId === DEFAULT_BROWSER_PROFILE_ID &&
        mainSignOuts() !== (operation.mainSignOuts ?? 0)
      )
        return "Main was signed out of a site since; nothing was done.";
      // A refresh's link, checked where it commits (round 6h): still this profile's alone.
      if (operation.kind === "refresh") {
        const link = operation.link ?? from.source;
        if (!link) return "It isn't linked to a browser profile now.";
        if (
          state.profiles.some(
            (profile) =>
              profile.profileId !== operation.profileId &&
              !profile.removed &&
              !profile.retired &&
              profile.source !== undefined &&
              sameBrowserProfile(profile.source, link),
          )
        )
          return "Its browser profile is linked to another profile now.";
      }
      if (
        operation.threadId !== undefined &&
        (!state.agentAccess ||
          profiles.some(
            (profile) => profile.access === "off" || !inScope(profile.scope, operation.projectId),
          ))
      )
        return "Agent access to it changed; nothing was done.";
      return undefined;
    };
    /** This server's own desktop: the only one whose browsers are imported here (round 6f). */
    const ownDesktop = (computerId: string) =>
      profileStore?.desktop === true && profileStore.computer?.id === computerId;
    const foreignList = (entry: {
      readonly computer: { readonly id: string };
      readonly sources: ReadonlyArray<unknown>;
    }) => entry.sources.length > 0 && !ownDesktop(entry.computer.id);
    /**
     * Lists another desktop reported before round 6f narrowed imports: dropped once a store says
     * whose desktop this is (round 6h), whether it attaches before Accounts' first read or after.
     */
    const dropForeignLists = Effect.suspend(() =>
      (state.sourceProfiles ?? []).some(foreignList)
        ? commit(
            {
              ...state,
              sourceProfiles: (state.sourceProfiles ?? []).map((entry) =>
                foreignList(entry) ? { ...entry, sources: [] } : entry,
              ),
            },
            true,
          ).pipe(Effect.ignore)
        : Effect.void,
    );
    /** The desktops on now, other than this computer's own, by their profile reports. */
    const otherDesktops = (atMs: number) =>
      (state.sourceProfiles ?? []).flatMap(({ computer, seenAt }) =>
        atMs - Date.parse(seenAt) < SOURCES_FRESH_MS && computer.id !== profileStore?.computer?.id
          ? [computer]
          : [],
      );
    /** Each operation's way to read the tabs open in its profile, from the caller that decided it. */
    const openTabLookups = new Map<string, Effect.Effect<ReadonlyArray<ProfileThreadId>>>();
    /**
     * The one check every write makes under the permit, where it commits (round 6d): what the
     * operation was decided on still stands. "do": nothing removed, changed or widened, no
     * agent's grant gone; "retire" also no tab open or opening in the source; "undo": its data is
     * still the generation it was done in. Why not, or undefined.
     */
    const standsNow = Effect.fn("AccountsService.standsNow")(function* (
      operationId: string,
      at: "do" | "undo" | "retire",
    ) {
      const operation = operationOf(operationId);
      if (!operation) return "No such operation.";
      if (at === "undo") {
        const record = effectiveProfile(state.profiles, operation.profileId);
        const into = operation.into ? effectiveProfile(state.profiles, operation.into) : undefined;
        return (operation.generation !== undefined &&
          (record.generation ?? 0) !== operation.generation) ||
          (into &&
            operation.intoGeneration !== undefined &&
            (into.generation ?? 0) !== operation.intoGeneration)
          ? "It was cleared since; it can no longer be undone."
          : undefined;
      }
      const blocked = blockedNow(operation);
      if (blocked) return blocked;
      // Cleared after it was decided: its data is no longer the profile's. A copy's destination
      // too: what it writes would land in data a Clear just set aside (round 6s).
      const record = effectiveProfile(state.profiles, operation.profileId);
      const into = operation.into ? effectiveProfile(state.profiles, operation.into) : undefined;
      if (
        (operation.generation !== undefined && (record.generation ?? 0) !== operation.generation) ||
        (into &&
          operation.intoGeneration !== undefined &&
          (into.generation ?? 0) !== operation.intoGeneration)
      )
        return "It was cleared since; nothing was done.";
      if (at === "do") return undefined;
      // The deciding caller's lookup, or this server's own tabs: a restart lost the first.
      const lookup =
        openTabLookups.get(operationId) ?? profileStore?.openTabs?.(operation.profileId);
      const open = [
        ...(lookup ? yield* lookup : []),
        ...(admitting.get(operation.profileId)?.values() ?? []),
      ];
      return open.length ? "Its tabs are open: it was kept." : undefined;
    });
    /**
     * The same check, and the store's writes after its final read, under one permit (round 6f):
     * nothing the check reads can change before they land. Refused, nothing is written, and
     * `stopped` hears why.
     */
    const commitFor =
      (
        operationId: string,
        at: "do" | "undo",
        stopped: (reason: string) => void = () => undefined,
      ) =>
      <A>(write: Effect.Effect<A, AccountsError>): Effect.Effect<A, AccountsError> =>
        locked(
          Effect.gen(function* () {
            const blocked = yield* standsNow(operationId, at);
            if (blocked) {
              stopped(blocked);
              return yield* fail("conflict", blocked);
            }
            // Held until the writes have ended, never released while a cookie command runs
            // (round 6h): each command is bounded by the jar itself, and a stalled one fails.
            return yield* write;
          }),
        );
    /** A merge or fold retires its source once every store is done and every site came over. */
    const settleTransfer = Effect.fn("AccountsService.settleTransfer")(function* (
      operationId: string,
    ) {
      const operation = operationOf(operationId);
      if (!operation || (operation.kind !== "merge" && operation.kind !== "fold")) return operation;
      if (operation.retiredSource || operation.undone) return operation;
      const stores = [operation.server, operation.desktop].filter((store) => store !== undefined);
      if (stores.some((store) => store.state === "pending")) return operation;
      const uncovered = [
        ...(operation.uncovered ?? []),
        ...stores.flatMap((store) => store.uncovered ?? []),
      ];
      // Copied, source kept: the person sees what didn't come over.
      if (stores.some((store) => store.state === "failed") || uncovered.length)
        return yield* recordStore(operationId, (current) => ({
          ...current,
          uncovered: [...new Set(uncovered)],
        }));
      // Retired only if it still stands, with no tab open or opening in it.
      const kept = yield* standsNow(operationId, "retire");
      if (kept)
        return yield* recordStore(operationId, (current) => ({ ...current, stopped: kept }));
      const record = effectiveProfile(state.profiles, operation.profileId);
      yield* commit({
        ...state,
        profiles: withRecord({
          ...record,
          removed: {
            at: operation.at,
            operationId,
            until: operation.until,
            ...(record.name ? { name: record.name } : {}),
          },
        }),
      });
      return yield* recordStore(operationId, (current) => ({ ...current, retiredSource: true }));
    });
    /** Copy, move, merge and fold, once the permit is free: this server's browser, then logins. */
    const transferNow = Effect.fn("AccountsService.transferNow")(function* (
      store: ProfileStore | undefined,
      operation: ProfileOperation,
    ) {
      const from = operation.profileId;
      const into = operation.into!;
      let server: ProfileOperation["server"];
      let chosen = operation.sites;
      // Checked again as Accounts stands now: a destination widened meanwhile stops it here.
      const blocked = yield* locked(
        Effect.sync(() => blockedNow(operationOf(operation.operationId) ?? operation)),
      );
      if (blocked)
        return (
          (yield* locked(
            recordStore(operation.operationId, (current) => ({
              ...current,
              ...(current.server ? { server: { state: "failed" as const } } : {}),
              stopped: blocked,
            })),
          )) ?? operation
        );
      if (store) {
        // What the copy replaces and brings, sealed for Undo before the store changes anything.
        // Merged with any earlier seal: a resumed copy keeps the first "before" it sealed.
        const keep = Effect.fn("AccountsService.keepCopy")(function* (saved: {
          readonly before: ReadonlyArray<SessionCookie>;
          readonly copied: ReadonlyArray<SessionCookie>;
        }) {
          // The copied seal is the copy's intent: what it meant to write, each where the
          // destination had none or its own (round 6e). On a retry, a cookie there under such a key
          // is the copy's own write only when it is exactly what was meant; anything else is
          // someone's since, so the copy stops and changes nothing (round 6f).
          const prior = new Map(
            (yield* readSaved(`${operation.operationId}#into`)).map(
              (cookie) => [sealKey(cookie), cookie] as const,
            ),
          );
          const before = new Set(prior.keys());
          const meant = new Map(
            (yield* readSaved(`${operation.operationId}#copied`)).map(
              (cookie) => [sealKey(cookie), cookie] as const,
            ),
          );
          // Now, under each key it meant to write: what was there before it (nothing, too), or its
          // own write; once its write was confirmed, only that. Anything else, every attribute
          // compared, was done since and is never overwritten (rounds 6h, 6i).
          const written = new Set(
            (yield* readSaved(`${operation.operationId}#written`)).map(sealKey),
          );
          const now = new Map(saved.before.map((cookie) => [sealKey(cookie), cookie] as const));
          const same = (a: SessionCookie | undefined, b: SessionCookie | undefined) =>
            a === undefined ? b === undefined : b !== undefined && sameCookie(a, b);
          const changed = saved.copied.some((cookie) => {
            const key = sealKey(cookie);
            const intent = meant.get(key);
            if (intent === undefined) return false;
            const current = now.get(key);
            return !same(intent, current) && (written.has(key) || !same(prior.get(key), current));
          });
          if (changed)
            return yield* fail(
              "conflict",
              "The destination changed since the copy began; nothing was changed.",
            );
          const brought = new Set([...meant.keys()].filter((key) => !before.has(key)));
          yield* sealMerged(
            `${operation.operationId}#into`,
            saved.before.filter((cookie) => !brought.has(sealKey(cookie))),
          );
          yield* sealMerged(`${operation.operationId}#copied`, saved.copied);
        });
        let stoppedAt: string | undefined;
        const copied = yield* store
          .copy(from, into, operation.sites, keep, {
            ...(operation.generation === undefined ? {} : { generation: operation.generation }),
            ...(operation.intoGeneration === undefined
              ? {}
              : { intoGeneration: operation.intoGeneration }),
            commit: commitFor(operation.operationId, "do", (reason) => (stoppedAt = reason)),
            // Each cookie it set, confirmed: a retry then expects exactly that there (6i, 6j).
            wrote: (cookies) => sealMerged(`${operation.operationId}#written`, cookies),
          })
          .pipe(Effect.result);
        if (stoppedAt) {
          const kept = stoppedAt;
          return (
            (yield* locked(
              recordStore(operation.operationId, (current) => ({
                ...current,
                server: { state: "failed" as const },
                stopped: kept,
              })),
            )) ?? operation
          );
        }
        if (copied._tag === "Success") {
          chosen = [...copied.success.sites];
          // A move signs the source out of what it copied, kept for Undo too.
          // A site that didn't come over stays signed in where it was.
          const notCopied = (site: string) =>
            copied.success.uncovered.some(
              (left) => left === site || left.endsWith(`.${site}`) || site.endsWith(`.${left}`),
            );
          // Each site's are sealed for Undo before they are removed from the source.
          // Cookies no API can reach stay in the source, and are counted (round 6i, verdict 5).
          let leftBehind = 0;
          if (operation.kind === "move")
            for (const site of chosen.filter((site) => !notCopied(site))) {
              // Each site's seal is added to the earlier ones', after a restart too.
              const signedOut = yield* store
                .signOut(
                  from,
                  site,
                  (cookies) =>
                    cookies.length
                      ? sealMerged(`${operation.operationId}#from`, cookies)
                      : Effect.void,
                  {
                    ...(operation.generation === undefined
                      ? {}
                      : { generation: operation.generation }),
                    commit: commitFor(operation.operationId, "do"),
                  },
                )
                .pipe(Effect.option);
              if (Option.isSome(signedOut)) leftBehind += signedOut.value.leftBehind ?? 0;
            }
          server = {
            state: "done",
            copied: copied.success.copied,
            ...(copied.success.uncovered.length
              ? { uncovered: [...copied.success.uncovered] }
              : {}),
            ...(leftBehind ? { leftBehind } : {}),
          };
        } else server = { state: "failed" };
      }
      return yield* locked(
        Effect.gen(function* () {
          // Revoked or widened while the cookies copied: no login is written.
          const stopped = yield* standsNow(operation.operationId, "do");
          // The logins chosen, not the sites this server's browser happened to hold.
          const rowsAdded = stopped ? [] : yield* copyLogins(from, into, operation.sites);
          // Its marker only for a move that still stands: one stopped keeps the source signed in.
          if (operation.kind === "move" && chosen && !stopped)
            yield* commit(
              {
                ...state,
                signedOut: chosen.reduce(
                  (signedOut, site) => withSignOut(signedOut, from, site),
                  state.signedOut,
                ),
              },
              true,
            );
          yield* recordStore(operation.operationId, (current) => ({
            ...current,
            ...(server ? { server } : {}),
            ...(stopped ? { stopped } : {}),
            ...(rowsAdded.length
              ? {
                  rowsAdded,
                  rowsAddedAt: rowsAdded.map(
                    (accountId) => findAccount(accountId)?.summary.updatedAt ?? "",
                  ),
                }
              : {}),
          }));
          return (yield* settleTransfer(operation.operationId)) ?? operation;
        }),
      );
    });
    /** Its server part of each operation still in its hour that a restart cut short, resumed. */
    const resumeUnfinished = Effect.gen(function* () {
      const atMs = yield* Clock.currentTimeMillis;
      const unfinished = (state.profileOperations ?? []).filter(
        (operation) =>
          live(operation, atMs) &&
          (operation.undone
            ? operation.undone.server?.state === "pending"
            : operation.server?.state === "pending"),
      );
      if (unfinished.length)
        yield* Effect.forEach(
          unfinished,
          (operation) =>
            (operation.undone ? serverUndo(operation) : serverDo(operation)).pipe(Effect.ignore),
          { discard: true },
        ).pipe(Effect.forkIn(serviceScope));
    });
    /** Each operation's server part running in this process, so a retry doesn't run it twice. */
    const inFlight = new Set<string>();
    const once = <A>(
      key: string,
      operation: ProfileOperation,
      run: Effect.Effect<A | ProfileOperation, AccountsError>,
    ): Effect.Effect<A | ProfileOperation, AccountsError> =>
      Effect.suspend(() => {
        if (inFlight.has(key)) return Effect.succeed(operation);
        inFlight.add(key);
        return run.pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(key))));
      });
    /** An operation's part in this server's browser, once the permit is free; resumed by a retry. */
    const serverDo = (
      operation: ProfileOperation,
    ): Effect.Effect<ProfileOperation, AccountsError> =>
      once(
        `do:${operation.operationId}`,
        operation,
        Effect.gen(function* () {
          // Copy, move, merge and fold: both stores and the logins.
          if (operation.into) return yield* transferNow(profileStore, operation);
          const store = profileStore;
          if (!store || operation.server?.state !== "pending") return operation;
          if (operation.kind === "clear") {
            const closed = yield* (
              store
                .generations(generations())
                // The new generation first: the tabs it reopens open there.
                .pipe(Effect.andThen(store.closeProfile(operation.profileId)), Effect.result)
            );
            const done = yield* locked(
              recordStore(operation.operationId, (current) => ({
                ...current,
                server: { state: closed._tag === "Success" ? "done" : "failed" },
              })),
            );
            return done ?? operation;
          }
          // What it removes is sealed for Undo, then checked, before the store removes it.
          let stopped: string | undefined;
          const signedOut = yield* store
            .signOut(
              operation.profileId,
              operation.site!,
              (cookies) =>
                cookies.length ? sealMerged(operation.operationId, cookies) : Effect.void,
              {
                ...(operation.generation === undefined ? {} : { generation: operation.generation }),
                commit: commitFor(operation.operationId, "do", (reason) => (stopped = reason)),
              },
            )
            .pipe(Effect.result);
          const done = yield* locked(
            recordStore(operation.operationId, (current) => ({
              ...current,
              server:
                signedOut._tag === "Success"
                  ? {
                      state: "done",
                      saved: signedOut.success.cookies.length,
                      ...(signedOut.success.leftBehind
                        ? { leftBehind: signedOut.success.leftBehind }
                        : {}),
                    }
                  : { state: "failed" },
              ...(stopped ? { stopped } : {}),
            })),
          );
          return done ?? operation;
        }),
      );
    /** An Undo's part in this server's browser; resumed by a retry. */
    const serverUndo = (
      operation: ProfileOperation,
    ): Effect.Effect<ProfileOperation, AccountsError> =>
      once(
        `undo:${operation.operationId}`,
        operation,
        Effect.gen(function* () {
          const operationId = operation.operationId;
          if (operation.undone?.server?.state !== "pending" || !profileStore) return operation;
          // Cleared since it was asked for: nothing goes back into data it wasn't done in.
          const stale = yield* locked(standsNow(operationId, "undo"));
          if (stale)
            return (
              (yield* locked(
                recordStore(operationId, (current) => ({
                  ...current,
                  undone: { ...current.undone!, server: { state: "failed" } },
                })),
              )) ?? operation
            );
          const store = profileStore;
          if (operation.into) {
            const into = operation.into;
            const before = yield* readSaved(`${operationId}#into`);
            const copied = yield* readSaved(`${operationId}#copied`);
            const removed = yield* readSaved(`${operationId}#from`);
            // Into the data it was done in, checked holding each jar, after the seals are read.
            const back = yield* store
              .restoreInto(into, copied, before, {
                ...(operation.intoGeneration === undefined
                  ? {}
                  : { intoGeneration: operation.intoGeneration }),
                commit: commitFor(operationId, "undo"),
              })
              .pipe(
                Effect.andThen((restoredInto) =>
                  removed.length
                    ? store
                        .restore(operation.profileId, removed, {
                          ...(operation.generation === undefined
                            ? {}
                            : { generation: operation.generation }),
                          commit: commitFor(operationId, "undo"),
                        })
                        .pipe(
                          Effect.map((source) => ({
                            restored: restoredInto.restored + source.restored,
                            refused: restoredInto.refused + source.refused,
                            ...(restoredInto.newer || source.newer
                              ? { newer: (restoredInto.newer ?? 0) + (source.newer ?? 0) }
                              : {}),
                          })),
                        )
                    : Effect.succeed(restoredInto),
                ),
                Effect.result,
              );
            return (
              (yield* locked(
                Effect.gen(function* () {
                  yield* commit(
                    {
                      ...state,
                      signOutSaves: (state.signOutSaves ?? []).filter(
                        (entry) => !entry.operationId.startsWith(`${operationId}#`),
                      ),
                    },
                    true,
                  );
                  return yield* recordStore(operationId, (current) => ({
                    ...current,
                    undone: {
                      ...current.undone!,
                      server:
                        back._tag === "Success"
                          ? { state: "done", ...back.success }
                          : { state: "failed" },
                    },
                  }));
                }),
              )) ?? operation
            );
          }
          if (operation.kind === "clear") {
            const switched = yield* (
              store
                .generations(generations())
                // The new generation first: the tabs it reopens open there.
                .pipe(Effect.andThen(store.closeProfile(operation.profileId)), Effect.result)
            );
            return (
              (yield* locked(
                recordStore(operationId, (current) => ({
                  ...current,
                  undone: {
                    ...current.undone!,
                    server: { state: switched._tag === "Success" ? "done" : "failed" },
                  },
                })),
              )) ?? operation
            );
          }
          // Sign-out: the cookies it removed, back where the site still takes them.
          const saved = savedCookiesOf(operationId);
          const restored = yield* Effect.gen(function* () {
            const stored = yield* persistence.read(saved!.ref);
            if (Option.isNone(stored))
              return yield* fail("unavailable", "The saved sign-ins are gone.");
            const cookies = yield* decodeSavedCookies(
              new TextDecoder().decode(Redacted.value(stored.value)),
            ).pipe(
              Effect.mapError(
                () =>
                  new AccountsError({
                    reason: "unavailable",
                    message: "The saved sign-ins couldn't be read.",
                  }),
              ),
            );
            return yield* store.restore(operation.profileId, cookies, {
              ...(operation.generation === undefined ? {} : { generation: operation.generation }),
              commit: commitFor(operationId, "undo"),
            });
          }).pipe(Effect.result);
          return (
            (yield* locked(
              Effect.gen(function* () {
                yield* commit(
                  {
                    ...state,
                    signOutSaves: (state.signOutSaves ?? []).filter(
                      (entry) => entry.operationId !== operationId,
                    ),
                  },
                  true,
                );
                return yield* recordStore(operationId, (current) => ({
                  ...current,
                  undone: {
                    ...current.undone!,
                    server:
                      restored._tag === "Success"
                        ? { state: "done", ...restored.success }
                        : { state: "failed" },
                  },
                }));
              }),
            )) ?? operation
          );
        }),
      );
    /** The row an agent may still write, as it stands now: its version, scope and Off. */
    const agentRow = Effect.fn("AccountsService.agentRow")(function* (
      accountId: AccountId,
      version: string,
      by: AccountChangeBy,
    ) {
      if (!state.agentAccess)
        return yield* fail("denied", "Agent access to Accounts is off. The user can turn it on.");
      const row = findAccount(accountId);
      if (!row || privateUse(row.summary) || !inScope(row.summary.controls.scope, by.projectId))
        return yield* missing();
      if (row.summary.controls.access === "off")
        return yield* fail("denied", "This account is off for agents; the user manages it.");
      if (row.summary.updatedAt !== version)
        return yield* fail("conflict", "It changed since it was read. Read it again.");
      return row;
    });
    /** The profile an agent may still write, as it stands now. */
    const agentProfile = Effect.fn("AccountsService.agentProfile")(function* (
      profileId: BrowserProfileId,
      version: string,
      by: AccountChangeBy,
    ) {
      if (!state.agentAccess)
        return yield* fail("denied", "Agent access to Accounts is off. The user can turn it on.");
      const record = effectiveProfile(state.profiles, profileId);
      if (record.retired || !inScope(record.scope, by.projectId)) return yield* missing();
      if (record.received?.length)
        return yield* fail("denied", "This profile is set on another computer; change it there.");
      if (record.access === "off")
        return yield* fail("denied", "This profile is off for agents; the user manages it.");
      if (profileVersion(record) !== version)
        return yield* fail("conflict", "It changed since it was read. Read it again.");
      return record;
    });
    /**
     * A save, with what it brings: a removed login back for good, the other copies of a login
     * updated, and one Undo for every row a new password reached (copies the save made included),
     * each with what it had. Runs under the write lock.
     */
    const saveWithReceipt = Effect.fn("AccountsService.saveWithReceipt")(function* (
      input: AccountSaveInput,
      linkedValues: Record<string, Redacted.Redacted<string>>,
      later: SaveLater,
      eligible?: (copy: StoredAccount) => boolean,
    ) {
      // A new password for a saved login: what it had, so one Undo gives it back (a first
      // password included, taken out again).
      const passwordChange =
        input.accountId !== undefined &&
        input.details.kind === "website" &&
        input.secrets["password"] !== undefined;
      const self = passwordChange ? passwordOf(input.accountId!) : [];
      const saved = yield* save(input, undefined, linkedValues, later);
      // Saving a login the person removed brings it back for good.
      const restored = input.accountId
        ? []
        : (state.removedLogins ?? []).filter(
            (entry) =>
              input.details.kind === "website" &&
              removedHere(entry, input.details, input.details.profileId),
          );
      if (restored.length)
        yield* commit({
          ...state,
          removedLogins: (state.removedLogins ?? []).filter((entry) => !restored.includes(entry)),
        });
      // Its copies as they are now, after the save, which may have made new ones: the same
      // Undo gives each its own earlier password back.
      const others = passwordChange
        ? loginCopies(
            state.accounts.map((account) => account.summary),
            saved.accountId,
          ).flatMap((copy) => passwordOf(copy.accountId))
        : [];
      // Only an update reaches the other copies; a new row is a login of its own.
      const copies =
        input.accountId && input.details.kind === "website"
          ? yield* updateCopies(saved.accountId, input.secrets, eligible)
          : [];
      const undoId = passwordChange
        ? yield* rememberPasswordUpdate(saved.accountId, [...self, ...others])
        : undefined;
      return { saved, copies, undoId };
    });
    type PendingRecord = NonNullable<AccountsState["pending"]>[number];
    const pendingOf = (pendingId: string) =>
      (state.pending ?? []).find((entry) => entry.pendingId === pendingId);
    /**
     * Holds a value privately, on no login: the same kind, place and value held again is the same
     * record. A new password records its login's password as it is now, and is marked as being
     * settled before anyone is told of it. Full, the oldest factor gives way (they expire anyway);
     * a password never does. Runs under the write lock.
     */
    const holdPendingNow = Effect.fn("AccountsService.holdPendingNow")(function* (input: {
      readonly kind: PendingRecord["kind"];
      readonly value: Redacted.Redacted<string>;
      readonly origin: string;
      readonly profileId?: BrowserProfileId | undefined;
      readonly label?: string | undefined;
      readonly accountId?: AccountId | undefined;
      readonly login?: PendingRecord["login"];
      readonly settling?: boolean;
      /** How long a new password stays the client's to settle before the person sees it. */
      readonly settleFor?: number;
    }) {
      const digest = NodeCrypto.createHash("sha256")
        .update(Redacted.value(input.value))
        .digest("hex");
      const same = (state.pending ?? []).find(
        (entry) =>
          entry.kind === input.kind &&
          entry.origin === input.origin &&
          entry.profileId === input.profileId &&
          entry.accountId === input.accountId &&
          entry.login?.name === input.login?.name &&
          entry.digest === digest,
      );
      if (same) {
        if (input.settling) settling.add(same.pendingId);
        return same.pendingId;
      }
      let kept = state.pending ?? [];
      // Full, the oldest factor gives way: its value is journaled by the write that drops it.
      if (kept.length >= PENDING_KEPT) {
        const oldest = kept.find((entry) => entry.kind !== "password");
        if (!oldest)
          return yield* fail("unavailable", "Too many new passwords wait. Answer some first.");
        kept = kept.filter((entry) => entry !== oldest);
      }
      const valueRef = yield* stageValue(
        Redacted.make(new TextEncoder().encode(Redacted.value(input.value))),
      );
      const pendingId = NodeCrypto.randomUUID();
      if (input.settling) settling.add(pendingId);
      // A new password's login as it is now: its password, its identity, and its copies with
      // theirs; before its form names the login, every login of the site so.
      const row = input.accountId ? findAccount(input.accountId) : undefined;
      const baseRef = row?.values["password"];
      const baseRevision = ownCount(row?.revisions, "password");
      const targets =
        input.kind === "password" && !input.accountId
          ? factorLogins(input.origin, input.profileId)
              .slice(0, 20)
              .map((login) => {
                const target = findAccount(login.accountId);
                const ref = target?.values["password"];
                return {
                  accountId: login.accountId,
                  ...(ref ? { baseRef: ref } : {}),
                  baseRevision: ownCount(target?.revisions, "password"),
                  identity: identityOf(login),
                  copyRefs: copyRefsOf(login.accountId),
                };
              })
          : [];
      const at = yield* Clock.currentTimeMillis;
      yield* commit({
        ...state,
        pending: [
          ...kept,
          {
            pendingId,
            kind: input.kind,
            valueRef,
            digest,
            origin: input.origin,
            ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
            ...(input.label ? { label: input.label.slice(0, 200) } : {}),
            ...(input.accountId ? { accountId: input.accountId } : {}),
            ...(input.login ? { login: input.login } : {}),
            ...(baseRef ? { baseRef } : {}),
            ...(row ? { baseRevision } : {}),
            ...(row && input.kind === "password"
              ? {
                  pinnedIdentity: identityOf(row.summary),
                  copyRefs: copyRefsOf(row.summary.accountId),
                }
              : {}),
            ...(targets.length ? { targets } : {}),
            ...(input.kind === "password"
              ? {
                  settleBy: DateTime.formatIso(
                    DateTime.makeUnsafe(at + (input.settleFor ?? SETTLE_FOR_MS)),
                  ),
                }
              : {}),
            since: DateTime.formatIso(DateTime.makeUnsafe(at)),
          },
        ],
      });
      return pendingId;
    });
    /**
     * A reserved new password its form sent: the login and username the form named (a login the
     * reservation didn't know takes its password as it is now), and the site's answer due within
     * SETTLE_FOR_MS. Runs under the write lock.
     */
    const sentPendingNow = Effect.fn("AccountsService.sentPendingNow")(function* (
      pendingId: string,
      sent: {
        readonly password: string;
        readonly label?: string | undefined;
        readonly accountId?: AccountId | undefined;
        readonly login?: PendingRecord["login"];
      },
    ) {
      const held = pendingOf(pendingId);
      const digest = NodeCrypto.createHash("sha256").update(sent.password).digest("hex");
      if (!held || held.kind !== "password" || held.digest !== digest)
        return yield* fail("not-found", "That new password isn't held.");
      // The login the form named, as it was at the fill: the reserved one, or one of the site's
      // logins then. One the fill didn't know isn't pinned to how it is now: the reservation's
      // site and profile, and the person's answer, decide.
      const known =
        sent.accountId === undefined
          ? undefined
          : sent.accountId === held.accountId
            ? {
                baseRef: held.baseRef,
                baseRevision: held.baseRevision,
                identity: held.pinnedIdentity,
                copyRefs: held.copyRefs,
              }
            : held.targets?.find((target) => target.accountId === sent.accountId);
      const now = sent.accountId ? findAccount(sent.accountId) : undefined;
      const baseRef = known ? known.baseRef : now?.values["password"];
      const baseRevision = known ? known.baseRevision : ownCount(now?.revisions, "password");
      const {
        accountId: _account,
        login: _login,
        baseRef: _base,
        baseRevision: _baseRevision,
        label: _label,
        pinnedIdentity: _pinned,
        copyRefs: _copies,
        targets: _targets,
        ...rest
      } = held;
      settling.add(pendingId);
      const at = yield* Clock.currentTimeMillis;
      yield* commit({
        ...state,
        pending: (state.pending ?? []).map((entry) =>
          entry === held
            ? {
                ...rest,
                ...(sent.label ? { label: sent.label.slice(0, 200) } : {}),
                ...(sent.accountId ? { accountId: sent.accountId } : {}),
                ...(sent.login ? { login: sent.login } : {}),
                ...(baseRef ? { baseRef } : {}),
                ...(baseRevision === undefined ? {} : { baseRevision }),
                ...(known?.identity === undefined ? {} : { pinnedIdentity: known.identity }),
                ...(known?.copyRefs ? { copyRefs: known.copyRefs } : {}),
                ...(sent.accountId && !known ? { unsampled: true as const } : {}),
                settleBy: DateTime.formatIso(DateTime.makeUnsafe(at + SETTLE_FOR_MS)),
              }
            : entry,
        ),
      });
      return pendingId;
    });
    type PasswordHistory = NonNullable<AccountsState["passwordHistory"]>[number];
    type PasswordVersion = PasswordHistory["versions"][number];
    const historyOf = (accountId: AccountId) =>
      (state.passwordHistory ?? []).find((history) => history.accountId === accountId)?.versions ??
      [];
    /** A login's earlier passwords offered to the person: those saved for it as it is now. */
    const offeredVersions = (row: StoredAccount) => {
      const identity = identityOf(row.summary);
      return historyOf(row.summary.accountId).filter(
        (entry) => entry.identity === identity && entry.ref !== row.values["password"],
      );
    };
    /**
     * `after` with every password a website login held in its history, in the same write as a new
     * one; nothing leaves it on its own (only the person's Remove of a version, or the login's
     * clear or removal). A version held again becomes the login's as it is now. An identity edit
     * makes the current one the edited login's, unproven, with no Previous.
     */
    const withPasswordHistory = (before: AccountsState, after: AccountsState, at: string) => {
      const was = new Map(before.accounts.map((row) => [row.summary.accountId, row]));
      const histories = new Map(
        (after.passwordHistory ?? []).map((history) => [history.accountId, history.versions]),
      );
      const cleared = new Set<string>();
      const passwordHistory: PasswordHistory[] = [];
      const accounts: StoredAccount[] = [];
      for (const row of after.accounts) {
        const accountId = row.summary.accountId;
        let versions = [...(histories.get(accountId) ?? [])];
        histories.delete(accountId);
        const old = was.get(accountId);
        const current = row.values["password"];
        const previous = row.previous?.password;
        const moved = old?.values["password"] !== current || old?.previous?.password !== previous;
        if (row.summary.details.kind === "website" && moved) {
          // A version the person removed stays out (its Undo puts it back).
          const removedRefs = new Set(
            (after.removedVersions ?? []).map((entry) => entry.version.ref),
          );
          const add = (ref: string | undefined, version: Omit<PasswordVersion, "ref">) => {
            if (
              ref !== undefined &&
              !versions.some((entry) => entry.ref === ref) &&
              !(removedRefs.has(ref) && ref !== current && ref !== previous)
            )
              versions.push({ ref, ...version });
          };
          const held = old?.summary.secrets["password"];
          const identityThen = identityOf((old ?? row).summary);
          add(old?.previous?.password, {
            identity: identityThen,
            ...(held?.previousAt ? { usedAt: held.previousAt } : {}),
          });
          add(old?.values["password"], {
            identity: identityThen,
            ...(held?.verifiedAt ? { provenAt: held.verifiedAt } : {}),
          });
          add(previous, { identity: identityOf(row.summary) });
          add(current, { identity: identityOf(row.summary), savedAt: at });
          // The one it stops holding was in use until now, and keeps when it last worked.
          const left = old?.values["password"];
          const worked = held?.verifiedAt;
          if (left !== undefined && left !== current)
            versions = versions.map((entry) =>
              entry.ref !== left
                ? entry
                : {
                    ...entry,
                    usedAt: at,
                    ...(worked && worked > (entry.provenAt ?? "") ? { provenAt: worked } : {}),
                  },
            );
          // Held again (saved anew with a value it kept under another login): now this one's,
          // unproven here.
          const identity = identityOf(row.summary);
          versions = versions.map((entry) => {
            if (entry.ref !== current || entry.identity === identity) return entry;
            const { provenAt: _proven, auto: _auto, ...unproven } = entry;
            return { ...unproven, identity };
          });
        }
        // The login edited into another: what it holds now is the edited login's, not proven
        // there nor Scient's to submit by itself; the earlier login's Previous stays in the
        // history only, its own.
        let kept = row;
        if (old && old.summary.details !== row.summary.details) {
          const identity = identityOf(row.summary);
          if (identity !== identityOf(old.summary)) {
            versions = versions.map((entry) => {
              if (entry.ref !== current) return entry;
              const { provenAt: _proven, auto: _auto, ...unproven } = entry;
              return { ...unproven, identity };
            });
            const secret = row.summary.secrets["password"];
            const { previous: _previous, ...rest } = row;
            if (secret) {
              const { verifiedAt: _verified, previousAt: _previousAt, ...unverified } = secret;
              kept = {
                ...rest,
                summary: {
                  ...row.summary,
                  secrets: { ...row.summary.secrets, password: unverified },
                },
              };
            }
          }
        }
        accounts.push(kept);
        // Its password cleared (with no Previous kept): its history goes too, and so do the
        // removals of its versions (nothing for their Undo to come back to).
        if (!row.summary.secrets["password"] && previous === undefined) {
          versions = [];
          cleared.add(accountId);
        }
        if (versions.length) passwordHistory.push({ accountId, versions });
      }
      const removedVersions = after.removedVersions?.filter(
        (entry) => !cleared.has(entry.accountId),
      );
      return {
        state: {
          ...after,
          accounts,
          passwordHistory,
          ...(removedVersions ? { removedVersions } : {}),
        },
      };
    };
    /** The login's history with `versions`, for a commit. */
    const withVersions = (accountId: AccountId, versions: ReadonlyArray<PasswordVersion>) =>
      (state.passwordHistory ?? []).map((history) =>
        history.accountId === accountId ? { accountId, versions } : history,
      );
    /** A password Scient saved on a site's word: it may submit it by itself until refused. */
    const markAuto = (accountId: AccountId, ref: string) =>
      Effect.suspend(() =>
        commit({
          ...state,
          passwordHistory: withVersions(
            accountId,
            historyOf(accountId).map((entry) =>
              entry.ref === ref ? { ...entry, auto: true as const } : entry,
            ),
          ),
        }),
      );
    /**
     * The login holds `ref` (from its history) now, with `summary`; the one it held becomes its
     * Previous. Nothing leaves the history.
     */
    const holdVersion = (
      row: StoredAccount,
      ref: string,
      summary: AccountSummary,
      versions: ReadonlyArray<PasswordVersion>,
    ) => {
      const held = row.values["password"];
      const previous = held !== undefined && held !== ref ? held : row.previous?.password;
      const { previous: _, ...rest } = row;
      return commit({
        ...replaceAccount({
          ...rest,
          values: { ...row.values, password: ref },
          ...(previous !== undefined && previous !== ref
            ? { previous: { password: previous } }
            : {}),
          summary,
        }),
        passwordHistory: withVersions(row.summary.accountId, versions),
      });
    };
    /** A website password's secret as held anew: what the site said of another isn't said of it. */
    const freshPassword = (secret: AccountSecretSummary, provenAt: string | undefined) => {
      const { refusedAt: _refused, verifiedAt: _verified, ...password } = secret;
      return provenAt === undefined ? password : { ...password, verifiedAt: provenAt };
    };
    /**
     * A sign-in bound to one of a login's passwords (`ref`, typed as `identity`) only orders the
     * history. Signed in: proven and held. Refused: marked; if held, the last proven or else newest
     * unrefused one is next; with all refused, the newest is held, refused. Under the write lock.
     */
    const settlePassword = Effect.fn("AccountsService.settlePassword")(function* (
      accountId: AccountId,
      ref: string,
      identity: string,
      outcome: "signed-in" | "password-rejected",
    ) {
      const row = findAccount(accountId);
      const secret = row?.summary.secrets["password"];
      // A result for the login as it was before an edit moves nothing.
      if (!row || !secret || identityOf(row.summary) !== identity) return;
      const stamp = yield* now;
      const found = historyOf(accountId).some((entry) => entry.ref === ref);
      if (!found) return;
      if (outcome === "signed-in") {
        const versions = historyOf(accountId).map((entry) => {
          if (entry.ref !== ref) return entry;
          const { refused: _, ...kept } = entry;
          return { ...kept, provenAt: stamp, usedAt: stamp };
        });
        return yield* holdVersion(
          row,
          ref,
          {
            ...row.summary,
            secrets: { ...row.summary.secrets, password: freshPassword(secret, stamp) },
          },
          versions,
        );
      }
      const versions = historyOf(accountId).map((entry) =>
        entry.ref === ref ? { ...entry, refused: true as const, usedAt: stamp } : entry,
      );
      if (row.values["password"] !== ref)
        return yield* commit({ ...state, passwordHistory: withVersions(accountId, versions) });
      const mine = versions.filter((entry) => entry.identity === identity);
      const next =
        mine
          .filter((entry) => !entry.refused)
          .reduce<PasswordVersion | undefined>(
            (best, entry) =>
              best === undefined || (entry.provenAt ?? "") >= (best.provenAt ?? "") ? entry : best,
            undefined,
          ) ?? mine.at(-1);
      if (!next || next.ref === ref)
        return yield* commit({ ...state, passwordHistory: withVersions(accountId, versions) });
      // Another password: Scient tries it. With every one refused, the newest waits, refused.
      const { signIn, ...unrefused } = row.summary;
      yield* holdVersion(
        row,
        next.ref,
        {
          ...(next.refused || signIn?.state !== "password-rejected" ? row.summary : unrefused),
          secrets: {
            ...row.summary.secrets,
            password: next.refused
              ? { ...freshPassword(secret, undefined), refusedAt: stamp }
              : freshPassword(secret, next.provenAt),
          },
        },
        versions,
      );
    });
    /** A version of a login's password as its client names it: never its ref. */
    const versionIdOf = (ref: string) =>
      NodeCrypto.createHash("sha256").update(ref).digest("hex").slice(0, 16);
    /**
     * Whether a fill of `ref` on `origin` may be submitted by itself, counted in the same write if
     * so: a password that worked or was saved on a site's word, not refused, and on the site's
     * registrable domain no failed or limited sign-in, nor a submit by itself not proven signed
     * in, within FAILURE_WINDOW_MS. After any refusal the person submits; Scient never retries.
     */
    const grantSubmit = Effect.fn("AccountsService.grantSubmit")(function* (
      account: StoredAccount,
      ref: string,
      origin: string,
      attempt: string,
    ) {
      const atMs = yield* Clock.currentTimeMillis;
      const site = sharedSite(origin);
      const recent = (at: string) => atMs - Date.parse(at) < FAILURE_WINDOW_MS;
      const version = historyOf(account.summary.accountId).find((entry) => entry.ref === ref);
      const tryable =
        version?.refused !== true &&
        (account.summary.secrets["password"]?.verifiedAt !== undefined ||
          version?.provenAt !== undefined ||
          version?.auto === true);
      const failed = (state.signInFailures ?? []).some(
        (entry) => entry.site === site && recent(entry.at),
      );
      const unsettled = (state.autoSubmits ?? []).some(
        (entry) => entry.site === site && recent(entry.at) && entry.outcome !== "signed-in",
      );
      if (!tryable || failed || unsettled) return false;
      yield* commit(
        {
          ...state,
          autoSubmits: [
            ...(state.autoSubmits ?? []).filter((entry) => recent(entry.at)),
            {
              site,
              at: DateTime.formatIso(DateTime.makeUnsafe(atMs)),
              attempt,
              accountId: account.summary.accountId,
            },
          ],
        },
        true,
      );
      return true;
    });
    /**
     * Sign-in attempts in the person's tabs, each the password, login and site one fill typed:
     * its result counts once, within ATTEMPT_FOR_MS.
     */
    const tabAttempts = new Map<
      string,
      { accountId: AccountId; ref: string; identity: string; origin: string; until: number }
    >();
    const openAttempt = (account: StoredAccount, ref: string, origin: string, at: number) => {
      for (const [id, entry] of tabAttempts)
        if (entry.until <= at || tabAttempts.size >= ATTEMPTS_KEPT) tabAttempts.delete(id);
      const attemptId = NodeCrypto.randomUUID();
      tabAttempts.set(attemptId, {
        accountId: account.summary.accountId,
        ref,
        identity: identityOf(account.summary),
        origin,
        until: at + ATTEMPT_FOR_MS,
      });
      return attemptId;
    };
    /** Marks a pending secret (unclear, in conflict). Runs under the write lock. */
    const markPending = (
      pendingId: string,
      marks: { readonly unclear?: true; readonly conflict?: true },
    ) =>
      Effect.suspend(() =>
        commit({
          ...state,
          pending: (state.pending ?? []).map((entry) =>
            entry.pendingId === pendingId ? { ...entry, ...marks } : entry,
          ),
        }),
      );
    /** Forgets a pending secret and its value. Runs under the write lock. */
    const dropPending = Effect.fn("AccountsService.dropPending")(function* (pendingId: string) {
      settling.delete(pendingId);
      const held = pendingOf(pendingId);
      if (!held) return;
      yield* commit({
        ...state,
        pending: (state.pending ?? []).filter((entry) => entry !== held),
      });
    });
    /**
     * Puts a pending secret on its login under one write lock: a new password only on its login
     * still the same (site, profile, username) with the password it had then, else both are kept
     * until the person says (`replace`); a factor only on the login as the person saw it, still on
     * the page's site and profile, or on a new login.
     */
    const savePending = Effect.fn("AccountsService.savePending")(function* (
      pendingId: string,
      choice: {
        readonly accountId?: AccountId;
        readonly updatedAt?: string;
        readonly replace?: boolean;
        /** The person's own answer, not the site's. */
        readonly person?: boolean;
      },
    ) {
      const first = pendingOf(pendingId);
      if (!first) return yield* fail("not-found", "It was already settled.");
      if (first.kind === "password") {
        const later: SaveLater = {};
        const answer = yield* locked(
          Effect.gen(function* () {
            const held = pendingOf(pendingId);
            if (!held) return yield* fail("not-found", "It was already settled.");
            const value = yield* readValue(held.valueRef);
            const row = held.accountId ? findAccount(held.accountId) : undefined;
            const details = row?.summary.details;
            const sameLogin =
              row !== undefined &&
              details?.kind === "website" &&
              factorLogins(held.origin, held.profileId).some(
                (login) => login.accountId === row.summary.accountId,
              ) &&
              (!held.label ||
                !details.username ||
                loginUserKey(details.username) === loginUserKey(held.label)) &&
              // Still the login it was at the fill: sites, tenant, owner and profile.
              (held.pinnedIdentity === undefined ||
                identityOf(row.summary) === held.pinnedIdentity);
            // Over the same write of its password as at the fill, not just the same value; one
            // pinned by an older build (no revision) is the person's to confirm.
            const samePassword =
              sameLogin &&
              row.values["password"] === held.baseRef &&
              (held.baseRevision === undefined
                ? choice.person === true
                : ownCount(row.revisions, "password") === held.baseRevision);
            // "Use this one" puts it only on the same login, as the person saw it then.
            if (
              choice.replace &&
              (!sameLogin ||
                choice.updatedAt === undefined ||
                row.summary.updatedAt !== choice.updatedAt)
            )
              return yield* fail("conflict", "That login changed since. Look at it again.");
            if (held.accountId && !samePassword && !choice.replace) {
              settling.delete(held.pendingId);
              yield* markPending(held.pendingId, { unclear: true, conflict: true });
              return { pendingId: held.pendingId, conflict: true as const };
            }
            // A login the fill didn't know: how it was then can't be told, so the person says.
            if (held.unsampled && !choice.person) {
              settling.delete(held.pendingId);
              yield* markPending(held.pendingId, { unclear: true });
              return { pendingId: held.pendingId };
            }
            // A login without a username takes the one the form sent, as a sign-in's save does.
            const named =
              held.login?.details.kind === "website" ? held.login.details.username : undefined;
            const target =
              row && details?.kind === "website"
                ? {
                    accountId: row.summary.accountId,
                    name: row.summary.name,
                    details: {
                      ...details,
                      ...(details.username || !named ? {} : { username: named }),
                    },
                  }
                : held.login
                  ? { name: held.login.name, details: held.login.details }
                  : undefined;
            if (!target) return yield* fail("not-found", "Its login is gone.");
            // Only its copies as they were at the fill (the same login, still holding the password
            // they had). A copy an older build pinned by its password alone is the person's to
            // confirm.
            const copies = (held.copyRefs ?? []).filter((pinned) => {
              const copy = findAccount(pinned.accountId);
              return (
                copy !== undefined &&
                pinned.ref === copy.values["password"] &&
                (pinned.revision === undefined
                  ? choice.person === true
                  : ownCount(copy.revisions, "password") === pinned.revision) &&
                (pinned.identity === undefined
                  ? choice.person === true
                  : pinned.identity === identityOf(copy.summary))
              );
            });
            const before = row?.values["password"];
            const { saved } = yield* saveWithReceipt(
              {
                ...target,
                secrets: { password: { type: "scient", value: Redacted.value(value) } },
              },
              {},
              later,
              (copy) => copies.some((pinned) => pinned.accountId === copy.summary.accountId),
            );
            // On the site's word, Scient may submit it by itself until a site refuses it.
            if (!choice.person)
              for (const { accountId, before: was } of [
                { accountId: saved.accountId, before },
                ...copies.map((pinned) => ({ accountId: pinned.accountId, before: pinned.ref })),
              ]) {
                const current = findAccount(accountId)?.values["password"];
                if (current !== undefined && current !== was) yield* markAuto(accountId, current);
              }
            yield* dropPending(held.pendingId);
            return { accountId: saved.accountId };
          }),
        );
        // Copies to the Keychain and 1Password are written once the permit is free.
        if (later.finish) yield* later.finish.pipe(Effect.ignore);
        return answer;
      }
      // A factor goes on a saved login only as the person saw it: its version is required.
      if (choice.accountId && choice.updatedAt === undefined)
        return yield* fail("invalid-input", "Choose the login again.");
      const laters: SaveLater[] = [];
      const answer = yield* locked(
        Effect.gen(function* () {
          const held = pendingOf(pendingId);
          if (!held || held.kind === "password")
            return yield* fail("not-found", "It was already settled.");
          const value = yield* readValue(held.valueRef);
          const host = URL.parse(held.origin)?.hostname ?? held.origin;
          const site = {
            origin: held.origin,
            ...(held.profileId === undefined ? {} : { profileId: held.profileId }),
          };
          const [kept] = yield* keepFoundNow(
            [
              choice.accountId
                ? {
                    field: held.kind,
                    value,
                    accountId: choice.accountId,
                    updatedAt: choice.updatedAt,
                    site,
                  }
                : {
                    field: held.kind,
                    value,
                    site,
                    login: {
                      name: host.slice(0, 80),
                      details: {
                        kind: "website",
                        sites: [held.origin],
                        ...(held.label ? { username: held.label } : {}),
                        ...(held.profileId === undefined ? {} : { profileId: held.profileId }),
                      },
                    },
                  },
            ],
            laters,
          );
          // The chosen login changed, or left the site, since the person saw it: choose again.
          if (choice.accountId && kept === undefined)
            return yield* fail("conflict", "That login changed. Choose again.");
          yield* dropPending(held.pendingId);
          return kept ? { accountId: kept } : {};
        }),
      );
      for (const later of laters) if (later.finish) yield* Effect.ignore(later.finish);
      return answer;
    });
    /** Round 1's one list of used backup codes, moved onto each code's login. On load. */
    const keepUsedCodesOnLogins = Effect.suspend(() => {
      const { usedBackupCodes, ...rest } = state;
      if (usedBackupCodes === undefined) return Effect.void;
      return commit({
        ...rest,
        accounts: rest.accounts.map((row) => {
          const mine = usedBackupCodes
            .filter((entry) => entry.accountId === row.summary.accountId)
            .map((entry) => entry.digest);
          return mine.length
            ? {
                ...row,
                usedCodes: [...new Set([...(row.usedCodes ?? []), ...mine])].slice(
                  -USED_CODES_KEPT,
                ),
              }
            : row;
        }),
      });
    });
    /**
     * Round 6's kept password per login (its last proven) joins the login's history, oldest,
     * before the Previous and current ones it held beside it. On load.
     */
    const keepUnconfirmedInHistory = Effect.suspend(() => {
      const { unconfirmed, ...rest } = state;
      if (unconfirmed === undefined) return Effect.void;
      const histories = new Map(
        (rest.passwordHistory ?? []).map((history) => [history.accountId, history.versions]),
      );
      for (const { accountId, confirmedRef } of unconfirmed) {
        const row = findAccount(accountId);
        if (!row) continue;
        const identity = identityOf(row.summary);
        const versions = histories.get(accountId) ?? [];
        const refs = [confirmedRef, row.previous?.password, row.values["password"]].filter(
          (ref): ref is string => ref !== undefined && !versions.some((entry) => entry.ref === ref),
        );
        histories.set(accountId, [
          ...[...new Set(refs)].map((ref) => ({ ref, identity })),
          ...versions,
        ]);
      }
      return commit({
        ...rest,
        passwordHistory: [...histories].map(([accountId, versions]) => ({ accountId, versions })),
      });
    });
    /**
     * A page's 2FA key or backup codes nobody saved within FACTOR_KEPT_MS are forgotten (the page
     * can be read again). A new password never is: once its `settleBy` passes unanswered it is the
     * person's, shown until they save or discard it. Password Undos past their hour go, with the
     * values only they kept. On load, and each PENDING_LOOK_GAP.
     */
    const expirePending = Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      yield* pruneUndos(at);
      // A removed version past its Undo's hour: its value is journaled by this write.
      const lapsed = (state.removedVersions ?? []).filter((entry) => entry.until <= at);
      if (lapsed.length)
        yield* commit({
          ...state,
          removedVersions: (state.removedVersions ?? []).filter((entry) => entry.until > at),
        });
      for (const held of state.pending ?? [])
        if (held.kind !== "password" && Date.parse(held.since) + FACTOR_KEPT_MS <= at)
          yield* dropPending(held.pendingId);
      const due = (state.pending ?? []).filter(
        (held) =>
          settling.has(held.pendingId) &&
          held.settleBy !== undefined &&
          Date.parse(held.settleBy) <= at,
      );
      for (const held of due) settling.delete(held.pendingId);
      if (due.length) yield* publish(false);
    });
    yield* Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(PENDING_LOOK_GAP);
        if (initialized) yield* locked(expirePending).pipe(Effect.ignore);
        if (initialized) yield* sweepUnreferenced.pipe(Effect.ignore);
        // A temporary file a quick restart found too young is reclaimed once it ages out.
        yield* persistence.reclaimTemporary;
      }
    }).pipe(Effect.forkIn(serviceScope));
    // A store refused for want of a person opens once someone is at a window: one try per refusal,
    // its keychain dialog theirs to answer. Opened, `changes` tells everything waiting; a dialog
    // dismissed waits for the next refusal.
    yield* vault.personArrived.pipe(
      Effect.andThen(locked(Effect.void).pipe(Effect.ignore)),
      Effect.forever,
      Effect.forkIn(serviceScope),
    );
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
            // A newer card, or one offering no Use saved, ends a click on the one before.
            forgetSaved(handoff.handoffId, handoff.useSavedRevision ?? "");
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
            forgetSaved(handoffId);
            chosenCodes.delete(handoffId);
            claimedCodes.delete(handoffId);
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
      setSignInEnd: Effect.fn("AccountsService.setSignInEnd")((end) =>
        locked(
          Effect.gen(function* () {
            signInEnds.set(end.accountId, end);
            yield* publish(false);
          }),
        ).pipe(Effect.ignore),
      ),
      renameIfUnchanged: Effect.fn("AccountsService.renameIfUnchanged")((accountId, seen, name) =>
        locked(
          Effect.gen(function* () {
            const account = findAccount(accountId);
            const details = account?.summary.details;
            if (
              !account ||
              account.summary.name !== seen.name ||
              details?.kind !== "website" ||
              details.proxyUrl !== seen.proxyUrl
            )
              return;
            yield* commit(replaceAccount({ ...account, summary: { ...account.summary, name } }));
          }),
        ),
      ),
      beginSignOut: Effect.fn("AccountsService.beginSignOut")((accountIds, targets) =>
        locked(
          Effect.gen(function* () {
            const ops = state.universitySignOuts ?? [];
            const open = ops.find((op) => op.accountIds.some((id) => accountIds.includes(id)));
            if (open) return open;
            const seq = (state.universitySignOutSeq ?? 0) + 1;
            const op: UniversitySignOut = {
              opId: NodeCrypto.randomUUID(),
              seq,
              accountIds: [...accountIds],
              pending: [...targets],
            };
            const signIn = { state: "signed-out" as const, at: yield* now, by: "action" as const };
            // One write for the whole membership and its sign-out: all of it, or none.
            yield* commit(
              {
                ...state,
                accounts: state.accounts.map((account) =>
                  accountIds.includes(account.summary.accountId)
                    ? { ...account, summary: { ...account.summary, signIn } }
                    : account,
                ),
                universitySignOuts: [...ops, op],
                universitySignOutSeq: seq,
              },
              true,
            );
            return op;
          }),
        ),
      ),
      settleSignOut: Effect.fn("AccountsService.settleSignOut")((opId, cleared) =>
        locked(
          Effect.gen(function* () {
            const ops = state.universitySignOuts ?? [];
            const op = ops.find((item) => item.opId === opId);
            if (!op) return undefined;
            const done = (target: UniversitySignOutTarget) =>
              cleared.some(
                (item) => item.profileId === target.profileId && item.site === target.site,
              );
            const settled = { ...op, pending: op.pending.filter((target) => !done(target)) };
            yield* commit(
              {
                ...state,
                universitySignOuts: settled.pending.length
                  ? ops.map((item) => (item.opId === opId ? settled : item))
                  : ops.filter((item) => item.opId !== opId),
              },
              true,
            );
            return settled;
          }),
        ),
      ),
      supersedeSignOuts: Effect.fn("AccountsService.supersedeSignOuts")((accountId) =>
        locked(
          Effect.gen(function* () {
            const ops = state.universitySignOuts ?? [];
            const kept = ops.filter((op) => !op.accountIds.includes(accountId));
            if (kept.length !== ops.length)
              yield* commit({ ...state, universitySignOuts: kept }, true);
          }),
        ).pipe(Effect.ignore),
      ),
      handoffCancelled: Effect.fn("AccountsService.handoffCancelled")((handoffId) =>
        Effect.sync(() => cancelledHandoffs.has(handoffId)),
      ),
      // Paper recovery runs at every start, before any foreground use. While unattended work waits
      // for the person it must not open the store, so the first snapshot carries the queue.
      setPaperQueue: Effect.fn("AccountsService.setPaperQueue")((queue) => {
        const record = Effect.gen(function* () {
          paperQueues.set(queue.root, queue);
          if (initialized) yield* publish(false);
        });
        return (
          vault.unattendedWaitsForPerson
            ? writes.withPermits(1)(Effect.uninterruptible(record))
            : locked(record)
        ).pipe(Effect.ignore);
      }),
      // Never waits: an open under way, or one that needs the person, answers false.
      openWithoutPrompt: Effect.suspend(() =>
        initialized
          ? Effect.succeed(true)
          : writes
              .withPermitsIfAvailable(1)(
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    if (initialized) return true;
                    if (!(yield* vault.openWithoutPrompt)) return false;
                    yield* initialize;
                    return true;
                  }),
                ),
              )
              .pipe(Effect.map(Option.getOrElse(() => false))),
      ),
      unattendedWaitsForPerson: Effect.succeed(vault.unattendedWaitsForPerson),
      showHandoff: Effect.fn("AccountsService.showHandoff")(function* (handoffId) {
        const reveal = yield* locked(
          Effect.sync(() => (handoffs.has(handoffId) ? handoffReveals.get(handoffId) : undefined)),
        );
        if (!reveal) return yield* fail("not-found", "The sign-in is no longer waiting.");
        yield* reveal;
      }),
      useSavedInHandoff: Effect.fn("AccountsService.useSavedInHandoff")((handoffId, revision) =>
        locked(
          Effect.gen(function* () {
            const handoff = handoffs.get(handoffId);
            if (handoff?.useSaved === undefined)
              return yield* fail("not-found", "The sign-in is no longer waiting.");
            // A click on a card the sign-in has since replaced counts for nothing.
            if (handoff.useSavedRevision !== revision)
              return yield* fail("not-found", "The sign-in moved on. Look at it again.");
            // A retry of a click the sign-in already took is done: it isn't queued twice.
            if (savedTaken.get(handoffId)?.has(revision)) return;
            savedRequests.set(handoffId, revision);
          }),
        ),
      ),
      savedRequested: Effect.fn("AccountsService.savedRequested")((handoffId) =>
        Effect.sync(() => {
          const revision = savedRequests.get(handoffId);
          savedRequests.delete(handoffId);
          if (revision !== undefined)
            savedTaken.set(handoffId, (savedTaken.get(handoffId) ?? new Set()).add(revision));
          return revision;
        }),
      ),
      cancelHandoff: Effect.fn("AccountsService.cancelHandoff")((handoffId) =>
        locked(
          Effect.gen(function* () {
            if (!handoffs.has(handoffId))
              return yield* fail("not-found", "The sign-in is no longer waiting.");
            cancelledHandoffs.add(handoffId);
            handoffs.delete(handoffId);
            forgetSaved(handoffId);
            yield* publish(false);
          }),
        ),
      ),
      setNeedsYou: Effect.fn("AccountsService.setNeedsYou")((need) =>
        locked(
          Effect.gen(function* () {
            const kept = state.needsYou?.find((entry) => entry.needId === need.needId);
            const since = kept?.since ?? (yield* now);
            const others = (state.needsYou ?? []).filter((entry) => entry.needId !== need.needId);
            // Nothing a key or binding depends on changes.
            yield* commit({ ...state, needsYou: [...others, { ...need, since }] }, true);
          }),
        ),
      ),
      clearNeedsYou: Effect.fn("AccountsService.clearNeedsYou")((needId) =>
        locked(
          Effect.suspend(() =>
            state.needsYou?.some((entry) => entry.needId === needId)
              ? commit(
                  { ...state, needsYou: state.needsYou.filter((entry) => entry.needId !== needId) },
                  true,
                )
              : Effect.void,
          ),
        ),
      ),
      insertHandoffCode: Effect.fn("AccountsService.insertHandoffCode")((handoffId, codeId) =>
        locked(
          Effect.gen(function* () {
            const handoff = handoffs.get(handoffId);
            // Its sign-in takes a click until the wait's own deadline, and not after.
            const backup = codeId === BACKUP_CODE_ID;
            if (
              !(backup
                ? handoff?.backupCodes
                : handoff?.codes?.some((code) => code.codeId === codeId)) ||
              Date.parse(handoff!.expiresAt) <= (yield* Clock.currentTimeMillis)
            )
              return yield* fail("not-found", "The code is no longer waiting.");
            // A backup code is the person's own; the Mac's codes switch is about found ones.
            if (
              !backup &&
              !(sources.codesHost !== undefined && state.codeSources?.messages !== false)
            )
              return yield* fail("denied", "Codes from this Mac are off.");
            if (claimedCodes.has(handoffId))
              return yield* fail("conflict", "A code already went in for this sign-in.");
            claimedCodes.add(handoffId);
            chosenCodes.set(handoffId, codeId);
          }),
        ),
      ),
      claimHandoffCode: Effect.fn("AccountsService.claimHandoffCode")((handoffId) =>
        locked(
          Effect.sync(() => {
            if (claimedCodes.has(handoffId)) return false;
            claimedCodes.add(handoffId);
            return true;
          }),
        ).pipe(Effect.orElseSucceed(() => false)),
      ),
      chosenHandoffCode: Effect.fn("AccountsService.chosenHandoffCode")((handoffId) =>
        Effect.sync(() => {
          const chosen = chosenCodes.get(handoffId);
          chosenCodes.delete(handoffId);
          return chosen;
        }),
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
      save: Effect.fn("AccountsService.saveInput")(function* (raw) {
        const input = yield* decodeSave(raw).pipe(
          Effect.mapError(() => fail("invalid-input", "Account input is invalid.")),
        );
        // Linking a copied value to the Keychain or 1Password reads it there: before the permit,
        // and only for the row and store as they still are when it saves.
        const fields = Object.keys(input.secrets);
        const preflight = () =>
          valuesVersion(input.accountId ? findAccount(input.accountId) : undefined, fields);
        const { linking, version } = yield* locked(
          Effect.sync(() => {
            const existing = input.accountId ? findAccount(input.accountId) : undefined;
            return {
              version: preflight(),
              linking: Object.entries(input.secrets).flatMap(([field, change]) =>
                (change.type === "keychain" || change.type === "1password") &&
                existing?.summary.secrets[field]?.copies?.length
                  ? [{ field, change }]
                  : [],
              ),
            };
          }),
        );
        const linkedValues: Record<string, Redacted.Redacted<string>> = Object.create(null);
        for (const { field, change } of linking) {
          if (change.type === "keychain") linkedValues[field] = yield* sources.keychain(change);
          if (change.type === "1password")
            linkedValues[field] = yield* (yield* getOnePasswordClient).resolve(change.reference);
        }
        const later: { finish?: Effect.Effect<AccountSaveResult, AccountsError> } = {};
        const { saved, copies, undoId } = yield* locked(
          Effect.gen(function* () {
            if (linking.length && preflight() !== version)
              return yield* fail("conflict", "The account changed meanwhile. Save again.");
            return yield* saveWithReceipt(input, linkedValues, later);
          }),
        );
        // Copies to the Keychain and 1Password are written once the permit is free.
        const finished = later.finish ? yield* later.finish : saved;
        const result = undoId === undefined ? finished : { ...finished, undoId };
        const warnings = [...new Set([...(result.warnings ?? []), ...copies])];
        return warnings.length ? { ...result, warnings } : result;
      }),
      remove: Effect.fn("AccountsService.remove")((accountId, seenAt, operationId) =>
        locked(removeNow(accountId, seenAt, operationId)),
      ),
      agentRemove: Effect.fn("AccountsService.agentRemove")((accountId, version, by) =>
        locked(
          Effect.gen(function* () {
            yield* agentRow(accountId, version, by);
            const removedNow = yield* removeNow(
              accountId,
              version,
              NodeCrypto.randomUUID(),
              by.threadId,
            );
            yield* appendChange({ target: { type: "account", accountId }, change: "remove" }, by);
            return removedNow;
          }),
        ),
      ),
      agentSaveOffer: Effect.fn("AccountsService.agentSaveOffer")((accountId, version, by) =>
        locked(
          Effect.gen(function* () {
            const row = yield* agentRow(accountId, version, by);
            const { details } = row.summary;
            const origins = new Set(
              ("sites" in details ? details.sites : []).flatMap((site) => {
                const url = URL.parse(site.includes("://") ? site : `https://${site}`);
                return url ? [url.origin] : [];
              }),
            );
            const neverAsk = (state.neverAsk ?? []).filter((origin) => !origins.has(origin));
            if (neverAsk.length !== (state.neverAsk ?? []).length)
              yield* commit({ ...state, neverAsk }, true);
            yield* appendChange(
              { target: { type: "account", accountId }, change: "save-offer" },
              by,
            );
          }),
        ),
      ),
      agentRestore: Effect.fn("AccountsService.agentRestore")((accountId, removalId, by) =>
        locked(
          Effect.gen(function* () {
            if (!state.agentAccess)
              return yield* fail("denied", "Agent access to Accounts is off.");
            const entry = unexpired(removed, yield* Clock.currentTimeMillis).find(
              (entry) => entry.row.summary.accountId === accountId && entry.removalId === removalId,
            );
            if (!entry) return yield* fail("not-found", "It can no longer be brought back.");
            // Only the chat that removed it, and only where it still may: the rest is the user's.
            const { controls } = entry.row.summary;
            if (
              entry.threadId !== by.threadId ||
              privateUse(entry.row.summary) ||
              controls.access === "off" ||
              !inScope(controls.scope, by.projectId)
            )
              return yield* fail(
                "denied",
                "Another chat or the user removed it; the user can bring it back in Accounts.",
              );
            yield* restoreNow(accountId, removalId);
            yield* appendChange({ target: { type: "account", accountId }, change: "restore" }, by);
          }),
        ),
      ),
      restore: Effect.fn("AccountsService.restore")((accountId, removalId) =>
        locked(restoreNow(accountId, removalId)),
      ),
      test: Effect.fn("AccountsService.test")(function* (accountId) {
        const { fields, tested } = yield* locked(
          Effect.suspend(() => {
            const existing = findAccount(accountId);
            if (!existing) return missing();
            const fields = Object.keys(existing.summary.secrets);
            return Effect.succeed({ fields, tested: valuesVersion(existing, fields) });
          }),
        );
        const result = yield* readOutside(accountId, fields).pipe(Effect.result);
        yield* locked(
          Effect.gen(function* () {
            const existing = findAccount(accountId);
            if (!existing) return yield* missing();
            // Saved again meanwhile: this result is about values the row no longer holds.
            const fieldsNow = Object.keys(existing.summary.secrets);
            if (fieldsNow.join() !== fields.join() || valuesVersion(existing, fields) !== tested)
              return;
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
          }),
        );
        if (result._tag === "Failure") return yield* result.failure;
      }),
      setControls: Effect.fn("AccountsService.setControls")((input) =>
        locked(applyControls(input)),
      ),
      agentControls: Effect.fn("AccountsService.agentControls")((input, version, by) =>
        locked(
          Effect.gen(function* () {
            const controls =
              input.target.type === "account"
                ? (yield* agentRow(input.target.accountId, version, by)).summary.controls
                : yield* agentProfile(input.target.profileId, version, by);
            // Checked against the controls as they are now: an agent never loosens what binds it.
            if (!tightensOnly(controls, input))
              return yield* fail(
                "denied",
                "An agent can only tighten controls; the person turns them on for agents.",
              );
            yield* applyControls(input);
            yield* appendChange({ target: input.target, change: "controls" }, by);
          }),
        ),
      ),
      agentEdit: Effect.fn("AccountsService.agentEdit")((accountId, seenAt, change, by) =>
        locked(
          Effect.gen(function* () {
            const row = yield* agentRow(accountId, seenAt, by);
            const edited = editedDetails(row.summary.details, change);
            if ("refused" in edited) return yield* fail("denied", edited.refused);
            const name = change.name?.trim() || row.summary.name;
            yield* save({ accountId, name, details: edited.details, secrets: {} });
            yield* appendChange(
              {
                target: { type: "account", accountId },
                change: "edit",
                ...(name === row.summary.name ? {} : { detail: name.slice(0, 200) }),
              },
              by,
            );
            return findAccount(accountId)!.summary;
          }),
        ),
      ),
      recordChange: Effect.fn("AccountsService.recordChange")((entry, by) =>
        locked(appendChange(entry, by)).pipe(Effect.ignore),
      ),
      setAgentAccess: Effect.fn("AccountsService.setAgentAccess")((enabled) =>
        locked(
          Effect.suspend(() =>
            (enabled ? Effect.void : takeBackLinks(() => false)).pipe(
              Effect.andThen(commit({ ...state, agentAccess: enabled })),
              Effect.andThen(denyRevoked),
            ),
          ),
        ),
      ),
      setRenewAutomatically: Effect.fn("AccountsService.setRenewAutomatically")((enabled) =>
        locked(
          Effect.suspend(() => {
            const { renewAutomatically: _previous, ...rest } = state;
            return commit(enabled ? rest : { ...rest, renewAutomatically: false });
          }),
        ),
      ),
      // Unreadable, renewal only looks.
      renewAutomatically: locked(Effect.sync(() => state.renewAutomatically ?? true)).pipe(
        Effect.orElseSucceed(() => false),
      ),
      updateProfile: Effect.fn("AccountsService.updateProfile")((input) =>
        locked(
          Effect.gen(function* () {
            const next = { ...effectiveProfile(state.profiles, input.profileId) };
            for (const key of ["picture", "color", "source"] as const) {
              if (input[key] === null) delete next[key];
            }
            if (input.madeInScient) next.madeInScient = input.madeInScient;
            const updated = [
              ...state.profiles.filter((profile) => profile.profileId !== input.profileId),
              {
                ...next,
                ...(input.picture ? { picture: input.picture } : {}),
                ...(input.color ? { color: input.color } : {}),
                ...(input.source ? { source: input.source } : {}),
              },
            ];
            yield* commit({
              ...state,
              // The person's link is the browser profile's one: any other goes (round 6h).
              profiles: input.source ? soleLink(updated, input.profileId, input.source) : updated,
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
      attachProfileStore: Effect.fn("AccountsService.attachProfileStore")((store) =>
        Effect.gen(function* () {
          profileStore = store;
          // Accounts not open yet: its first read drops them (`initialize`).
          if (initialized) yield* locked(dropForeignLists).pipe(Effect.ignore);
          // Accounts not open yet: its first read tells the browser (`initialize`).
          if (initialized) yield* store.generations(generations());
          // Cut short by a restart: this browser's part of each one still in its hour goes on.
          if (initialized) yield* resumeUnfinished;
        }),
      ),
      admitProfileTab: Effect.fn("AccountsService.admitProfileTab")(function* <A, E, R>(
        profileId: BrowserProfileId,
        threadId: ProfileThreadId,
        open: Effect.Effect<A, E, R>,
      ) {
        return yield* Effect.acquireUseRelease(
          locked(
            Effect.gen(function* () {
              const record = effectiveProfile(state.profiles, profileId);
              if (record.removed || record.retired)
                return yield* fail("denied", "This profile was removed.");
              const token = Symbol(threadId);
              const opening = admitting.get(profileId) ?? new Map<symbol, ProfileThreadId>();
              admitting.set(profileId, opening.set(token, threadId));
              return token;
            }),
          ),
          () => open,
          (token) =>
            Effect.sync(() => {
              const opening = admitting.get(profileId);
              opening?.delete(token);
              if (opening?.size === 0) admitting.delete(profileId);
            }),
        );
      }),
      operateProfile: Effect.fn("AccountsService.operateProfile")(
        function* (input, by, openTabs, version) {
          const decided = yield* locked(
            Effect.gen(function* (): Effect.fn.Return<
              ProfileOperateResult & { readonly fresh?: true },
              AccountsError
            > {
              if (!isTabList(openTabs)) openTabLookups.set(input.operationId, openTabs);
              // Read here, under the permit, with the tabs still opening: none slips past.
              const openIn = [
                ...new Set([
                  ...(isTabList(openTabs) ? openTabs : yield* openTabs),
                  ...(admitting.get(input.profileId)?.values() ?? []),
                ]),
              ];
              const again = operationOf(input.operationId);
              if (again) return { operation: again };
              // The same agent call, matched here under the permit (round 6f): two arriving
              // together get one receipt, its id and anything named after it allocated once.
              if (input.requestKey) {
                const atMs = yield* Clock.currentTimeMillis;
                const earlier = (state.profileOperations ?? [])
                  .toReversed()
                  .find(
                    (operation) =>
                      operation.requestKey === input.requestKey &&
                      !operation.undone &&
                      live(operation, atMs),
                  );
                if (earlier) return { operation: earlier };
              }
              if (by && !state.agentAccess)
                return yield* fail(
                  "denied",
                  "Agent access to Accounts is off. The user can turn it on.",
                );
              const nowMs = yield* Clock.currentTimeMillis;
              // An import by its source (AMENDMENTS 58), or a refresh found through the link.
              const reported = (state.sourceProfiles ?? []).flatMap(
                ({ computer, seenAt, sources }) =>
                  // Not heard from for an hour: gone, its reports failing or not (round 6e).
                  // Another desktop's list is never this server's to import (round 6h).
                  (ownDesktop(computer.id) && nowMs - Date.parse(seenAt) < SOURCES_EXPIRE_MS
                    ? sources
                    : []
                  ).map((source) => ({
                    computer,
                    source,
                    connected: nowMs - Date.parse(seenAt) < SOURCES_FRESH_MS,
                  })),
              );
              // Through the link: only the desktop it was made on, never another's same folder.
              const linkedOn = effectiveProfile(state.profiles, input.profileId).source?.computer;
              const linkedHere = (entry: (typeof reported)[number]) =>
                entry.source.linkedTo === input.profileId &&
                (linkedOn === undefined || entry.computer.id === linkedOn.id);
              const sourced =
                input.kind !== "refresh"
                  ? undefined
                  : input.sourceId !== undefined
                    ? reported.find(
                        ({ computer, source }) => sourceIdOf(computer, source) === input.sourceId,
                      )
                    : (reported.find((entry) => entry.connected && linkedHere(entry)) ??
                      reported.find(linkedHere));
              if (input.sourceId !== undefined && !sourced)
                return yield* fail("not-found", "No such browser profile: list the sources again.");
              // Into a new profile unless an existing one is named; it is named after the source.
              const made =
                input.sourceId !== undefined &&
                !isBuiltInBrowserProfileId(input.profileId) &&
                !state.profiles.some(({ profileId }) => profileId === input.profileId);
              // The profile the source's sign-ins are in already, if any: what they reach now.
              // One browser profile links to one Scient profile (round 6h): its own, or one an
              // import is bringing it to. An import from it elsewhere is refused; a refresh of
              // that profile brings its sign-ins.
              const sameSource = (link: BrowserProfileSource | undefined) =>
                sourced !== undefined &&
                link !== undefined &&
                linksBrowserProfile(link, {
                  ...sourced.source,
                  computerId: sourced.computer.id,
                });
              const linkedElsewhere = sourced
                ? (state.profiles.find(
                    (profile) =>
                      profile.profileId !== input.profileId &&
                      !profile.removed &&
                      !profile.retired &&
                      // As this server reads the link, or as the desktop's own report resolved it.
                      (sameSource(profile.source) || profile.profileId === sourced.source.linkedTo),
                  ) ??
                  (state.profileOperations ?? [])
                    .filter(
                      (operation) =>
                        operation.kind === "refresh" &&
                        operation.profileId !== input.profileId &&
                        !operation.linked &&
                        !operation.undone &&
                        stillPending(operation) &&
                        sameSource(operation.link),
                    )
                    .map((operation) => effectiveProfile(state.profiles, operation.profileId))[0])
                : undefined;
              const record: BrowserProfileRecord =
                made && sourced
                  ? {
                      ...defaultBrowserProfileRecord(input.profileId),
                      name: sourceName(sourced.source),
                    }
                  : effectiveProfile(state.profiles, input.profileId);
              if (record.removed || record.retired) return yield* missing();
              if (by && (record.access === "off" || !inScope(record.scope, by.projectId)))
                return yield* fail(
                  "denied",
                  "This profile is off for agents; the user manages it.",
                );
              if (version !== undefined && profileVersion(record) !== version)
                return yield* fail("conflict", "It changed since it was read. Read it again.");
              const refuse = (
                reason: "open-tabs" | "signing-in" | "not-allowed" | "widens",
                message: string,
                threadIds?: ReadonlyArray<ProfileThreadId>,
              ): ProfileOperateResult => ({
                refused: { reason, message, ...(threadIds?.length ? { threadIds } : {}) },
              });
              if (input.profileId === INCOGNITO_BROWSER_PROFILE_ID)
                return refuse("not-allowed", "A private window keeps nothing to remove.");
              // Its browser never confirmed it closed: nothing moves it to a new generation (6q).
              if (input.kind === "clear" && profileStore?.unavailable?.().includes(input.profileId))
                return refuse(
                  "not-allowed",
                  "This profile is unavailable until the server restarts.",
                );
              const transfer =
                input.kind === "copy" ||
                input.kind === "move" ||
                input.kind === "merge" ||
                input.kind === "fold";
              const retiresSource = input.kind === "merge" || input.kind === "fold";
              if (
                (input.kind === "remove" || retiresSource) &&
                isBuiltInBrowserProfileId(input.profileId)
              )
                return refuse("not-allowed", "Main can't be removed; clear it instead.");
              if (input.kind !== "sign-out" && record.received?.length)
                return refuse(
                  "not-allowed",
                  "This profile comes from another computer; change it there.",
                );
              if (input.kind === "sign-out" && !input.site)
                return yield* fail("invalid-input", "Name the site to sign out of.");
              // Removing it under an open tab would pull the page from a chat: those chats go first.
              if ((input.kind === "remove" || retiresSource) && openIn.length)
                return refuse("open-tabs", "Close its tabs first.", openIn);
              if (input.kind === "refresh" && sourced) {
                // Read on the desktop that holds the browser, and only while it is on.
                if (!sourced.connected)
                  return refuse(
                    "not-allowed",
                    `Its browser is on ${sourced.computer.label}, which isn't connected now.`,
                  );
                // Linked to another profile: its sign-ins are there, under that profile's
                // controls, and only a refresh of it brings them (round 6h).
                if (input.sourceId !== undefined && linkedElsewhere)
                  return refuse(
                    "not-allowed",
                    `Its sign-ins are in ${linkedElsewhere.name ?? "another profile"}: refresh that profile instead.`,
                  );
                if (!input.cookies && !input.passwords)
                  return yield* fail("invalid-input", "Choose sign-ins, passwords or both.");
              } else if (input.kind === "refresh") {
                // Sources are matched by their link only; the browser is read where it is.
                if (!record.source)
                  return refuse(
                    "not-allowed",
                    "It isn't linked to a browser profile: import from one of its sources.",
                  );
                // Bound to another desktop that isn't reporting: never this one's same-named folder.
                if (
                  record.source.computer &&
                  record.source.computer.id !== profileStore?.computer?.id
                )
                  return refuse(
                    "not-allowed",
                    `Its browser is on ${record.source.computer.label}, which isn't connected now.`,
                  );
                if (!profileStore?.desktop)
                  return refuse(
                    "not-allowed",
                    `Its browser is on ${record.received?.map(({ label }) => label).join(", ") || "a desktop"}: refresh it there.`,
                  );
                if (!input.cookies && !input.passwords)
                  return yield* fail("invalid-input", "Choose sign-ins, passwords or both.");
              }
              const intoId = input.kind === "fold" ? DEFAULT_BROWSER_PROFILE_ID : input.into;
              const into = intoId ? effectiveProfile(state.profiles, intoId) : undefined;
              if (transfer) {
                if (!into || intoId === input.profileId)
                  return refuse("not-allowed", "Choose another profile for its sign-ins.");
                if (into.removed || into.retired) return yield* missing();
                // A private window keeps nothing: what went there would be lost when it closes.
                if (intoId === INCOGNITO_BROWSER_PROFILE_ID)
                  return refuse("not-allowed", "A private window keeps nothing; choose another.");
                if (into.received?.length)
                  return refuse("not-allowed", "That profile comes from another computer.");
                if (by && (into.access === "off" || !inScope(into.scope, by.projectId)))
                  return yield* fail(
                    "denied",
                    "That profile is off for agents; the user manages it.",
                  );
                // Checked as both profiles stand now: sign-ins never reach further than they did.
                if (widensInto(record, into))
                  return refuse(
                    "widens",
                    "Its sign-ins would reach further there: narrow that profile first.",
                  );
                if (by && (input.kind === "copy" || input.kind === "move") && !input.sites?.length)
                  return yield* fail("invalid-input", "Name the sites to copy.");
              }
              const signing = [...attempts.values()].filter(
                (attempt) => (attempt.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === input.profileId,
              );
              if (input.kind !== "sign-out" && signing.length)
                return refuse(
                  "signing-in",
                  "A sign-in is under way in it.",
                  signing.map((attempt) => attempt.threadId),
                );
              const atMs = yield* Clock.currentTimeMillis;
              const at = DateTime.formatIso(DateTime.makeUnsafe(atMs));
              const until = DateTime.formatIso(DateTime.makeUnsafe(atMs + UNDO_FOR_MS));
              const base: ProfileOperation = {
                operationId: input.operationId,
                kind: input.kind,
                profileId: input.profileId,
                ...(input.requestKey ? { requestKey: input.requestKey } : {}),
                ...(record.name ? { name: record.name } : {}),
                ...(input.site ? { site: input.site } : {}),
                at,
                until,
                ...(by?.threadId ? { threadId: by.threadId } : {}),
                ...(by?.projectId ? { projectId: by.projectId } : {}),
                // Clear records its own from and to; the rest, the data they were done in.
                ...(input.kind === "clear" || input.kind === "remove"
                  ? {}
                  : { generation: record.generation ?? 0 }),
                ...(transfer && into ? { intoGeneration: into.generation ?? 0 } : {}),
              };
              const pending = { state: "pending" as const };
              let next = state;
              let operation: ProfileOperation;
              if (input.kind === "refresh") {
                // Carried out by the window of the desktop that holds it, as the person's import.
                const computer = sourced?.computer ?? profileStore?.computer;
                operation = {
                  ...base,
                  ...(input.cookies ? { cookies: true } : {}),
                  ...(input.passwords ? { passwords: true } : {}),
                  ...(computer ? { computer } : {}),
                  ...(made ? { madeProfile: true } : {}),
                  // Linked to it once it has succeeded, so a refresh later finds it (round 6d).
                  ...(sourced && input.sourceId !== undefined
                    ? {
                        link: {
                          browser: sourced.source.browser,
                          profileName: sourced.source.name,
                          directory: sourced.source.directory,
                          ...(sourced.source.email ? { email: sourced.source.email } : {}),
                          computer: sourced.computer,
                          importedAt: at,
                        },
                      }
                    : {}),
                  desktop: pending,
                };
                if (made) next = { ...state, profiles: withRecord(record) };
              } else if (transfer) {
                operation = {
                  ...base,
                  into: intoId!,
                  ...(input.sites?.length ? { sites: [...input.sites] } : {}),
                  ...(profileStore ? { server: pending } : {}),
                  ...(profileStore?.desktop ? { desktop: pending } : {}),
                  ...(profileStore?.desktop && profileStore.computer
                    ? { computer: profileStore.computer }
                    : {}),
                };
              } else if (input.kind === "remove") {
                // Hidden everywhere; its data stays as it is until the hour ends.
                operation = { ...base, server: { state: "done" } };
                next = {
                  ...state,
                  profiles: withRecord({
                    ...record,
                    removed: {
                      at,
                      operationId: input.operationId,
                      until,
                      ...(record.name ? { name: record.name } : {}),
                    },
                  }),
                };
              } else if (input.kind === "clear") {
                // New tabs open in a new generation; the old one waits for Undo.
                const from = record.generation ?? 0;
                const to =
                  Math.max(from, ...(record.retained ?? []).map(({ generation }) => generation)) +
                  1;
                operation = { ...base, from, to, ...(profileStore ? { server: pending } : {}) };
                next = {
                  ...state,
                  profiles: withRecord({
                    ...record,
                    generation: to,
                    retained: [...(record.retained ?? []), { generation: from, until }],
                  }),
                };
              } else {
                operation = {
                  ...base,
                  ...(profileStore ? { server: pending } : {}),
                  ...(profileStore?.desktop ? { desktop: pending } : {}),
                  ...(profileStore?.desktop && profileStore.computer
                    ? { computer: profileStore.computer }
                    : {}),
                  // Every other desktop on now that keeps its own jar of the profile: the
                  // person's sign-out only. An agent's changes no desktop whose backend can't
                  // check its grant as it writes (round 6f).
                  ...(!by && otherDesktops(atMs).length
                    ? {
                        others: otherDesktops(atMs).map((computer) => ({
                          computer,
                          outcome: pending,
                        })),
                      }
                    : {}),
                };
                signOutSequence++;
                recentSignOuts = [
                  ...recentSignOuts,
                  { profileId: input.profileId, site: input.site!, sequence: signOutSequence },
                ].slice(-200);
                // Other computers it is sent to delete the site too; Main also keeps it out of
                // every copy and import into Main, as its own sign-out always did.
                const profiles =
                  input.profileId === DEFAULT_BROWSER_PROFILE_ID
                    ? withSignedOutSite(state.profiles, input.site!)
                    : state.profiles;
                const signedOutRecord = effectiveProfile(profiles, input.profileId);
                next = {
                  ...state,
                  profiles: [
                    ...profiles.filter((profile) => profile.profileId !== input.profileId),
                    // An agent's sign-out is this computer's only (round 6h): no delete goes to
                    // the computers it shares with, as no part goes to other desktops.
                    signedOutRecord.retired || by
                      ? signedOutRecord
                      : {
                          ...signedOutRecord,
                          send: issueUnit(signedOutRecord.send, [input.site!], "delete"),
                        },
                  ],
                  signedOut: withSignOut(state.signedOut, input.profileId, input.site!),
                };
              }
              yield* commit({
                ...next,
                profileOperations: keptReceipts(
                  [...(state.profileOperations ?? []), operation],
                  atMs,
                ),
              });
              // The versions it was decided at, as committed: its work is checked against them.
              if (transfer || input.kind === "refresh")
                operation =
                  (yield* recordStore(input.operationId, (current) => ({
                    ...current,
                    fromVersion: profileVersion(effectiveProfile(state.profiles, input.profileId)),
                    ...(input.kind === "refresh" && input.profileId === DEFAULT_BROWSER_PROFILE_ID
                      ? { mainSignOuts: mainSignOuts() }
                      : {}),
                    ...(intoId
                      ? { intoVersion: profileVersion(effectiveProfile(state.profiles, intoId)) }
                      : {}),
                  }))) ?? operation;
              if (by)
                yield* appendChange(
                  {
                    target: { type: "profile", profileId: input.profileId },
                    change: input.kind,
                    ...(input.site ? { detail: input.site } : {}),
                    ...(transfer && intoId ? { detail: `into ${into?.name ?? intoId}` } : {}),
                  },
                  by,
                );
              return { operation, fresh: true as const };
            }),
          );
          const { fresh: _, ...result } = decided;
          const operation = result.operation;
          // A retry of one still pending here, with nothing running it, resumes it.
          if (
            !operation ||
            (!decided.fresh &&
              (operation.undone !== undefined || operation.server?.state !== "pending"))
          )
            return result;
          return { operation: yield* serverDo(operation) };
        },
      ),
      desktopWriteCheck: Effect.fn("AccountsService.desktopWriteCheck")((input) =>
        locked(
          Effect.gen(function* () {
            const operation = operationOf(input.operationId);
            if (!operation) return { ok: false, message: "No such operation." };
            const other = (
              input.phase === "do" ? operation.others : operation.undone?.others
            )?.find(({ computer }) => computer.id === input.computer);
            const part =
              other?.outcome ??
              (input.phase === "do" ? operation.desktop : operation.undone?.desktop);
            if (part?.state !== "pending") return { ok: false, message: "It isn't under way." };
            // Claimed before it began, by some desktop: an unclaimed write is no part's.
            const key = `${input.operationId}:${input.phase}:${other ? `other:${other.computer.id}` : "own"}`;
            if (!claims.has(key)) return { ok: false, message: "No desktop claimed it." };
            const blocked = yield* standsNow(input.operationId, input.phase);
            return blocked ? { ok: false, message: blocked } : { ok: true };
          }),
        ),
      ),
      claimProfileStore: Effect.fn("AccountsService.claimProfileStore")((input) =>
        locked(
          Effect.gen(function* () {
            const operation = operationOf(input.operationId);
            if (!operation) return { ok: false, message: "No such operation." };
            // Another desktop's own part of a sign-out, by its computer.
            const other = (
              input.phase === "do" ? operation.others : operation.undone?.others
            )?.find(({ computer }) => computer.id === input.computer);
            const part =
              other?.outcome ??
              (input.phase === "do" ? operation.desktop : operation.undone?.desktop);
            if (part?.state !== "pending")
              return { ok: false, message: "It isn't waiting for a desktop." };
            if (!other && operation.computer && operation.computer.id !== input.computer)
              return { ok: false, message: `It is for ${operation.computer.label}.` };
            // One desktop carries each part out: the first to ask, which may ask again before it
            // writes. Each other desktop's part of a sign-out is a part of its own (round 6e).
            const key = `${input.operationId}:${input.phase}:${other ? `other:${other.computer.id}` : "own"}`;
            const holder = claims.get(key);
            if (holder !== undefined && holder !== (input.computer ?? ""))
              return { ok: false, message: "Another desktop is carrying it out." };
            const blocked = yield* standsNow(input.operationId, input.phase);
            if (blocked) {
              yield* recordStore(input.operationId, (current) =>
                withDesktopPart(current, input.phase, other ? input.computer : undefined, {
                  state: "failed",
                }),
              );
              if (input.phase === "do" && !other)
                yield* recordStore(input.operationId, (current) => ({
                  ...current,
                  stopped: blocked,
                }));
              return { ok: false, message: blocked };
            }
            claims.set(key, input.computer ?? "");
            return { ok: true };
          }),
        ),
      ),
      undoProfileOperation: Effect.fn("AccountsService.undoProfileOperation")(
        function* (operationId, by) {
          const decided = yield* locked(
            Effect.gen(function* () {
              const operation = operationOf(operationId);
              const atMs = yield* Clock.currentTimeMillis;
              if (!operation || Date.parse(operation.until) <= atMs)
                return yield* fail("not-found", "It can no longer be undone.");
              if (operation.undone) return { operation, fresh: false };
              // An import or refresh copied the person's own browser sign-ins: it has no Undo,
              // and Activity keeps its line (round 6m).
              if (operation.kind === "refresh")
                return yield* fail("unsupported", "An import or refresh can't be undone.");
              const record = effectiveProfile(state.profiles, operation.profileId);
              const into = operation.into
                ? effectiveProfile(state.profiles, operation.into)
                : undefined;
              // An agent undoes only its own chat's change, and only where it may still act.
              if (by) {
                if (!state.agentAccess)
                  return yield* fail("denied", "Agent access to Accounts is off.");
                if (operation.threadId !== by.threadId)
                  return yield* fail(
                    "denied",
                    "Another chat made this change; the user can undo it in Accounts.",
                  );
                if (
                  [record, ...(into ? [into] : [])].some(
                    (profile) => profile.access === "off" || !inScope(profile.scope, by.projectId),
                  )
                )
                  return yield* fail(
                    "denied",
                    "This profile is off for agents; the user manages it.",
                  );
              }
              // Undone only once it has ended: an Undo before the work would be undone by it.
              if (stillPending(operation))
                return yield* fail(
                  "conflict",
                  "It is still being carried out: undo it once it ends.",
                );
              // Cleared since: what it kept belongs to data no longer in use.
              if (
                (operation.generation !== undefined &&
                  (record.generation ?? 0) !== operation.generation) ||
                (into &&
                  operation.intoGeneration !== undefined &&
                  (into.generation ?? 0) !== operation.intoGeneration)
              )
                return yield* fail("conflict", "It was cleared since; it can no longer be undone.");
              const at = DateTime.formatIso(DateTime.makeUnsafe(atMs));
              const pending = { state: "pending" as const };
              let next = state;
              let undone: NonNullable<ProfileOperation["undone"]>;
              if (operation.kind === "remove") {
                if (record.removed?.operationId !== operationId || record.removed.purgedAt)
                  return yield* fail("not-found", "It can no longer be brought back.");
                const { removed: _, ...back } = record;
                next = { ...state, profiles: withRecord(back) };
                undone = { at };
              } else if (operation.kind === "clear") {
                const kept = record.retained?.find(
                  (entry) => entry.generation === operation.from && !entry.purgedAt,
                );
                if (!kept || record.generation !== operation.to)
                  return yield* fail("conflict", "It changed since; it can no longer be undone.");
                // Sign-ins made in the new generation meanwhile stay there, listed for the person.
                const conflicts = state.accounts.flatMap(({ summary }) =>
                  summary.details.kind === "website" &&
                  (summary.details.profileId ?? DEFAULT_BROWSER_PROFILE_ID) ===
                    operation.profileId &&
                  summary.signIn?.by === "action" &&
                  summary.signIn.at > operation.at
                    ? [summary.name]
                    : [],
                );
                const until = DateTime.formatIso(DateTime.makeUnsafe(atMs + UNDO_FOR_MS));
                next = {
                  ...state,
                  profiles: withRecord({
                    ...record,
                    generation: operation.from!,
                    retained: [
                      ...(record.retained ?? []).filter((entry) => entry !== kept),
                      { generation: operation.to!, until },
                    ],
                  }),
                };
                undone = {
                  at,
                  ...(conflicts.length ? { conflicts } : {}),
                  ...(profileStore && operation.server ? { server: pending } : {}),
                };
              } else if (operation.into) {
                // The copies go, the destination's own cookies come back, a merged source returns.
                let profiles = state.profiles;
                if (operation.retiredSource) {
                  if (record.removed?.operationId !== operationId || record.removed.purgedAt)
                    return yield* fail("not-found", "It can no longer be brought back.");
                  const { removed: _, ...back } = record;
                  profiles = withRecord(back);
                }
                // A copy edited since is the person's now: it stays, and is named.
                const versions = new Map(
                  (operation.rowsAdded ?? []).map(
                    (accountId, index) => [accountId, operation.rowsAddedAt?.[index]] as const,
                  ),
                );
                const edited = state.accounts.flatMap(({ summary }) =>
                  versions.has(summary.accountId) &&
                  versions.get(summary.accountId) !== undefined &&
                  versions.get(summary.accountId) !== summary.updatedAt
                    ? [summary]
                    : [],
                );
                const added = new Set<string>(
                  (operation.rowsAdded ?? []).filter(
                    (accountId) => !edited.some((summary) => summary.accountId === accountId),
                  ),
                );
                next = {
                  ...state,
                  profiles,
                  accounts: state.accounts.filter((row) => !added.has(row.summary.accountId)),
                  ...(operation.kind === "move" && operation.sites
                    ? {
                        signedOut: withoutSignOuts(
                          state.signedOut,
                          operation.profileId,
                          operation.sites,
                        ),
                      }
                    : {}),
                };
                const kept =
                  savedCookiesOf(`${operationId}#into`) ?? savedCookiesOf(`${operationId}#from`);
                undone = {
                  at,
                  ...(edited.length ? { conflicts: edited.map(({ name }) => name) } : {}),
                  ...(profileStore && (kept || operation.server?.state === "done")
                    ? { server: pending }
                    : {}),
                  ...(operation.desktop ? { desktop: pending } : {}),
                };
              } else {
                const saved = savedCookiesOf(operationId);
                next = {
                  ...state,
                  // Main takes the site into its copies and imports again.
                  ...(operation.profileId === DEFAULT_BROWSER_PROFILE_ID
                    ? {
                        profiles: withRecord({
                          ...record,
                          main: {
                            ...record.main,
                            signedOutSites: (record.main?.signedOutSites ?? []).filter(
                              (site) => site !== operation.site,
                            ),
                          },
                        }),
                      }
                    : {}),
                  signedOut: withoutSignOuts(state.signedOut, operation.profileId, [
                    operation.site!,
                  ]),
                };
                undone = {
                  at,
                  ...(saved && profileStore ? { server: pending } : {}),
                  ...(operation.desktop ? { desktop: pending } : {}),
                  // Each other desktop that signed its jar out signs it back in.
                  ...(operation.others?.some(({ outcome }) => outcome.state === "done")
                    ? {
                        others: operation.others
                          .filter(({ outcome }) => outcome.state === "done")
                          .map(({ computer }) => ({ computer, outcome: pending })),
                      }
                    : {}),
                };
              }
              const back = { ...operation, undone };
              yield* commit({ ...next, profileOperations: withOperation(back).profileOperations });
              if (by)
                yield* appendChange(
                  {
                    target: { type: "profile", profileId: operation.profileId },
                    change: "restore",
                  },
                  by,
                );
              return { operation: back, fresh: true };
            }),
          );
          const operation = decided.operation;
          // A retry of an Undo still pending here, with nothing running it, resumes it.
          if (!decided.fresh && operation.undone?.server?.state !== "pending") return operation;
          return yield* serverUndo(operation);
        },
      ),
      profileStoreDone: Effect.fn("AccountsService.profileStoreDone")((input) =>
        locked(
          Effect.gen(function* () {
            const operation = operationOf(input.operationId);
            if (!operation) return yield* missing();
            // An import by source links the profile once it has succeeded, never before.
            const record = effectiveProfile(state.profiles, operation.profileId);
            const link =
              input.phase === "do" &&
              input.outcome.state === "done" &&
              operation.kind === "refresh" &&
              !operation.linked &&
              !operation.undone &&
              !record.removed &&
              !record.retired
                ? operation.link
                : undefined;
            yield* recordStore(
              input.operationId,
              (current) => {
                const updated = withDesktopPart(
                  current,
                  input.phase,
                  input.computer,
                  input.outcome,
                );
                return link ? { ...updated, linked: true } : updated;
              },
              link
                ? {
                    profiles: soleLink(
                      withRecord({ ...record, source: link }),
                      record.profileId,
                      link,
                    ),
                    sourceProfiles: relink(operation.profileId, link),
                  }
                : undefined,
            );
            // A merge waits for the desktop's part before its source goes.
            if (input.phase === "do") yield* settleTransfer(input.operationId);
          }),
        ),
      ),
      purgeProfiles: Effect.gen(function* () {
        // Nothing to purge on a server whose Accounts nobody has opened.
        if (!initialized) return;
        yield* locked(
          Effect.gen(function* () {
            const atMs = yield* Clock.currentTimeMillis;
            const at = DateTime.formatIso(DateTime.makeUnsafe(atMs));
            const passed = (until: string) => Date.parse(until) <= atMs;
            const work: Array<{
              readonly profileId: BrowserProfileId;
              readonly generation?: number;
            }> = [];
            const removedIds = new Set<string>();
            const profiles = state.profiles.map((record) => {
              if (record.removed && !record.removed.purgedAt && passed(record.removed.until)) {
                work.push({ profileId: record.profileId });
                removedIds.add(record.profileId);
                // Kept as a tombstone: nothing named after it is used again.
                return { ...record, removed: { ...record.removed, purgedAt: at } };
              }
              const leftBehind = (record.retained ?? []).filter(
                (entry) => !entry.purgedAt && passed(entry.until),
              );
              if (!leftBehind.length) return record;
              for (const entry of leftBehind)
                work.push({ profileId: record.profileId, generation: entry.generation });
              return {
                ...record,
                retained: (record.retained ?? []).map((entry) =>
                  leftBehind.includes(entry) ? { ...entry, purgedAt: at } : entry,
                ),
              };
            });
            const expiredSaves = (state.signOutSaves ?? []).filter(({ operationId }) => {
              const operation = operationOf(operationId.split("#")[0]!);
              return !operation || !live(operation, atMs);
            });
            if (!work.length && !expiredSaves.length) return work;
            let accounts = state.accounts;
            let profileChoices = state.profileChoices;
            for (const profileId of removedIds) {
              accounts = withoutProfileSignIns(accounts, profileId);
              if (profileChoices) profileChoices = withoutProfile(profileChoices, profileId);
            }
            yield* commit({
              ...state,
              accounts,
              profiles,
              ...(profileChoices ? { profileChoices } : {}),
              signOutSaves: (state.signOutSaves ?? []).filter(
                (entry) => !expiredSaves.includes(entry),
              ),
              // Authorized now, in the same commit: deleted below, and retried until it is.
              ...(work.length ? { pendingPurges: [...(state.pendingPurges ?? []), ...work] } : {}),
            });
            return work;
          }),
        );
        const store = profileStore;
        if (!store) return;
        // Each one authorized is deleted here, and kept on the list until it is: a failed one is
        // tried again on the next pass, after a restart too.
        for (const job of state.pendingPurges ?? []) {
          const purged = yield* store.purge(job.profileId, job.generation).pipe(Effect.result);
          // From the state as it is once the permit is held (round 6j).
          yield* locked(
            Effect.suspend(() =>
              commit(
                {
                  ...state,
                  pendingPurges: [
                    ...(state.pendingPurges ?? []).filter(
                      (entry) =>
                        entry.profileId !== job.profileId || entry.generation !== job.generation,
                    ),
                    ...(purged._tag === "Success" ? [] : [job]),
                  ],
                },
                true,
              ),
            ),
          );
        }
      }).pipe(Effect.ignore),
      browserSources: Effect.gen(function* () {
        const atMs = yield* Clock.currentTimeMillis;
        return (state.sourceProfiles ?? []).flatMap(({ computer, seenAt, sources }) =>
          (ownDesktop(computer.id) && atMs - Date.parse(seenAt) < SOURCES_EXPIRE_MS
            ? sources
            : []
          ).map((source) => ({
            sourceId: sourceIdOf(computer, source),
            computer,
            // A desktop reports every few minutes while it is on.
            connected: atMs - Date.parse(seenAt) < SOURCES_FRESH_MS,
            source,
          })),
        );
      }),
      reportProfiles: Effect.fn("AccountsService.reportProfiles")((reported, desktop) =>
        locked(
          Effect.gen(function* () {
            if (desktop) {
              const seenAt = yield* now;
              yield* commit(
                {
                  ...state,
                  sourceProfiles: [
                    ...(state.sourceProfiles ?? []).filter(
                      ({ computer }) => computer.id !== desktop.computer.id,
                    ),
                    {
                      computer: desktop.computer,
                      seenAt,
                      // Round 6f: an import reads only browsers on this server's own desktop.
                      // Another desktop is heard as on (its own jars sign out), its list kept
                      // nowhere: no other computer's browser is imported here.
                      sources:
                        profileStore?.desktop && profileStore.computer?.id === desktop.computer.id
                          ? [...desktop.sources]
                          : [],
                    },
                  ],
                },
                true,
              );
            }
            let profiles = state.profiles;
            for (const { profileId, name } of reported) {
              if (isBuiltInBrowserProfileId(profileId)) continue;
              const record = profiles.find((profile) => profile.profileId === profileId);
              if (record?.retired || record?.name === name) continue;
              profiles = [
                ...profiles.filter((profile) => profile.profileId !== profileId),
                { ...(record ?? defaultBrowserProfileRecord(profileId)), name },
              ];
            }
            if (profiles !== state.profiles) yield* commit({ ...state, profiles }, true);
          }),
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
          ).pipe(
            // Kept apart from the delivery log, which drops a delete once others applied it.
            Effect.tap(() => signOutRecorded(profileId, site)),
          ),
        ),
      ),
      rememberSignOut: Effect.fn("AccountsService.rememberSignOut")((profileId, site) =>
        locked(Effect.suspend(() => signOutRecorded(profileId, site))),
      ),
      signedOut: Effect.sync(() => state.signedOut ?? []),
      signOutSequence: Effect.sync(() => signOutSequence),
      signOutsSince: Effect.fn("AccountsService.signOutsSince")((sequence) =>
        Effect.sync(() => recentSignOuts.filter((entry) => entry.sequence > sequence)),
      ),
      unlessSignedOutSince: Effect.fn("AccountsService.unlessSignedOutSince")(
        <E>(
          account: Pick<AccountSummary, "details">,
          sequence: number,
          publish: Effect.Effect<void, E>,
          authorized?: {
            readonly scope: AccountUseScope;
            readonly target: AccountTarget;
            readonly use?: Parameters<AccountsServiceShape["authorizeUse"]>[2];
          },
        ) =>
          locked(
            Effect.gen(function* () {
              if (authorized !== undefined)
                yield* useRefusal(authorized.scope, authorized.target, authorized.use);
              const mainSites =
                effectiveProfile(state.profiles, DEFAULT_BROWSER_PROFILE_ID).main?.signedOutSites ??
                [];
              const records = [
                ...(state.signedOut ?? []),
                ...mainSites.map((site) => ({ profileId: DEFAULT_BROWSER_PROFILE_ID, site })),
                ...recentSignOuts.filter((entry) => entry.sequence > sequence),
              ];
              if (signedOutOfSite(account, records)) return false;
              yield* publish;
              return true;
            }),
          ),
      ),
      renewedAt: Effect.sync(() => state.renewedAt ?? {}),
      renewed: Effect.fn("AccountsService.renewed")((accountId, at) =>
        locked(
          Effect.gen(function* () {
            // Removed rows drop out, so the record only ever holds today's rows.
            const live = Object.entries(state.renewedAt ?? {}).filter(([id]) =>
              state.accounts.some(({ summary }) => summary.accountId === id),
            );
            yield* commit(
              { ...state, renewedAt: Object.fromEntries([...live, [accountId, at]]) },
              true,
            );
          }),
        ),
      ),
      // Read after the saved state is loaded: a turn may ask before anything else has.
      signInFactors: locked(
        Effect.sync(() => {
          // An older build's `false` proves no code only where no saved key could have hidden one.
          const older = Object.entries(state.signInCodes ?? {}).flatMap(
            ([id, asked]): Array<readonly [string, SignInFactor]> =>
              asked
                ? [[id, "code"]]
                : findAccount(AccountId.make(id))?.summary.secrets.totp === undefined
                  ? [[id, "none"]]
                  : [],
          );
          return { ...Object.fromEntries(older), ...state.signInFactors };
        }),
      ).pipe(Effect.orElseSucceed(() => ({}))),
      deferredRenewals: locked(Effect.sync(() => state.deferredRenewals ?? [])).pipe(
        Effect.orElseSucceed(() => []),
      ),
      setRenewalDeferred: Effect.fn("AccountsService.setRenewalDeferred")((accountId, deferred) =>
        locked(
          Effect.gen(function* () {
            const kept = (state.deferredRenewals ?? []).filter(
              (id) =>
                id !== accountId && state.accounts.some(({ summary }) => summary.accountId === id),
            );
            const next = deferred ? [...kept, accountId] : kept;
            if (
              next.length === (state.deferredRenewals ?? []).length &&
              deferred === (state.deferredRenewals ?? []).includes(accountId)
            )
              return;
            yield* commit({ ...state, deferredRenewals: next }, true);
          }),
        ).pipe(Effect.ignore),
      ),
      noteSignInFactor: Effect.fn("AccountsService.noteSignInFactor")((accountId, factor) =>
        locked(
          Effect.gen(function* () {
            if (
              state.signInFactors?.[accountId] === factor &&
              !(accountId in (state.signInCodes ?? {}))
            )
              return;
            const live = <V>(record: Readonly<Record<string, V>> | undefined) =>
              Object.entries(record ?? {}).filter(
                ([id]) =>
                  id !== accountId &&
                  state.accounts.some(({ summary }) => summary.accountId === id),
              );
            const { signInCodes: _older, ...rest } = state;
            const older = live(state.signInCodes);
            yield* commit(
              {
                ...rest,
                ...(older.length > 0 ? { signInCodes: Object.fromEntries(older) } : {}),
                signInFactors: Object.fromEntries([
                  ...live(state.signInFactors),
                  [accountId, factor],
                ]),
              },
              true,
            );
          }),
        ).pipe(Effect.ignore),
      ),
      taskPins: locked(Effect.sync(() => readTaskPins(state.taskPins).pins)).pipe(
        Effect.orElseSucceed(() => []),
      ),
      unreadableTaskPins: locked(
        Effect.sync(() =>
          readTaskPins(state.taskPins).unreadable.map((pin) => pin.scheduledTaskId),
        ),
      ).pipe(Effect.orElseSucceed(() => [])),
      withTaskEdit,
      addCodeNotice: Effect.fn("AccountsService.addCodeNotice")((notice) =>
        locked(
          Effect.gen(function* () {
            const at = yield* now;
            const noticeId = NodeCrypto.randomUUID();
            // Pruned here, on the next addition, once past a day (after the phone's own expiry).
            const dayAgo = Date.parse(at) - 24 * 60 * 60 * 1000;
            const kept = (state.codeNotices ?? []).filter(
              (entry) => Date.parse(entry.at) >= dayAgo,
            );
            yield* commit({
              ...state,
              // Never a count limit: a notice, cleared or not, goes once past a day.
              codeNotices: [...kept, { noticeId, ...notice, at }],
            });
            return noticeId;
          }),
        ),
      ),
      codeNoticeDelivered: Effect.fn("AccountsService.codeNoticeDelivered")((noticeId, current) =>
        changeNotice(
          noticeId,
          (entry) => (entry.delivered ? entry : { ...entry, delivered: true }),
          current,
        ),
      ),
      settleCodeNotice: Effect.fn("AccountsService.settleCodeNotice")((noticeId, settled) =>
        Effect.flatMap(now, (settledAt) =>
          changeNotice(noticeId, (entry) =>
            entry.settled ? entry : { ...entry, settled, settledAt },
          ),
        ).pipe(Effect.ignore),
      ),
      codeNoticeCleared: Effect.fn("AccountsService.codeNoticeCleared")((noticeId, row, current) =>
        Effect.flatMap(now, (at) =>
          locked(
            Effect.suspend(() => {
              // Asked inside the write: an acknowledgement from a relay link since replaced is none.
              if (current?.() === false) return Effect.void;
              const entries = state.codeNotices ?? [];
              const entry = entries.find((notice) => notice.noticeId === noticeId);
              if (entry === undefined || entry.cleared?.includes(row)) return Effect.void;
              const cleared = [...(entry.cleared ?? []), row];
              // Its tombstones are kept through their expiry: the notice is never deleted on a
              // clear, so no link change, mid-write or not, can lose it before its rows are off
              // every link. It goes once past a day, pruned on the next write.
              const dayAgo = Date.parse(at) - 24 * 60 * 60 * 1000;
              return commit(
                {
                  ...state,
                  codeNotices: entries
                    .filter((notice) => notice === entry || Date.parse(notice.at) >= dayAgo)
                    .map((notice) => (notice === entry ? { ...notice, cleared } : notice)),
                },
                true,
              );
            }),
          ),
        ),
      ),
      taskPinOf: Effect.fn("AccountsService.taskPinOf")(function* (scheduledTaskId) {
        // Nothing saved pins nothing.
        if (!initialized && !(yield* persistence.exists("accounts-state"))) return undefined;
        return yield* locked(Effect.sync(() => taskPinIn(state.taskPins, scheduledTaskId)));
      }),
      updateTaskPin: Effect.fn("AccountsService.updateTaskPin")((scheduledTaskId, update) =>
        locked(
          Effect.gen(function* () {
            const read = readTaskPins(state.taskPins);
            const current = read.pins.find((pin) => pin.scheduledTaskId === scheduledTaskId);
            const unreadable = read.unreadable.some(
              (pin) => pin.scheduledTaskId === scheduledTaskId,
            );
            const next = update(current);
            if (next === current && !(unreadable && next !== undefined)) return;
            // Every other stored entry stays as it is, an unreadable one included.
            const others = (state.taskPins ?? []).filter(
              (entry) =>
                !(
                  typeof entry === "object" &&
                  entry !== null &&
                  (entry as { scheduledTaskId?: unknown }).scheduledTaskId === scheduledTaskId
                ),
            );
            yield* commit(
              { ...state, taskPins: next === undefined ? others : [...others, next] },
              true,
            );
          }),
        ),
      ),
      mainWithdrawn: Effect.fn("AccountsService.mainWithdrawn")((sites) =>
        locked(
          issue(DEFAULT_BROWSER_PROFILE_ID, (log) =>
            issueUnit(log, sites, "delete", { copyOnly: true }),
          ),
        ),
      ),
      profileResend: Effect.fn("AccountsService.profileResend")((profileId, operationId) =>
        locked(
          Effect.gen(function* () {
            // An agent's refresh is sent only while it still stands, under the permit (6k).
            if (operationId !== undefined) {
              const operation = operationOf(operationId);
              const blocked =
                operation?.profileId === profileId
                  ? yield* standsNow(operationId, "do")
                  : "It isn't this profile's refresh.";
              if (blocked) return yield* fail("conflict", blocked);
            }
            return yield* issue(profileId, issueJar);
          }),
        ),
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
                if (
                  !row &&
                  how === "imported" &&
                  (state.removedLogins ?? []).some((marker) =>
                    removedHere(marker, { kind: "website", sites: [site] }, input.profileId),
                  )
                )
                  continue;
                if (row) {
                  if (how === "imported") continue;
                  // A sign-in the person made in their browser ends their sign-out there.
                  const signedOut = withoutSignOuts(state.signedOut, input.profileId, [site]);
                  yield* commit({
                    ...replaceAccount({
                      ...row,
                      summary: withSignIn(
                        row.summary,
                        { state: "signed-in", at },
                        yield* Clock.currentTimeMillis,
                        "attempt",
                      ),
                    }),
                    ...(signedOut === undefined ? {} : { signedOut }),
                  });
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
      keepTyped: Effect.fn("AccountsService.keepTyped")((accountId, typed) => {
        const later: { finish?: Effect.Effect<AccountSaveResult, AccountsError> } = {};
        return locked(
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
            const before = loginPasswords(accountId);
            yield* save(
              {
                accountId,
                name: summary.name,
                details:
                  details.kind === "website" && details.username === undefined && typed.username
                    ? { ...details, username: typed.username }
                    : details,
                secrets: { password: { type: "scient", value: Redacted.value(typed.password) } },
              },
              undefined,
              undefined,
              later,
            );
            yield* updateCopies(accountId, {
              password: { type: "scient", value: Redacted.value(typed.password) },
            });
            // The person is told, with Undo, as when they signed in themselves.
            yield* rememberPasswordUpdate(accountId, before);
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
        ).pipe(
          // Its copies to the Keychain or 1Password, once the permit is free.
          Effect.tap(() => later.finish ?? Effect.void),
        );
      }),
      keepFound,
      takeBackupCode: Effect.fn("AccountsService.takeBackupCode")((accountId) => {
        const later: SaveLater = {};
        return locked(
          Effect.gen(function* () {
            const row = findAccount(accountId);
            if (row?.summary.details.kind !== "website" || row.values["recovery"] === undefined)
              return undefined;
            // Kept as it was saved: one per line, or (an older or typed list) split at spaces.
            const lines = row.summary.secrets["recovery"]?.lines === true;
            const [next, ...rest] = backupCodeList(
              Redacted.value(yield* readValue(row.values["recovery"])),
              lines,
            );
            if (next === undefined) return undefined;
            // Used before it leaves the list: a later capture of the same page can't restore it.
            yield* commit(
              replaceAccount({
                ...row,
                usedCodes: [...(row.usedCodes ?? []), usedCodeDigest(accountId, next)].slice(
                  -USED_CODES_KEPT,
                ),
              }),
              true,
            );
            yield* save(
              {
                accountId,
                name: row.summary.name,
                details: row.summary.details,
                secrets: {
                  recovery: rest.length
                    ? lines
                      ? { type: "scient", value: backupCodesValue(rest), lines: true }
                      : { type: "scient", value: rest.join(" ") }
                    : { type: "clear" },
                },
              },
              undefined,
              undefined,
              later,
            );
            return Redacted.make(next);
          }),
        ).pipe(Effect.tap(() => later.finish ?? Effect.void));
      }),
      holdPending: Effect.fn("AccountsService.holdPending")((input) =>
        locked(holdPendingNow(input)),
      ),
      pending: Effect.fn("AccountsService.pending")(function* (input) {
        if (input.type === "reserve") {
          const origin = URL.parse(input.origin)?.origin;
          if (!origin?.startsWith("https://"))
            return yield* fail("invalid-input", "A new password needs its site.");
          // Held before it is filled: its login's password as it is now, and room for it.
          const pendingId = yield* locked(
            holdPendingNow({
              kind: "password",
              value: Redacted.make(input.password),
              origin,
              settling: true,
              settleFor: RESERVE_FOR_MS,
              ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
              // Without its login yet, a new login for the site, should the person keep it as is.
              ...(input.accountId
                ? { accountId: input.accountId }
                : {
                    login: {
                      name: (URL.parse(origin)?.hostname ?? origin).slice(0, 80),
                      details: {
                        kind: "website" as const,
                        sites: [origin],
                        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
                      },
                    },
                  }),
            }),
          );
          return { pendingId };
        }
        if (input.type === "rotate") {
          const origin = URL.parse(input.origin)?.origin;
          if (!origin?.startsWith("https://") || (!input.accountId && !input.login))
            return yield* fail("invalid-input", "A new password needs its site and login.");
          const sent = {
            ...(input.username ? { label: input.username } : {}),
            ...(input.accountId ? { accountId: input.accountId } : {}),
            ...(input.login ? { login: input.login } : {}),
          };
          const reserved = input.pendingId;
          const pendingId = yield* locked(
            reserved
              ? sentPendingNow(reserved, { password: input.password, ...sent })
              : holdPendingNow({
                  kind: "password",
                  value: Redacted.make(input.password),
                  origin,
                  settling: true,
                  ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
                  ...sent,
                }),
          );
          return { pendingId };
        }
        const held = pendingOf(input.pendingId);
        if (!held) return yield* fail("not-found", "It was already settled.");
        if (input.type === "code") {
          if (held.kind !== "totp") return yield* fail("invalid-input", "It holds no 2FA key.");
          const totp = parseTotp(Redacted.value(yield* locked(readValue(held.valueRef))));
          return {
            pendingId: held.pendingId,
            code: totp.generate({ timestamp: yield* Clock.currentTimeMillis }),
            period: totp.period,
          };
        }
        settling.delete(held.pendingId);
        if (input.type === "discard") {
          yield* locked(dropPending(held.pendingId));
          return {};
        }
        if (input.type === "settle") {
          if (held.kind !== "password")
            return yield* fail("invalid-input", "Only a new password is settled by its site.");
          if (input.outcome === "unclear") {
            yield* locked(markPending(held.pendingId, { unclear: true }));
            return { pendingId: held.pendingId };
          }
          return yield* savePending(held.pendingId, {});
        }
        return yield* savePending(held.pendingId, {
          person: true,
          ...(input.accountId ? { accountId: input.accountId } : {}),
          ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
          ...(input.replace ? { replace: true } : {}),
        });
      }),
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
                if (
                  !rows().some((account) => address(account) === email) &&
                  !(state.removedLogins ?? []).some((marker) =>
                    removedHere(
                      marker,
                      { kind: "website", sites: [GOOGLE_SITE], username: email },
                      input.profileId,
                    ),
                  )
                )
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
                // Absent or not valid once may be a bad answer: for a row not already signed out
                // it stands only when a second answer, a minute or more later, says the same.
                const rowId = account.summary.accountId;
                if (seen === "signed-in") googleOutSince.delete(rowId);
                else if (last?.state !== "signed-out") {
                  const first = googleOutSince.get(rowId);
                  if (first === undefined || nowMs - first < GOOGLE_OUT_CONFIRM_MS) {
                    if (first === undefined) googleOutSince.set(rowId, nowMs);
                    continue;
                  }
                  googleOutSince.delete(rowId);
                }
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
                // A receipt of each change, metadata only, so a later look can follow transitions.
                if (last?.state !== seen)
                  yield* Effect.logInfo("Accounts: Google session state changed", {
                    accountId: account.summary.accountId,
                    profileId: input.profileId,
                    from: last?.state ?? "none",
                    to: seen,
                    listed: input.sessions.length,
                    valid: input.sessions.filter((session) => session.valid).length,
                  });
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
      takeFallback: Effect.fn("AccountsService.takeFallback")((key) =>
        locked(
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            const fresh = Object.entries(state.fallbacks ?? {}).filter(
              ([, when]) => at - Date.parse(when) < FALLBACK_GAP_MS,
            );
            if (fresh.some(([taken]) => taken === key)) return false;
            yield* commit(
              { ...state, fallbacks: Object.fromEntries([...fresh, [key, yield* now]]) },
              true,
            );
            return true;
          }),
        ).pipe(Effect.orElseSucceed(() => false)),
      ),
      passwordVersion: Effect.fn("AccountsService.passwordVersion")((accountId) =>
        locked(Effect.sync(() => findAccount(accountId)?.values["password"])).pipe(
          Effect.orElseSucceed(() => undefined),
        ),
      ),
      peek: Effect.fn("AccountsService.peek")((scope, target) =>
        locked(
          Effect.sync(() => {
            const controls = targetControls(target);
            return controls
              ? authorizationDecision(
                  state.agentAccess,
                  controls,
                  scope,
                  conversationGrants.has(grantKey(scope.threadId, target)),
                )
              : ({ decision: "denied", reason: "off" } as const);
          }),
        ).pipe(Effect.orElseSucceed(() => ({ decision: "denied", reason: "off" }) as const)),
      ),
      startCard: Effect.fn("AccountsService.startCard")(function* (requestId) {
        settlingCards.add(requestId);
        yield* publish(false);
      }),
      recordCard: Effect.fn("AccountsService.recordCard")((requestId, outcome, accountId) =>
        locked(
          Effect.suspend(() => {
            settlingCards.delete(requestId);
            const { [requestId]: _, ...rest } = state.cards ?? {};
            const cards = Object.fromEntries(
              Object.entries({ ...rest, [requestId]: outcome }).slice(-CARDS_KEPT),
            );
            const cardAccounts = Object.fromEntries(
              Object.entries({
                ...state.cardAccounts,
                ...(accountId === undefined ? {} : { [requestId]: accountId }),
              }).filter(([id]) => id in cards && (id !== requestId || accountId !== undefined)),
            );
            return commit({ ...state, cards, cardAccounts }, true);
          }),
        ).pipe(Effect.ignore),
      ),
      neverAsk: Effect.fn("AccountsService.neverAsk")(({ add, remove }) =>
        locked(
          Effect.suspend(() => {
            // Only https origins, as the save offer reads them; the newest 500 are kept.
            const origins = (add ?? []).flatMap((site) =>
              URL.canParse(site) && new URL(site).protocol === "https:"
                ? [new URL(site).origin]
                : [],
            );
            const neverAsk = [...new Set([...(state.neverAsk ?? []), ...origins])]
              .filter((site) => site !== remove)
              .slice(-500);
            return commit({ ...state, neverAsk }, true);
          }),
        ),
      ),
      codeSourcesOn: Effect.sync(
        () => sources.codesHost !== undefined && state.codeSources?.messages !== false,
      ),
      codeSourcesVersion: Effect.sync(() => codeSourcesVersion),
      undoPasswordUpdate: Effect.fn("AccountsService.undoPasswordUpdate")(function* (undoId) {
        const { result, mirrors } = yield* locked(
          Effect.gen(function* () {
            const entry = passwordUndos.get(undoId);
            if (!entry || entry.until <= (yield* Clock.currentTimeMillis))
              return yield* fail("not-found", "It can no longer be undone.");
            passwordUndos.delete(undoId);
            let restored = 0;
            let changed = 0;
            const mirrors: Array<{ readonly name: string; readonly later: SaveLater }> = [];
            if (entry.field !== undefined) {
              const field = entry.field;
              for (const kept of entry.rows) {
                const row = findAccount(kept.accountId);
                if (row?.values[field] !== kept.afterRef) {
                  changed++;
                  continue;
                }
                // A login made for the key goes, if it is still just that; any other (or one
                // given more since) gets back what it held, or nothing.
                const untouched =
                  kept.created &&
                  row.summary.updatedAt === kept.createdUpdatedAt &&
                  Object.keys(row.values).every((name) => name === field);
                if (untouched) yield* removeNow(kept.accountId, undefined, undefined);
                else {
                  const later: SaveLater = {};
                  yield* save(
                    {
                      accountId: row.summary.accountId,
                      name: row.summary.name,
                      details: row.summary.details,
                      secrets: {
                        [field]:
                          kept.before === undefined
                            ? { type: "clear" }
                            : Redacted.isRedacted(kept.before)
                              ? {
                                  type: "scient",
                                  value: Redacted.value(kept.before),
                                  ...(kept.beforeLines ? { lines: true as const } : {}),
                                }
                              : kept.before,
                      },
                    },
                    undefined,
                    undefined,
                    later,
                  );
                  mirrors.push({ name: row.summary.name, later });
                }
                restored++;
              }
              yield* publish(false);
              return { result: { restored, changed }, mirrors };
            }
            // Back at the write an older receipt made (`beforeRevision`): that one applies again.
            const reopen = (copy: (typeof entry.copies)[number]) => {
              const now = findAccount(copy.accountId)?.revisions?.["password"];
              if (now === undefined || copy.beforeRef === undefined) return;
              for (const [id, other] of passwordUndos) {
                if (other.field !== undefined) continue;
                const copies = other.copies.map((earlier) =>
                  earlier.accountId === copy.accountId &&
                  earlier.afterRef === copy.beforeRef &&
                  earlier.afterRevision === copy.beforeRevision
                    ? { ...earlier, afterRevision: now }
                    : earlier,
                );
                if (copies.some((earlier, index) => earlier !== other.copies[index]))
                  passwordUndos.set(id, { ...other, copies });
              }
            };
            for (const copy of entry.copies) {
              const row = findAccount(copy.accountId);
              // Written since (any save of the field counts, the same value again too), now another
              // login, or its earlier password removed by the person since: it keeps what it has.
              const kept = (ref: string) =>
                historyOf(copy.accountId).some((version) => version.ref === ref);
              if (
                row?.values["password"] !== copy.afterRef ||
                copy.afterRevision === undefined ||
                (row.revisions?.["password"] ?? 0) !== copy.afterRevision ||
                copy.identity !== identityOf(row.summary) ||
                (copy.beforeRef !== undefined && !kept(copy.beforeRef))
              ) {
                changed++;
                continue;
              }
              // A row whose password was a link (the Keychain, 1Password) gets the link back; one
              // that had none gets none again.
              if (copy.beforeRef === undefined || copy.beforeSecret === undefined) {
                const link = copy.beforeSecret?.source;
                const later: SaveLater = {};
                yield* save(
                  {
                    accountId: row.summary.accountId,
                    name: row.summary.name,
                    details: row.summary.details,
                    secrets: {
                      password:
                        link && link.type !== "scient"
                          ? (link as AccountSecretInput)
                          : { type: "clear" },
                    },
                  },
                  undefined,
                  undefined,
                  later,
                );
                mirrors.push({ name: row.summary.name, later });
                restored++;
                continue;
              }
              // A copy also kept in the Keychain or 1Password takes the earlier one there too,
              // written once the permit is free; its row keeps how that password last did.
              if (row.summary.secrets["password"]?.copies?.length) {
                const value = yield* readValue(copy.beforeRef);
                const later: SaveLater = {};
                yield* save(
                  {
                    accountId: row.summary.accountId,
                    name: row.summary.name,
                    details: row.summary.details,
                    secrets: { password: { type: "scient", value: Redacted.value(value) } },
                  },
                  undefined,
                  undefined,
                  later,
                  copy.beforeRef,
                );
                const saved = findAccount(copy.accountId)!;
                const { verifiedAt, changedAt, refusedAt } = copy.beforeSecret;
                yield* commit(
                  replaceAccount({
                    ...saved,
                    summary: {
                      ...saved.summary,
                      secrets: {
                        ...saved.summary.secrets,
                        password: {
                          ...saved.summary.secrets["password"]!,
                          ...(verifiedAt ? { verifiedAt } : {}),
                          ...(changedAt ? { changedAt } : {}),
                          ...(refusedAt ? { refusedAt } : {}),
                        },
                      },
                    },
                  }),
                );
                mirrors.push({ name: row.summary.name, later });
                reopen(copy);
                restored++;
                continue;
              }
              yield* commit(
                replaceAccount({
                  ...row,
                  values: { ...row.values, password: copy.beforeRef },
                  previous: { password: copy.afterRef },
                  summary: {
                    ...row.summary,
                    secrets: { ...row.summary.secrets, password: copy.beforeSecret },
                  },
                }),
              );
              cache.delete(copy.accountId);
              reopen(copy);
              restored++;
            }
            // Consumed: what only it held is journaled by that write.
            yield* keepReceipts();
            return { result: { restored, changed }, mirrors };
          }),
        );
        const mirrorsLeft: string[] = [];
        for (const { name, later } of mirrors) {
          const finished = later.finish ? yield* Effect.result(later.finish) : undefined;
          if (finished?._tag === "Failure" || finished?.success.warnings?.length)
            mirrorsLeft.push(name);
        }
        return mirrorsLeft.length ? { ...result, mirrorsLeft } : result;
      }),
      checkCodeSources: Effect.gen(function* () {
        if (sources.codesHost === undefined)
          return yield* fail("unavailable", "Sign-in codes come from a Mac's Messages and Mail.");
        const readable = yield* codeSourcesReadable();
        // Every client's row reads the answer just written.
        yield* publish(false);
        return readable;
      }),
      setCodeSources: Effect.fn("AccountsService.setCodeSources")((codeSources) =>
        locked(
          Effect.suspend(() => {
            // Only a Mac has Messages and Mail to read: elsewhere nothing is set, nothing starts.
            if (sources.codesHost === undefined)
              return fail("unavailable", "Sign-in codes come from a Mac's Messages and Mail.");
            // The same switch again (the row's re-check) changes nothing, and stops no code wait.
            if ((state.codeSources?.messages ?? true) === codeSources.messages) return Effect.void;
            codeSourcesVersion++;
            return commit({ ...state, codeSources }, true);
          }),
        ),
      ),
      onAccessTaken: Effect.fn("AccountsService.onAccessTaken")((hook) =>
        Effect.sync(() => {
          takeAccess = hook;
        }),
      ),
      setKeyLink: Effect.fn("AccountsService.setKeyLink")((target, accountId, copies, expected) =>
        locked(
          Effect.suspend(() => {
            // Ownership is recorded only on the link it was read for: a later link wins.
            if (
              expected !== undefined &&
              !(state.keyLinks ?? []).some(
                (link) =>
                  link.instanceId === target.instanceId &&
                  link.variable === target.variable &&
                  link.accountId === expected,
              )
            )
              return Effect.void;
            return commit(
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
                  ...(accountId === undefined
                    ? []
                    : [
                        {
                          instanceId: target.instanceId,
                          variable: target.variable,
                          accountId,
                          ...(copies ? { copies } : {}),
                        },
                      ]),
                ],
              },
              true,
            );
          }),
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
            if (controls && entry.approval.turnOn && state.agentAccess && decision !== "deny")
              yield* writeControls(
                entry.approval.target,
                turnOnDecision(controls, decision, entry.scope.projectId),
              );
            else if (
              controls &&
              authorizationDecision(state.agentAccess, controls, entry.scope).decision !== "denied"
            )
              yield* writeControls(
                entry.approval.target,
                applyApprovalDecision(controls, decision, entry.scope.projectId),
              );
            const after = targetControls(entry.approval.target);
            if (
              decision === "once" &&
              after &&
              authorizationDecision(state.agentAccess, after, entry.scope).decision !== "denied"
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
      connectOnePassword: Effect.fn("AccountsService.connectOnePassword")(function* (input) {
        // 1Password may wait on its own unlock prompt: connect before taking the permit. A
        // Connect or Disconnect that settled meanwhile wins.
        const generation = storeGeneration;
        const connected = yield* sources.onePassword(Redacted.make(input)).pipe(Effect.result);
        return yield* locked(
          Effect.gen(function* () {
            if (storeGeneration !== generation) return (yield* snapshotNow).stores;
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
            const tokenRef =
              input.mode === "service-account"
                ? yield* stageValue(Redacted.make(new TextEncoder().encode(input.token)))
                : undefined;
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
            storeGeneration++;
            cache.clear();
            return (yield* snapshotNow).stores;
          }),
        );
      }),
      disconnectOnePassword: locked(
        Effect.gen(function* () {
          const { onePassword: _, ...next } = state;
          yield* commit({ ...next, onePasswordStatus: { state: "not-connected" } });
          onePasswordClient = undefined;
          storeGeneration++;
          cache.clear();
          return (yield* snapshotNow).stores;
        }),
      ),
      importPasswords: Effect.fn("AccountsService.importPasswords")(function* (input) {
        // An agent's import (its operation): only while it still stands, and never wider than
        // the profile it goes into.
        const cap = input.operationId
          ? yield* locked(
              Effect.gen(function* () {
                const operation = operationOf(input.operationId!);
                if (
                  !operation ||
                  operation.kind !== "refresh" ||
                  operation.profileId !== input.profileId ||
                  !operation.passwords
                )
                  return yield* fail("denied", "That import isn't waiting for passwords.");
                const blocked = blockedNow(operation);
                if (blocked) return yield* fail("denied", blocked);
                return effectiveProfile(state.profiles, operation.profileId);
              }),
            )
          : undefined;
        const capped = (controls: AccountControls): AccountControls =>
          cap === undefined
            ? controls
            : {
                ...controls,
                access:
                  ACCESS_ORDER[controls.access] > ACCESS_ORDER[cap.access]
                    ? cap.access
                    : controls.access,
                scope:
                  cap.scope.type === "all-projects"
                    ? controls.scope
                    : controls.scope.type === "all-projects"
                      ? cap.scope
                      : {
                          type: "projects",
                          projectIds: controls.scope.projectIds.filter((projectId) =>
                            cap.scope.type === "projects"
                              ? cap.scope.projectIds.includes(projectId)
                              : true,
                          ),
                        },
              };
        // An authenticator export is the person's own import, never an agent's operation.
        if (cap === undefined && isAuthenticatorExport(input.content)) {
          const keys = yield* Effect.try({
            try: () => parseAuthenticatorExport(input.content),
            catch: () => fail("invalid-input", "The authenticator export could not be read."),
          });
          const rows = yield* locked(
            Effect.sync(() => state.accounts.map(({ summary }) => summary)),
          );
          const { found, unmatched } = authenticatorTargets(rows, keys, input.profileId);
          const kept = found.length ? yield* keepFound(found) : [];
          // Only what was written counts: a row changed since it was matched is skipped.
          const matched = new Set(
            found.flatMap((item) => (item.accountId ? [item.accountId] : [])),
          );
          const updated = kept.filter((accountId) => matched.has(accountId)).length;
          return {
            created: kept.length - updated,
            updated,
            skipped: found.length - kept.length,
            ...(unmatched.length ? { unmatched } : {}),
          };
        }
        const parsed = yield* Effect.try({
          try: () => parsePasswordImport(input.content, input.format),
          catch: () => fail("invalid-input", "The password export is not a supported CSV file."),
        });
        const fields = ["password", "totp"];
        /**
         * The saved login an entry is, by the one login identity: its exact tenant, or another page
         * of the only one there when one side names no tenant, or a password-free session row.
         * `written` is this import's own rows, which keep the address they were written from.
         */
        const matchOf = (
          entry: (typeof parsed.entries)[number],
          written: ReadonlyMap<AccountId, string>,
        ) => {
          const login = importedLogin(entry);
          const mine = (account: StoredAccount) =>
            // The same login in another profile is that profile's own row.
            (input.profileId === undefined ||
              account.summary.details.kind !== "website" ||
              account.summary.details.profileId === undefined ||
              account.summary.details.profileId === input.profileId) &&
            (written.get(account.summary.accountId) ?? entry.loginUrl) === entry.loginUrl;
          const sameProfileFirst = (a: StoredAccount, b: StoredAccount) =>
            Number(
              b.summary.details.kind === "website" &&
                b.summary.details.profileId === input.profileId,
            ) -
            Number(
              a.summary.details.kind === "website" &&
                a.summary.details.profileId === input.profileId,
            );
          // Saved passwords at this site for this username, whatever their tenant.
          const candidates = state.accounts
            .filter((account) => mine(account) && loginCandidates([account.summary], login).length)
            .toSorted(sameProfileFirst);
          const exact = candidates.filter((account) => isLogin(account.summary, login));
          // Another page of the one login there is only when one side names no tenant: two saved
          // paths are two tenants, whatever their passwords.
          const only = candidates.length === 1 ? candidates[0] : undefined;
          const rootTenant = (details: StoredAccount["summary"]["details"]) =>
            (loginKeysOf(details)[0]?.tenant ?? "/") === "/";
          const alias =
            only !== undefined && (rootTenant(only.summary.details) || rootTenant(login))
              ? only
              : undefined;
          // A university keeps its password too, and is no login of the identity's: the same
          // site and username, one side naming no tenant, is it.
          const wanted = loginKeysOf(login);
          const university = state.accounts.find(
            (account) =>
              mine(account) &&
              account.summary.details.kind === "website" &&
              universityDetails(account.summary.details) !== undefined &&
              (rootTenant(account.summary.details) || rootTenant(login)) &&
              loginKeysOf(account.summary.details).some((own) =>
                wanted.some((key) => own.site === key.site && own.username === key.username),
              ),
          );
          const session = state.accounts.find(
            (account) =>
              mine(account) &&
              account.summary.details.kind === "website" &&
              account.summary.secrets["password"] === undefined &&
              account.summary.details.sites.includes(entry.site) &&
              loginUserKey(account.summary.details.username) === loginUserKey(entry.username),
          );
          const existing =
            exact[0] ?? alias ?? (candidates.length ? undefined : (university ?? session));
          return { login, candidates, existing };
        };
        // Matched rows may keep their values in an external store: read them before the permit.
        const matchedAt = yield* locked(
          Effect.sync(() =>
            parsed.entries.map((entry) => matchOf(entry, new Map()).existing?.summary.accountId),
          ),
        );
        const matched = [...new Set(matchedAt.flatMap((accountId) => accountId ?? []))];
        // From a browser (an import or a Refresh), a login the person removed stays removed; a file
        // they pick brings it back.
        const fromBrowser = input.origin === "browser" || input.refresh === true;
        const current = new Map<
          AccountId,
          { readonly version: string; readonly password?: string; readonly totp?: string }
        >();
        for (const accountId of matched) {
          const read = yield* readOutside(accountId, fields).pipe(Effect.option);
          if (Option.isNone(read)) continue;
          const { values, version } = read.value;
          current.set(accountId, {
            version,
            ...(values.password ? { password: Redacted.value(values.password) } : {}),
            ...(values.totp ? { totp: Redacted.value(values.totp) } : {}),
          });
        }
        // Copies to the Keychain and 1Password, written once the permit is free.
        const copies: Array<Effect.Effect<AccountSaveResult, AccountsError>> = [];
        const deferred = () => {
          const later: { finish?: Effect.Effect<AccountSaveResult, AccountsError> } = {};
          return {
            later,
            keep: () => {
              if (later.finish) copies.push(later.finish);
            },
          };
        };
        const imported = yield* locked(
          batched(
            Effect.gen(function* () {
              // Checked again where it writes: revoked while the passwords were read, none go in.
              if (input.operationId) {
                const stopped = yield* standsNow(input.operationId, "do");
                if (stopped) return yield* fail("denied", stopped);
              }
              const result = { created: 0, updated: 0, skipped: parsed.skipped };
              const written = new Map<AccountId, string>();
              // Imported again on purpose, once written: it comes back everywhere it was removed.
              const revive = (removed: ReadonlyArray<RemovedLogin>) =>
                removed.length
                  ? commit({
                      ...state,
                      removedLogins: (state.removedLogins ?? []).filter(
                        (marker) => !removed.includes(marker),
                      ),
                    })
                  : Effect.void;
              for (const [index, entry] of parsed.entries.entries()) {
                const { login, candidates, existing } = matchOf(entry, written);
                // Its row was removed or changed while the import read it: it stays as it is now.
                // A row this import wrote from another address is another tenant's, not a change.
                const before = matchedAt[index];
                if (
                  before !== undefined &&
                  existing?.summary.accountId !== before &&
                  !written.has(before)
                ) {
                  result.skipped++;
                  continue;
                }
                const removed = (state.removedLogins ?? []).filter((marker) =>
                  removedHere(marker, login, input.profileId),
                );
                // A browser never writes a login the person removed; a Refresh, nor one it can't
                // tell apart from the tenants saved there.
                if (
                  (fromBrowser && removed.length > 0) ||
                  (input.refresh && !existing && candidates.length > 0)
                ) {
                  result.skipped++;
                  continue;
                }
                if (existing?.summary.details.kind === "website") {
                  const known = current.get(existing.summary.accountId);
                  // Unread, or changed since it was read: the row as it is now stays.
                  if (!known || known.version !== valuesVersion(existing, fields)) {
                    result.skipped++;
                    continue;
                  }
                  const details = existing.summary.details;
                  const changedAt = existing.summary.secrets["password"]?.changedAt;
                  const different =
                    known.password !== undefined && known.password !== entry.password;
                  // Imports never erase: a different password wins only when known to be newer.
                  const newer = Boolean(
                    entry.changedAt && changedAt && entry.changedAt > changedAt,
                  );
                  const password = known.password === undefined || (different && newer);
                  // A code fills a login that has none. A saved code is replaced only by an edit:
                  // a line's date is the password's, not the code's.
                  const totp =
                    entry.totp !== undefined && known.totp === undefined && (!different || newer);
                  const claims = input.profileId !== undefined && details.profileId === undefined;
                  // Same password: only a newer date is kept; its sign-in evidence stays as it is.
                  const stored = existing.summary.secrets["password"];
                  if (
                    !different &&
                    stored &&
                    entry.changedAt &&
                    (!changedAt || entry.changedAt > changedAt)
                  )
                    yield* commit(
                      replaceAccount({
                        ...existing,
                        summary: {
                          ...existing.summary,
                          secrets: {
                            ...existing.summary.secrets,
                            password: { ...stored, changedAt: entry.changedAt },
                          },
                        },
                      }),
                    );
                  written.set(existing.summary.accountId, entry.loginUrl);
                  if (!password && !totp && !claims) {
                    result.skipped++;
                    continue;
                  }
                  // A saved password makes a recorded session row an ordinary login.
                  const { origin, ...kept } = details;
                  const patch = deferred();
                  const saved = yield* save(
                    {
                      accountId: existing.summary.accountId,
                      name: existing.summary.name,
                      details: {
                        ...kept,
                        ...(origin && !password ? { origin } : {}),
                        loginUrl: details.loginUrl ?? entry.loginUrl,
                        ...(claims ? { profileId: input.profileId } : {}),
                      },
                      secrets: {
                        ...(password
                          ? {
                              password: {
                                type: "scient" as const,
                                value: entry.password,
                                ...(entry.changedAt ? { changedAt: entry.changedAt } : {}),
                              },
                            }
                          : {}),
                        ...(totp && entry.totp
                          ? { totp: { type: "scient" as const, value: entry.totp } }
                          : {}),
                      },
                    },
                    undefined,
                    undefined,
                    patch.later,
                  );
                  patch.keep();
                  const totpNow = totp ? entry.totp : known.totp;
                  current.set(saved.accountId, {
                    version: valuesVersion(findAccount(saved.accountId), fields),
                    password: password ? entry.password : known.password!,
                    ...(totpNow === undefined ? {} : { totp: totpNow }),
                  });
                  yield* revive(removed);
                  result.updated++;
                  continue;
                }
                // A new login is never more open than this user's logins covering its origin in
                // this profile (or in none): the most closed one's controls, whatever their order,
                // and no subdomains if any of them is kept to the exact origin.
                const site = loginSiteKey(entry.site);
                const coveringRows = state.accounts.flatMap((account) => {
                  const { details } = account.summary;
                  return details.kind === "website" &&
                    site !== undefined &&
                    loginUserKey(details.username) === loginUserKey(entry.username) &&
                    siteMatches(details.sites, site) &&
                    (details.profileId === undefined || details.profileId === input.profileId)
                    ? [{ summary: account.summary, sites: details.sites }]
                    : [];
                });
                const openness = ({ controls }: AccountSummary) =>
                  (controls.access === "off" ? 0 : controls.access === "ask" ? 2 : 4) +
                  (controls.scope.type === "all-projects" ? 1 : 0);
                const covering = coveringRows.toSorted(
                  (left, right) => openness(left.summary) - openness(right.summary),
                )[0];
                const exact = coveringRows.some(({ sites }) =>
                  sites.some((saved) => saved.includes("://") && loginSiteKey(saved) === site),
                );
                const saved = yield* save({
                  ...(covering || cap
                    ? {
                        controls: capped(
                          covering?.summary.controls ?? defaultAccountControls("website"),
                        ),
                      }
                    : {}),
                  name: entry.name,
                  details: {
                    kind: "website",
                    // Kept to the exact origin, as its covering login is.
                    sites: [exact && site !== undefined ? site : entry.site],
                    username: entry.username,
                    loginUrl: entry.loginUrl,
                    ...(input.profileId ? { profileId: input.profileId } : {}),
                  },
                  secrets: {
                    password: {
                      type: "scient",
                      value: entry.password,
                      ...(entry.changedAt ? { changedAt: entry.changedAt } : {}),
                    },
                    ...(entry.totp ? { totp: { type: "scient", value: entry.totp } } : {}),
                  },
                });
                written.set(saved.accountId, entry.loginUrl);
                // A later line for the same login compares with this one.
                current.set(saved.accountId, {
                  version: valuesVersion(findAccount(saved.accountId), fields),
                  password: entry.password,
                  ...(entry.totp ? { totp: entry.totp } : {}),
                });
                yield* revive(removed);
                result.created++;
              }
              return result;
            }),
          ),
        );
        for (const finish of copies)
          yield* finish.pipe(
            Effect.catch(() =>
              Effect.logWarning("An imported password's store copy could not be written."),
            ),
          );
        return imported;
      }),
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
                  loginUserKey(details.username) === loginUserKey(input.username) &&
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
            // The page's route names a saved tenant; several others it could be are the person's pick.
            const tenantOf = (account: StoredAccount) =>
              loginKeysOf(account.summary.details)[0]?.tenant ?? "/";
            const route = input.path === undefined ? undefined : `${input.origin}${input.path}`;
            const onRoute =
              route === undefined
                ? undefined
                : candidates.find((account) =>
                    isLogin(account.summary, {
                      kind: "website",
                      sites: [input.origin],
                      username: input.username,
                      loginUrl: route,
                    }),
                  );
            const tenants = [
              ...new Map(candidates.map((account) => [tenantOf(account), account])).values(),
            ];
            return {
              input,
              candidates: candidates.map(({ summary }) => summary.accountId),
              onRoute: onRoute?.summary.accountId,
              tenants: tenants.map(({ summary }) => summary.accountId),
            };
          }),
        ).pipe(
          Effect.flatMap(({ input, candidates, onRoute, tenants }) =>
            Effect.gen(function* () {
              const digest = (value: Redacted.Redacted<string>) =>
                NodeCrypto.createHash("sha256").update(Redacted.value(value)).digest();
              const submitted = digest(Redacted.make(input.password));
              // Still this login, with the password that was compared, when the answer is given.
              const stillMatches = (accountId: AccountId, version: string | undefined) =>
                locked(
                  Effect.sync(() => {
                    const details = findAccount(accountId)?.summary.details;
                    return (
                      details?.kind === "website" &&
                      loginUserKey(details.username) === loginUserKey(input.username) &&
                      siteMatches(details.sites, input.origin) &&
                      (version === undefined ||
                        valuesVersion(findAccount(accountId), ["password"]) === version)
                    );
                  }),
                );
              for (const accountId of candidates) {
                cache.delete(accountId);
                const { values, version } = yield* readOutside(accountId, ["password"]);
                if (
                  values.password &&
                  NodeCrypto.timingSafeEqual(submitted, digest(values.password)) &&
                  (yield* stillMatches(accountId, version))
                )
                  return { result: "same" as const, accountId };
                // An earlier password the login keeps (for it as it is now) is already saved: a
                // sign-in with it adds no version, nor proves one.
                const earlier = yield* locked(
                  Effect.sync(() => {
                    const row = findAccount(accountId);
                    return row ? offeredVersions(row).map((entry) => entry.ref) : [];
                  }),
                );
                for (const ref of earlier) {
                  const value = yield* Effect.option(readValue(ref));
                  if (
                    Option.isSome(value) &&
                    NodeCrypto.timingSafeEqual(submitted, digest(value.value)) &&
                    (yield* stillMatches(accountId, undefined))
                  )
                    return { result: "same" as const, accountId };
                }
              }
              // A changed password belongs to a row that is still this login: the route's tenant,
              // else the first, with the tenants it could be for the person to pick.
              const standing: AccountId[] = [];
              for (const accountId of tenants)
                if (yield* stillMatches(accountId, undefined)) standing.push(accountId);
              const target =
                onRoute !== undefined && (yield* stillMatches(onRoute, undefined))
                  ? onRoute
                  : standing[0];
              if (target === undefined) {
                for (const accountId of candidates)
                  if (yield* stillMatches(accountId, undefined))
                    return { result: "password-changed" as const, accountId };
                return { result: "new" as const };
              }
              return {
                result: "password-changed" as const,
                accountId: target,
                ...(target !== onRoute && standing.length > 1 ? { choices: standing } : {}),
              };
            }),
          ),
        ),
      ),
      filledTab: Effect.fn("AccountsService.filledTab")((threadId, tabId) =>
        Effect.sync(() => filledTabs.get(`${threadId}\u0000${tabId}`)),
      ),
      reveal: Effect.fn("AccountsService.reveal")(function* (accountId, field, version) {
        const { account, earlier } = yield* locked(
          Effect.sync(() => {
            const row = findAccount(accountId);
            return {
              account: row,
              earlier: row
                ? offeredVersions(row).find((entry) => versionIdOf(entry.ref) === version)?.ref
                : undefined,
            };
          }),
        );
        if (!account) return yield* missing();
        if (account.summary.details.kind !== "website")
          return yield* fail("unsupported", "Only website passwords can be shown here.");
        // The current password may be in an external store: read without the write permit.
        const value =
          field === "version"
            ? earlier && (yield* readValue(earlier))
            : field === "previous"
              ? account.previous && (yield* readValue(account.previous.password))
              : (yield* readOutside(accountId, ["password"])).values.password;
        if (!value) return yield* fail("not-found", "There is no saved password to show.");
        yield* locked(
          appendActivity({
            target: { type: "account", accountId },
            action: "credentials",
            decision: "allowed",
            detail:
              field === "version"
                ? "Earlier password shown"
                : field === "previous"
                  ? "Previous password shown"
                  : "Password shown",
          }),
        );
        return { value: Redacted.value(value) };
      }),
      usePassword: Effect.fn("AccountsService.usePassword")(function* (accountId, version) {
        const later: SaveLater = {};
        yield* locked(
          Effect.gen(function* () {
            const row = findAccount(accountId);
            if (!row) return yield* missing();
            const chosen = offeredVersions(row).find((entry) => versionIdOf(entry.ref) === version);
            if (!chosen) return yield* fail("not-found", "That password is no longer kept.");
            // The person's own save of that very version (its ref, no new value: the history
            // only reorders): held in Scient (a link to the Keychain or 1Password is left), its
            // copies there written with it.
            const value = yield* readValue(chosen.ref);
            yield* save(
              {
                accountId,
                name: row.summary.name,
                details: row.summary.details,
                secrets: { password: { type: "scient", value: Redacted.value(value) } },
              },
              undefined,
              undefined,
              later,
              chosen.ref,
            );
            // It keeps when it last worked; what a site said of it before is forgotten.
            const saved = findAccount(accountId);
            const secret = saved?.summary.secrets["password"];
            if (saved && secret && saved.values["password"] === chosen.ref) {
              const { signIn, ...summary } = saved.summary;
              yield* commit({
                ...replaceAccount({
                  ...saved,
                  summary: {
                    ...(signIn?.state === "password-rejected" ? summary : saved.summary),
                    secrets: {
                      ...saved.summary.secrets,
                      password: freshPassword(secret, chosen.provenAt),
                    },
                  },
                }),
                passwordHistory: withVersions(
                  accountId,
                  historyOf(accountId).map((entry) => {
                    if (entry.ref !== chosen.ref) return entry;
                    const { refused: _, ...kept } = entry;
                    return kept;
                  }),
                ),
              });
            }
            cache.delete(accountId);
            yield* appendActivity({
              target: { type: "account", accountId },
              action: "credentials",
              decision: "allowed",
              detail: "Earlier password put back",
            });
          }),
        );
        // Copies to the Keychain and 1Password are written once the permit is free.
        if (later.finish) yield* later.finish.pipe(Effect.ignore);
      }),
      removePasswordVersion: Effect.fn("AccountsService.removePasswordVersion")(
        function* (accountId, version) {
          return yield* locked(
            Effect.gen(function* () {
              const row = findAccount(accountId);
              if (!row) return yield* missing();
              const chosen = offeredVersions(row).find(
                (entry) => versionIdOf(entry.ref) === version,
              );
              if (!chosen) return yield* fail("not-found", "That password is no longer kept.");
              const at = yield* Clock.currentTimeMillis;
              const undoId = NodeCrypto.randomUUID();
              const secret = row.summary.secrets["password"];
              const wasPrevious = row.previous?.password === chosen.ref;
              let kept: StoredAccount = row;
              if (wasPrevious) {
                const { previous: _, ...rest } = row;
                kept = rest;
                if (secret) {
                  const { previousAt: _at, ...unprevious } = secret;
                  kept = {
                    ...rest,
                    summary: {
                      ...row.summary,
                      secrets: { ...row.summary.secrets, password: unprevious },
                    },
                  };
                }
              }
              yield* commit({
                ...replaceAccount(kept),
                passwordHistory: withVersions(
                  accountId,
                  historyOf(accountId).filter((entry) => entry.ref !== chosen.ref),
                ),
                removedVersions: [
                  ...(state.removedVersions ?? []),
                  {
                    undoId,
                    accountId,
                    version: chosen,
                    ...(wasPrevious ? { previous: true as const } : {}),
                    ...(wasPrevious && secret?.previousAt ? { previousAt: secret.previousAt } : {}),
                    until: at + UNDO_FOR_MS,
                  },
                ],
              });
              cache.delete(accountId);
              yield* appendActivity({
                target: { type: "account", accountId },
                action: "credentials",
                decision: "allowed",
                detail: "Earlier password removed",
              });
              return { undoId };
            }),
          );
        },
      ),
      restorePasswordVersion: Effect.fn("AccountsService.restorePasswordVersion")(
        function* (undoId) {
          yield* locked(
            Effect.gen(function* () {
              const at = yield* Clock.currentTimeMillis;
              const entry = (state.removedVersions ?? []).find((kept) => kept.undoId === undoId);
              if (!entry || entry.until <= at)
                return yield* fail("not-found", "It can no longer be undone.");
              const row = findAccount(entry.accountId);
              // Only to the login it was removed from, as it was then.
              if (!row || identityOf(row.summary) !== entry.version.identity)
                return yield* fail(
                  "conflict",
                  "The login changed since: the password stays removed.",
                );
              const versions = historyOf(entry.accountId);
              const secret = row.summary.secrets["password"];
              // Saved again since under another ref (an older build): kept once, as it is. Only
              // what the login holds now counts (its password, Previous, its identity's history),
              // never another removal of the same value.
              const value = yield* Effect.option(readValue(entry.version.ref));
              const active = [
                row.values["password"],
                row.previous?.password,
                ...historyOf(entry.accountId)
                  .filter((version) => version.identity === entry.version.identity)
                  .map((version) => version.ref),
              ].filter((ref): ref is string => ref !== undefined && ref !== entry.version.ref);
              let same = false;
              for (const ref of Option.isSome(value) ? active : []) {
                const held = yield* Effect.option(readValue(ref));
                same ||=
                  Option.isSome(held) &&
                  Option.isSome(value) &&
                  Redacted.value(held.value) === Redacted.value(value.value);
              }
              if (same) {
                yield* commit({
                  ...state,
                  removedVersions: (state.removedVersions ?? []).filter((kept) => kept !== entry),
                });
                return;
              }
              const asPrevious =
                entry.previous === true &&
                row.previous === undefined &&
                row.values["password"] !== entry.version.ref &&
                secret !== undefined;
              const restored: StoredAccount = asPrevious
                ? {
                    ...row,
                    previous: { password: entry.version.ref },
                    summary: {
                      ...row.summary,
                      secrets: {
                        ...row.summary.secrets,
                        password: {
                          ...secret,
                          ...(entry.previousAt ? { previousAt: entry.previousAt } : {}),
                        },
                      },
                    },
                  }
                : row;
              yield* commit({
                ...replaceAccount(restored),
                passwordHistory: versions.some((kept) => kept.ref === entry.version.ref)
                  ? (state.passwordHistory ?? [])
                  : versions.length
                    ? withVersions(entry.accountId, [...versions, entry.version])
                    : [
                        ...(state.passwordHistory ?? []),
                        { accountId: entry.accountId, versions: [entry.version] },
                      ],
                removedVersions: (state.removedVersions ?? []).filter((kept) => kept !== entry),
              });
              cache.delete(entry.accountId);
            }),
          );
        },
      ),
      fillValues: Effect.fn("AccountsService.fillValues")(
        function* (accountId, origin, tab, recordAs, autoSubmit) {
          const matching = Effect.suspend(() => {
            const account = findAccount(accountId);
            if (!account) return missing();
            const details = account.summary.details;
            return details.kind === "website" && siteMatches(details.sites, origin)
              ? Effect.succeed({ account, details })
              : fail("denied", "The page does not match this account's sites.");
          });
          yield* locked(matching);
          const { values, version } = yield* readOutside(accountId, ["password", "totp"]);
          return yield* locked(
            Effect.gen(function* () {
              const { account, details } = yield* matching;
              // The username and the values filled must be of one version of the row.
              if (valuesVersion(account, ["password", "totp"]) !== version)
                return yield* fail("conflict", "The account changed meanwhile. Try again.");
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
              // Typed now: in use, for the history's bound.
              const ref = account.values["password"];
              const stamp = yield* now;
              const typed = historyOf(accountId).some((entry) => entry.ref === ref);
              yield* commit({
                ...replaceAccount({
                  ...account,
                  summary: { ...account.summary, lastUsedAt: stamp },
                }),
                ...(typed
                  ? {
                      passwordHistory: withVersions(
                        accountId,
                        historyOf(accountId).map((entry) =>
                          entry.ref === ref ? { ...entry, usedAt: stamp } : entry,
                        ),
                      ),
                    }
                  : {}),
              });
              if (recordAs !== undefined)
                yield* appendActivity({
                  target: { type: "account", accountId },
                  action: "credentials",
                  decision: "allowed",
                  detail: `Filled on ${recordAs.slice(0, 40)}: ${new URL(origin).origin}`,
                });
              if (tab) {
                const key = `${tab.threadId}\u0000${tab.tabId}`;
                filledTabs.delete(key);
                filledTabs.set(key, { accountId, url: tab.url });
                // Filled into the tab of a sign-in Scient runs: Scient's typing, whose submit is
                // no person's password (`keepTyped`).
                const filled = values.password;
                if (filled)
                  for (const typed of signInAttempts.typed.values())
                    if (typed.threadId === tab.threadId && typed.tabId === tab.tabId) {
                      const at = new URL(origin).origin;
                      typed.scientTyped.set(at, [...(typed.scientTyped.get(at) ?? []), filled]);
                    }
              }
              // The sign-in's result names this fill by a one-time `attempt`; a submit by itself
              // is granted only within the site's budget, counted in the same write.
              const attempt =
                values.password && ref
                  ? openAttempt(account, ref, origin, yield* Clock.currentTimeMillis)
                  : undefined;
              const submit =
                autoSubmit === true &&
                attempt !== undefined &&
                ref !== undefined &&
                (yield* grantSubmit(account, ref, new URL(origin).origin, attempt));
              return {
                ...(details.username === undefined ? {} : { username: details.username }),
                ...(values.password ? { password: Redacted.value(values.password) } : {}),
                ...(otp ? { otp } : {}),
                ...(attempt === undefined ? {} : { attempt }),
                ...(submit ? { submit: true as const } : {}),
              };
            }),
          );
        },
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
                        // Off keys are listed by name and state, for Turn on; kept keys never are.
                        !privateUse(account) && inScope(account.controls.scope, scope.projectId),
                    )
                : [],
              profiles: state.agentAccess
                ? profiles
                    .map((id) => effectiveProfile(state.profiles, id))
                    // A profile merged into Main is no agent's to pick, however it was named.
                    .filter(
                      (profile) =>
                        !profile.retired &&
                        !profile.removed &&
                        inScope(profile.scope, scope.projectId) &&
                        // A pinned run sees its pinned profile only, existing tabs included.
                        pinnedRefusal(scope, { type: "profile", profileId: profile.profileId }) ===
                          undefined,
                    )
                : [],
              profileChoices: state.profileChoices,
            };
          }),
        ),
      ),
      rowVersion: Effect.fn("AccountsService.rowVersion")((accountId) =>
        locked(
          Effect.sync(() => {
            const row = findAccount(accountId);
            return row ? { updatedAt: row.summary.updatedAt } : undefined;
          }),
        ),
      ),
      authorizeUse: Effect.fn("AccountsService.authorizeUse")((scope, target, use) =>
        locked(Effect.suspend(() => useRefusal(scope, target, use))),
      ),
      authorize: Effect.fn("AccountsService.authorize")(function* (scope, target, action, options) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const prepared = yield* locked(
              Effect.gen(function* () {
                const controls = targetControls(target);
                if (!controls) return yield* missing();
                const decision =
                  pinnedRefusal(scope, target) !== undefined
                    ? ({ decision: "denied", reason: "pinned" } as const)
                    : authorizationDecision(
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
                // Off isn't a dead end: an attended agent's card offers to turn it on.
                const turnOn =
                  target.type === "account" &&
                  decision.decision === "denied" &&
                  decision.reason === "off" &&
                  state.agentAccess &&
                  !scope.unattended &&
                  inScope(controls.scope, scope.projectId);
                yield* appendActivity({
                  ...audit,
                  decision: decision.decision === "ask" || turnOn ? "asked" : decision.decision,
                });
                if (decision.decision !== "ask" && !turnOn)
                  return { kind: "immediate" as const, decision };
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
                  ...(turnOn ? { turnOn: true as const } : {}),
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
                Deferred.await(prepared.answer).pipe(
                  Effect.timeoutOption(
                    Math.max(Math.min(options?.waitMs ?? APPROVAL_WAIT_MS, APPROVAL_WAIT_MS), 0),
                  ),
                ),
              );
              return yield* locked(
                Effect.gen(function* () {
                  const controls = targetControls(target);
                  const current = controls
                    ? authorizationDecision(state.agentAccess, controls, scope)
                    : { decision: "denied" as const, reason: "declined" as const };
                  // No answer in time is the outcome, whatever the item's access is by now.
                  const result: AccountAuthorization = Option.isNone(response)
                    ? { decision: "denied", reason: "timed-out" }
                    : current.decision === "denied"
                      ? current
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
              keyServesUse(summary, { kind: "plugin", id: "" }) &&
              !privateModelKey(summary) &&
              (origin === undefined || siteMatches(summary.details.sites, origin))
                ? [{ ref: accountTokenRef(summary.accountId), name: summary.name }]
                : [],
            ),
          ),
        ),
      ),
      resolveBound: Effect.fn("AccountsService.resolveBound")((ref, consumer, options) => {
        const allowed = locked(
          Effect.gen(function* () {
            const origin = consumer.kind === "local-connector" ? undefined : consumer.origin;
            const accountId = boundAccountId(ref);
            if (Option.isNone(accountId))
              return yield* fail("invalid-input", "The account reference is invalid.");
            const account = findAccount(accountId.value);
            if (!account) return yield* missing();
            const { details, controls } = account.summary;
            const user =
              consumer.kind === "connector"
                ? { kind: "connector" as const, id: consumer.connectorId }
                : consumer.kind === "plugin-key"
                  ? { kind: "plugin" as const, id: consumer.pluginId }
                  : { kind: "local-connector" as const, id: consumer.connectorId };
            // A key kept for one connector reaches it as its typed key did, and nothing else.
            const keptFor = privateUse(account.summary) !== undefined;
            if (
              !keyServesUse(account.summary, user) ||
              details.kind !== "api-key" ||
              (origin !== undefined && !siteMatches(details.sites, origin)) ||
              (consumer.kind === "connector" &&
                consumer.auth !== undefined &&
                !sameAuthStyle(details.auth, consumer.auth)) ||
              (!keptFor && agentAccessOff(state.agentAccess, controls.access)) ||
              // A connector serves every project it is in, so only a key for all of them fits.
              (consumer.kind === "connector"
                ? controls.scope.type !== "all-projects"
                : !inScope(controls.scope, consumer.projectId))
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
            return accountId.value;
          }),
        );
        return allowed.pipe(
          Effect.flatMap((accountId) => readOutside(accountId, ["token"])),
          // Off or Remove during the read wins.
          Effect.tap(() => allowed),
          Effect.flatMap(({ values }) =>
            values.token === undefined
              ? fail("not-found", "The account key is missing.")
              : Effect.succeed(values.token),
          ),
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
        );
      }),
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
      reportKeyUse: Effect.fn("AccountsService.reportKeyUse")((accountId, use, outcome, sent) =>
        locked(
          Effect.gen(function* () {
            const account = findAccount(accountId);
            const version = account?.values.token;
            if (!account || !version) return;
            const refused = account.summary.signIn?.state === "failed";
            // Nearly every use works; only one following a refusal changes anything.
            if (
              outcome === "ok" &&
              !refused &&
              !state.keyRefusals?.some((entry) => entry.accountId === accountId)
            )
              return;
            // An answer about the value it replaced says nothing about this one.
            const { token } = yield* resolve(accountId, ["token"]);
            if (!token || typedDigest(Redacted.value(token)) !== sent) return;
            const at = yield* now;
            const next = withKeyUse(state.keyRefusals ?? [], {
              accountId,
              use,
              version,
              at,
              outcome,
            });
            const summary =
              next.key === "refused" || (next.key === "works" && refused)
                ? withSignIn(
                    account.summary,
                    next.key === "refused"
                      ? { state: "failed", at, detail: "The service refused this key." }
                      : { state: "signed-in", at },
                    yield* Clock.currentTimeMillis,
                    "look",
                  )
                : account.summary;
            yield* commit(
              {
                ...(summary === account.summary ? state : replaceAccount({ ...account, summary })),
                keyRefusals: next.refusals,
              },
              true,
            );
          }),
        ).pipe(Effect.ignore),
      ),
      keepPrivateKey: Effect.fn("AccountsService.keepPrivateKey")(({ use, sites, auth, value }) =>
        locked(
          Effect.gen(function* () {
            const accountId = privateKeyId(use);
            const existing = findAccount(accountId);
            const input = {
              name: accountName(use.name),
              details: {
                kind: "api-key" as const,
                sites,
                auth,
                privateTo: { ...use, name: accountName(use.name) },
              },
              secrets: { token: { type: "scient" as const, value: Redacted.value(value) } },
              // Off and hidden too, so a build that drops `privateTo` never opens it to agents.
              controls: {
                ...defaultAccountControls("api-key"),
                access: "off" as const,
                visibility: "hidden" as const,
              },
            };
            yield* existing ? save({ ...input, accountId }) : save(input, accountId);
            // After the row, so a marker never names a row that was never written.
            const digest = typedDigest(Redacted.value(value));
            yield* commit(
              {
                ...state,
                keptKeys: [
                  ...(state.keptKeys ?? []).filter((entry) => entry.accountId !== accountId),
                  { accountId, digest },
                ],
              },
              true,
            );
            return accountId;
          }),
        ),
      ),
      keptKeyState: Effect.fn("AccountsService.keptKeyState")((use, typed, site) =>
        locked(
          Effect.sync(() => {
            const accountId = privateKeyId(use);
            const kept = state.keptKeys?.find((entry) => entry.accountId === accountId);
            if (!kept) return "new" as const;
            if (kept.digest !== typedDigest(Redacted.value(typed))) return "changed" as const;
            const details = findAccount(accountId)?.summary.details;
            if (kept.removed || !details) return "removed" as const;
            return site === undefined || ("sites" in details && details.sites.includes(site))
              ? ("kept" as const)
              : ("changed" as const);
          }),
        ),
      ),
      resolveTextGeneratorKey: Effect.fn("AccountsService.resolveTextGeneratorKey")(
        (accountId, generator) =>
          locked(
            Effect.gen(function* () {
              const account = findAccount(accountId);
              if (!account || !acceptsTextGeneratorKey(account.summary, generator))
                return yield* fail("denied", "The key is unavailable for this endpoint.");
              const { token } = yield* resolve(accountId, ["token"]);
              // Too short to tell apart from a provider's error text, so it is never sent.
              if (!token || Redacted.value(token).trim().length < 8) return yield* missing();
              return token;
            }),
          ),
      ),
      resolveCustomModelAccountKey: Effect.fn("AccountsService.resolveCustomModelAccountKey")(
        (accountId, origin, protocol) => locked(modelAccountKey(accountId, origin, protocol)),
      ),
      resolveSpeechKey: Effect.fn("AccountsService.resolveSpeechKey")(
        (accountId, origin, usage, projectId, actor) =>
          locked(
            Effect.gen(function* () {
              const account = findAccount(accountId);
              if (!account) return yield* missing();
              if (
                actor === "agent" &&
                agentAccessOff(state.agentAccess, account.summary.controls.access)
              )
                return yield* fail("denied", "This key is Off for agents.");
              if (!acceptsSpeechKey(account.summary, origin))
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
      resolveSecrets: Effect.fn("AccountsService.resolveSecretsInput")(
        function* (accountId, fields) {
          return (yield* readOutside(accountId, fields)).values;
        },
      ),
      recordCheck: Effect.fn("AccountsService.recordCheck")((accountId, { username, ...check }) =>
        locked(
          Effect.gen(function* () {
            const account = findAccount(accountId);
            // Google's own answer (`googleSessionsSeen`) is the one writer of its rows.
            if (!account || isGoogleSessionRow(account.summary)) return;
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
        (
          { savedPasswordUsed, byPerson, profileId, version, passwordVersion, attempt, ...logged },
          message,
          wait,
        ) =>
          locked(
            Effect.gen(function* () {
              yield* appendActivity({ ...logged, decision: "allowed" });
              if (logged.target.type === "account") {
                const accountId = logged.target.accountId;
                const before = findAccount(accountId);
                // A person's result names its password by its fill's one-time `attempt`.
                const opened = attempt === undefined ? undefined : tabAttempts.get(attempt);
                if (attempt !== undefined) tabAttempts.delete(attempt);
                const bound =
                  opened?.accountId === accountId && opened.until > (yield* Clock.currentTimeMillis)
                    ? opened
                    : undefined;
                const used = attempt === undefined ? passwordVersion : bound?.ref;
                const versionMoved = version !== undefined && !unchangedSince(before, version);
                // A person's result for an attempt this server doesn't know, or for the login as
                // it was before an edit, says nothing of the login as it is now.
                const stale =
                  attempt !== undefined &&
                  (bound === undefined ||
                    before === undefined ||
                    bound.identity !== identityOf(before.summary));
                // A sign-in bound to one of the login's passwords orders its history first: it
                // may hold another password after.
                if (
                  before &&
                  used !== undefined &&
                  !versionMoved &&
                  !stale &&
                  (logged.signInOutcome === "signed-in" ||
                    logged.signInOutcome === "password-rejected")
                )
                  yield* settlePassword(
                    accountId,
                    used,
                    bound?.identity ?? identityOf(before.summary),
                    logged.signInOutcome,
                  );
                const account = findAccount(accountId);
                // Settled by version: an outcome about a password, code or access since changed
                // says nothing about the row as it is now, nor about a password it no longer holds.
                const entry =
                  versionMoved ||
                  stale ||
                  ((passwordVersion !== undefined || attempt !== undefined) &&
                    account?.values["password"] !== used)
                    ? { ...logged, signInOutcome: undefined }
                    : logged;
                // The site's submit budget: every failed or limited sign-in there, stale or not, as
                // observed now, by registrable domain. A submit by itself is settled once, by a
                // result for its own login, and a success only by a live attempt.
                const atMs = yield* Clock.currentTimeMillis;
                const failed =
                  logged.signInOutcome === "password-rejected" ||
                  logged.signInOutcome === "code-rejected" ||
                  logged.signInOutcome === "limited" ||
                  logged.signInOutcome === "failed";
                const recent = (at: string) => atMs - Date.parse(at) < FAILURE_WINDOW_MS;
                const auto =
                  attempt === undefined
                    ? undefined
                    : (state.autoSubmits ?? []).find(
                        (submit) =>
                          submit.attempt === attempt &&
                          submit.accountId === accountId &&
                          submit.outcome === undefined,
                      );
                const settled: "failed" | "signed-in" | undefined =
                  auto && (failed || (logged.signInOutcome === "signed-in" && !stale))
                    ? failed
                      ? "failed"
                      : "signed-in"
                    : undefined;
                // A result for a fill counts on the site it was typed on, whatever its login
                // is now (edited, or removed); any other on the login's sites.
                const sites = !failed
                  ? []
                  : opened?.accountId === accountId
                    ? [sharedSite(opened.origin)]
                    : before?.summary.details.kind === "website"
                      ? [...new Set(before.summary.details.sites.map(sharedSite))]
                      : [];
                const ledger = {
                  ...(settled
                    ? {
                        autoSubmits: (state.autoSubmits ?? []).map((submit) =>
                          submit === auto ? { ...submit, outcome: settled } : submit,
                        ),
                      }
                    : {}),
                  ...(sites.length
                    ? {
                        signInFailures: [
                          ...(state.signInFailures ?? []).filter((entry) => recent(entry.at)),
                          ...sites.map((site) => ({
                            site,
                            at: DateTime.formatIso(DateTime.makeUnsafe(atMs)),
                          })),
                        ],
                      }
                    : {}),
                };
                if (account) {
                  const at = yield* now;
                  const details = account.summary.details;
                  // The person signed back in: their own sign-out there is over.
                  const signedOut =
                    byPerson && entry.signInOutcome === "signed-in" && details.kind === "website"
                      ? withoutSignOuts(
                          state.signedOut,
                          profileId ?? details.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
                          details.sites,
                        )
                      : state.signedOut;
                  const replaced = replaceAccount({
                    ...account,
                    summary: entry.signInOutcome
                      ? withSignIn(
                          {
                            ...account.summary,
                            lastUsedAt: at,
                            ...(entry.signInOutcome === "signed-in" && savedPasswordUsed
                              ? { secrets: verifiedPassword(account.summary.secrets, at) }
                              : entry.signInOutcome === "password-rejected" && used !== undefined
                                ? { secrets: refusedPassword(account.summary.secrets, at) }
                                : {}),
                          },
                          {
                            state: outcomeSignInState(entry.signInOutcome),
                            at,
                            ...(message === undefined ? {} : { detail: message }),
                          },
                          atMs,
                          byPerson ? "press" : "attempt",
                        )
                      : { ...account.summary, lastUsedAt: at },
                  });
                  // The person's own sign-in is newer than any sign-out of this row still clearing.
                  const ops = replaced.universitySignOuts ?? [];
                  const kept =
                    byPerson && !stale
                      ? ops.filter((op) => !op.accountIds.includes(account.summary.accountId))
                      : ops;
                  yield* commit(
                    {
                      ...replaced,
                      ...ledger,
                      ...(kept.length === ops.length ? {} : { universitySignOuts: kept }),
                      ...(signedOut === undefined ? {} : { signedOut }),
                    },
                    true,
                  );
                } else if (Object.keys(ledger).length) yield* commit({ ...state, ...ledger }, true);
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
      // Provider probes resolve saved model keys unattended: while that cannot open the store,
      // they resolve again once the person's first use has opened it.
      const resolveWhenOpen: CustomModelAccountResolver = (accountId, origin, protocol) =>
        service.openWithoutPrompt.pipe(
          Effect.flatMap((open) =>
            open
              ? service.resolveCustomModelAccountKey(accountId, origin, protocol)
              : Effect.sync(() => {
                  resolutionWaitedForOpen = true;
                }).pipe(Effect.andThen(Effect.fail(unopened()))),
          ),
        );
      reinstallModelKeyResolver = sources.modelCatalog.installResolver(
        vault.unattendedWaitsForPerson ? resolveWhenOpen : service.resolveCustomModelAccountKey,
        migrate,
      );
      yield* reinstallModelKeyResolver;
    }
    return service;
  }),
);
