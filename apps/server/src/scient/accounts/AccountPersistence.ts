import {
  AccountCodeNotice,
  AccountChange,
  AccountCodeSources,
  AccountNeedsYou,
  AccountSite,
  AccountId,
  CustomModelId,
  CustomModelProtocol,
  AccountKeyLink,
  AccountKeyUse,
  BrowserProfileChoices,
  BrowserProfileId,
  AccountsError,
  AccountSecretSummary,
  AccountSummary,
  AccountWriteStore,
  BrowserProfileRecord,
  ProfileOperation,
  ReportingComputer,
  BrowserSourceProfile,
  AccountActivityEntry,
  EnvironmentId,
  IsoDateTime,
  OnePasswordStatus,
  UniversitySignOut,
  TrimmedNonEmptyString,
  linksBrowserProfile,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { AccountVault } from "./AccountVault.ts";

export const StoredAccount = Schema.Struct({
  summary: AccountSummary,
  pendingCopies: Schema.optional(Schema.Record(Schema.String, Schema.Array(AccountWriteStore))),
  values: Schema.Record(
    Schema.String,
    Schema.String.check(Schema.isPattern(/^accounts-value-[a-f0-9-]{36}$/)),
  ),
  /** A website's replaced password, kept for recovery until the next one replaces it. */
  previous: Schema.optional(
    Schema.Struct({
      password: Schema.String.check(Schema.isPattern(/^accounts-value-[a-f0-9-]{36}$/)),
    }),
  ),
  /** Digests of this login's backup codes taken for a sign-in: a later capture never restores one. */
  usedCodes: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
      Schema.isMaxLength(200),
    ),
  ),
  /** Each field's write count: a receipt or a deferred copy applies only to the write it made. */
  revisions: Schema.optional(Schema.Record(Schema.String, Schema.Int)),
});
export type StoredAccount = typeof StoredAccount.Type;

/** A desktop that sends here: the hash of its key, and the session it last proved it over. */
export const RemoteSender = Schema.Struct({
  source: EnvironmentId,
  label: Schema.String,
  keyHash: Schema.String,
  sessionId: Schema.String,
  /** The session that bound it; only that one may be issued a new key without the old. */
  boundBy: Schema.optional(Schema.String),
  /** When it last proved its key; a sender silent for 30 days loses its copies. */
  seenAt: IsoDateTime,
});
export type RemoteSender = typeof RemoteSender.Type;
const CustomModelEscrow = Schema.Struct({
  accountId: AccountId,
  connectionId: CustomModelId,
  legacyId: CustomModelId,
  baseUrl: Schema.String,
  protocol: CustomModelProtocol,
  tokenRef: Schema.String.check(Schema.isPattern(/^accounts-value-[a-f0-9-]{36}$/)),
});

/**
 * A login the person removed, by its login key (`scientLoginIdentity`) and profile: a browser import
 * or Refresh doesn't make it again. No tenant: it had no saved address, so it covers any page.
 */
export const RemovedLogin = Schema.Struct({
  site: Schema.String,
  tenant: Schema.optional(Schema.String),
  username: Schema.String,
  profileId: Schema.optional(Schema.String),
});
export type RemovedLogin = typeof RemovedLogin.Type;

/** The person used Accounts' Sign out for a site in a profile; kept until a sign-in there. */
export const SignOut = Schema.Struct({ profileId: BrowserProfileId, site: TrimmedNonEmptyString });
export type SignOut = typeof SignOut.Type;

const SourceProfilesEntry = Schema.Struct({
  computer: ReportingComputer,
  seenAt: IsoDateTime,
  sources: Schema.Array(BrowserSourceProfile),
});
const PendingPurge = Schema.Struct({
  profileId: BrowserProfileId,
  generation: Schema.optional(Schema.Int),
});
const SignOutSave = Schema.Struct({
  operationId: Schema.String,
  ref: Schema.String.check(Schema.isPattern(/^accounts-value-[a-f0-9-]{36}$/)),
});
/**
 * A scheduled task that runs only as one sign-in, in its profile, on this computer, kept until an
 * explicit unpin. `projectId`: the project that pinned it, whose tasks alone it binds. `waiting`:
 * when its last run found the sign-in signed out; it runs once more on a newer sign-in.
 */
export const TaskPin = Schema.Struct({
  scheduledTaskId: TrimmedNonEmptyString,
  accountId: AccountId,
  profileId: BrowserProfileId,
  environmentId: TrimmedNonEmptyString,
  username: Schema.String,
  projectId: Schema.optional(TrimmedNonEmptyString),
  last: Schema.optional(Schema.Literals(["worked", "signed-out", "not-allowed", "unreachable"])),
  waiting: Schema.optional(IsoDateTime),
});
export type TaskPin = typeof TaskPin.Type;

const KeptKey = Schema.Struct({
  accountId: AccountId,
  digest: Schema.String,
  removed: Schema.optional(Schema.Boolean),
});
const KeyRefusal = Schema.Struct({
  accountId: AccountId,
  use: AccountKeyUse,
  version: Schema.String,
  at: IsoDateTime,
});
const SenderKey = Schema.Struct({ environmentId: EnvironmentId, key: Schema.String });
const ValueRef = Schema.String.check(Schema.isPattern(/^accounts-value-[a-f0-9-]{36}$/));
/** A login's copies at the fill: each with its password then, and which login it was. */
const CopyRefs = Schema.Array(
  Schema.Struct({
    accountId: AccountId,
    ref: Schema.optional(Schema.String),
    identity: Schema.optional(Schema.String),
    /** Its password field's write then (`StoredAccount.revisions`). */
    revision: Schema.optional(Schema.Int),
  }),
);
/**
 * A secret held privately until settled: a page's 2FA key or backup codes until the person saves
 * them to a login, and a form's new password until the site's answer (or the person's).
 */
export const PendingRecord = Schema.Struct({
  pendingId: TrimmedNonEmptyString,
  kind: Schema.Literals(["totp", "recovery", "password"]),
  valueRef: ValueRef,
  /** The value's SHA-256, so the same value held again is the same record. */
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  origin: Schema.String,
  profileId: Schema.optional(BrowserProfileId),
  label: Schema.optional(Schema.String),
  /** A new password's login: a saved row, or a new one to make. */
  accountId: Schema.optional(AccountId),
  login: Schema.optional(
    Schema.Struct({ name: Schema.String, details: AccountSummary.fields.details }),
  ),
  /**
   * The login's password when the new one was made (none: it had none): the answer saves the
   * new one only over that same password, so a newer one is never displaced.
   */
  baseRef: Schema.optional(ValueRef),
  /** That password field's write: a later save, the same value again too, displaces nothing. */
  baseRevision: Schema.optional(Schema.Int),
  /**
   * The login as it was then (its sites, tenant and username, and profile): it must stay so. Its
   * copies then, each with its password: only those, still holding it, take the new one.
   */
  pinnedIdentity: Schema.optional(Schema.String),
  copyRefs: Schema.optional(CopyRefs),
  /** Before its form names the login: each login of the site then, as above. */
  targets: Schema.optional(
    Schema.Array(
      Schema.Struct({
        accountId: AccountId,
        baseRef: Schema.optional(Schema.String),
        baseRevision: Schema.optional(Schema.Int),
        identity: Schema.String,
        copyRefs: CopyRefs,
      }),
    ).check(Schema.isMaxLength(20)),
  ),
  /** Sent for a login not known at the fill (or held by an older build): the person's to answer. */
  unsampled: Schema.optional(Schema.Literal(true)),
  /** Shown to the person from then on, if no answer came by then (an interrupted client). */
  settleBy: Schema.optional(IsoDateTime),
  unclear: Schema.optional(Schema.Literal(true)),
  conflict: Schema.optional(Schema.Literal(true)),
  since: IsoDateTime,
});
/** One password a login held, with the login it was saved for. */
export const PasswordVersion = Schema.Struct({
  ref: ValueRef,
  identity: Schema.String,
  savedAt: Schema.optional(IsoDateTime),
  /** Last held or typed. */
  usedAt: Schema.optional(IsoDateTime),
  /** Last signed in with, as the sign-in's own request answered. */
  provenAt: Schema.optional(IsoDateTime),
  refused: Schema.optional(Schema.Literal(true)),
  /** Saved on a site's word: Scient may submit it by itself until it is refused. */
  auto: Schema.optional(Schema.Literal(true)),
});
const decodePasswordVersion = Schema.decodeUnknownOption(PasswordVersion);
/**
 * Every password a login held, oldest first, without bound. A sign-in's result only orders them:
 * proven first, refused last. One goes only by the person's Remove of it, or with its login's
 * password or the login itself.
 */
const PasswordHistory = Schema.Struct({
  accountId: AccountId,
  versions: Schema.Array(PasswordVersion),
});
/** A history whose one version won't read keeps the others. */
const foldPasswordHistory = (history: unknown) => {
  if (typeof history !== "object" || history === null) return history;
  const { versions } = history as Record<string, unknown>;
  if (!Array.isArray(versions)) return history;
  return {
    ...history,
    versions: versions.filter((version) => Option.isSome(decodePasswordVersion(version))),
  };
};
/** Values a stored record named that didn't read: kept, never deleted (`unreadable`). */
const UnreadableRefs = Schema.Struct({
  list: Schema.String,
  accountId: Schema.optional(Schema.String),
  refs: Schema.Array(ValueRef),
  /** A Custom models escrow record that didn't read: its escrow, by name, held too. */
  escrow: Schema.optional(Schema.String),
});
/** An earlier password the person removed, kept for its Undo's hour, as it was then. */
const RemovedVersion = Schema.Struct({
  undoId: Schema.String,
  accountId: AccountId,
  version: PasswordVersion,
  /** It was the login's Previous (with `previousAt`). */
  previous: Schema.optional(Schema.Literal(true)),
  previousAt: Schema.optional(IsoDateTime),
  until: Schema.Number,
});
/** A password update Undo can take back for its hour, kept across a restart. */
const PasswordReceipt = Schema.Struct({
  undoId: Schema.String,
  accountId: AccountId,
  name: Schema.String,
  until: Schema.Number,
  copies: Schema.Array(
    Schema.Struct({
      accountId: AccountId,
      beforeRef: Schema.optional(ValueRef),
      beforeSecret: Schema.optional(AccountSecretSummary),
      afterRef: ValueRef,
      /** The password field's write that made it (`StoredAccount.revisions`). */
      afterRevision: Schema.optional(Schema.Int),
      /** The write it replaced: an Undo back to it makes this receipt current again. */
      beforeRevision: Schema.optional(Schema.Int),
      /** The login it was then: Undo applies only to that login still. */
      identity: Schema.optional(Schema.String),
    }),
  ),
});
/**
 * A site's automatic submits (each granted once, for one login, settled once) and its failed or
 * limited sign-ins as observed, the past hour's, by registrable domain: its submit budget.
 */
const AutoSubmit = Schema.Struct({
  site: Schema.String,
  at: IsoDateTime,
  attempt: Schema.String,
  accountId: AccountId,
  outcome: Schema.optional(Schema.Literals(["signed-in", "failed"])),
});
const SignInFailure = Schema.Struct({ site: Schema.String, at: IsoDateTime });
/** Round 6's one kept password per login (its last proven), moved into its history on load. */
const Unconfirmed = Schema.Struct({
  accountId: AccountId,
  confirmedRef: ValueRef,
  since: IsoDateTime,
});

/** Round 1's used backup code, one list for all logins (`usedBackupCodes`). */
const UsedBackupCode = Schema.Struct({
  accountId: AccountId,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
/** An escrow this build let go, with why (`escrowJournal`). */
const EscrowJournalEntry = Schema.Struct({
  name: Schema.String,
  /** Dropped from a decoded escrow row by a write, no row or hold naming it still. */
  provenance: Schema.Literal("decoded-row"),
});
export const AccountsState = Schema.Struct({
  format: Schema.Literal(1),
  agentAccess: Schema.Boolean,
  accounts: Schema.Array(StoredAccount),
  migratedModelAccounts: Schema.optional(Schema.Record(CustomModelId, AccountId)),
  detachedKeyLinks: Schema.optional(Schema.Array(AccountKeyLink)),
  customModelEscrows: Schema.optional(Schema.Array(CustomModelEscrow)),
  pendingCustomModelKeys: Schema.optional(Schema.Record(Schema.String, StoredAccount)),
  profiles: Schema.Array(BrowserProfileRecord),
  profileChoices: Schema.optional(BrowserProfileChoices),
  codeSources: Schema.optional(AccountCodeSources),
  /**
   * Code notices for the person's phone, with the rows the relay took off; each is kept a day,
   * cleared or not, and pruned on the next write after that.
   */
  codeNotices: Schema.optional(Schema.Array(AccountCodeNotice)),
  /** "Renew sign-ins automatically"; absent is on. */
  renewAutomatically: Schema.optional(Schema.Boolean),
  needsYou: Schema.optional(Schema.Array(AccountNeedsYou)),
  /** Accounts' Sign out, per profile and site, so nothing signs back in by itself. */
  signedOut: Schema.optional(Schema.Array(SignOut)),
  /** When renewal last finished a turn for each row, so its schedule survives restarts. */
  renewedAt: Schema.optional(Schema.Record(Schema.String, IsoDateTime)),
  /** Read one by one (`readTaskPins`): a pin that can't be read blocks its task, not the state. */
  taskPins: Schema.optional(Schema.Array(Schema.Unknown)),
  /** Rows renewal only looked at with nobody there and found signed out: first once someone is. */
  deferredRenewals: Schema.optional(Schema.Array(Schema.String)),
  /** Whether each row's last sign-in asked for a code no saved key answered (or a push). */
  signInCodes: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  /**
   * The second step each row's last sign-in seen from its first page met: none, only the saved
   * authenticator key, or a code or push sent to the person. Read before `signInCodes`.
   */
  signInFactors: Schema.optional(
    Schema.Record(Schema.String, Schema.Literals(["none", "totp", "code"])),
  ),
  keyLinks: Schema.optional(Schema.Array(AccountKeyLink)),
  removedLogins: Schema.optional(Schema.Array(RemovedLogin)),
  /**
   * Typed keys kept in a row for their use, by the typed value's digest; never sent to a client.
   * A removed row stays removed for that value, so its typed copy is never used again.
   */
  keptKeys: Schema.optional(Schema.Array(KeptKey)),
  /** What agents changed (AMENDMENTS 56), the newest 200. */
  changes: Schema.optional(Schema.Array(AccountChange)),
  /** Each desktop's browser profiles to import from, as it last reported them (AMENDMENTS 58). */
  sourceProfiles: Schema.optional(Schema.Array(SourceProfilesEntry)),
  /** Profiles' Remove, Clear and sign-out receipts (round 6b), the newest 200. */
  profileOperations: Schema.optional(Schema.Array(ProfileOperation)),
  /** Purges authorized (`purgedAt`) whose deletion in this server's browser hasn't succeeded yet. */
  pendingPurges: Schema.optional(Schema.Array(PendingPurge)),
  /** A sign-out's cookies from this server's browser, kept encrypted for its Undo hour. */
  signOutSaves: Schema.optional(Schema.Array(SignOutSave)),
  /** Uses whose provider refused a key, by the stored value they refused. */
  keyRefusals: Schema.optional(Schema.Array(KeyRefusal)),
  onePassword: Schema.optional(
    Schema.Union([
      Schema.Struct({
        mode: Schema.Literal("service-account"),
        tokenRef: Schema.String.check(Schema.isPattern(/^accounts-value-[a-f0-9-]{36}$/)),
      }),
      Schema.Struct({ mode: Schema.Literal("desktop"), accountName: Schema.String }),
    ]),
  ),
  onePasswordStatus: OnePasswordStatus,
  /** On a remote: desktops sending sign-ins here, each proven by a key only it holds. */
  senders: Schema.optional(Schema.Array(RemoteSender)),
  /** How each recent Accounts card ended, by its request id, so a card says so after a restart. */
  cards: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Literals(["saved", "failed", "declined", "cancelled", "timed_out"]),
    ),
  ),
  /** The row a saved card's value went into, by request id, so the card links to it. */
  cardAccounts: Schema.optional(Schema.Record(Schema.String, AccountId)),
  /** When each login (by attempt key) last spent its one daily sign-in fallback. */
  fallbacks: Schema.optional(Schema.Record(Schema.String, IsoDateTime)),
  /** Sites where the person said not to offer saving a sign-in. */
  neverAsk: Schema.optional(Schema.Array(Schema.String)),
  /** On the desktop: the key each other computer issued it as a sender. */
  senderKeys: Schema.optional(Schema.Array(SenderKey)),
  /** University sign-outs whose targets aren't all cleared yet, kept across a restart. */
  universitySignOuts: Schema.optional(Schema.Array(UniversitySignOut)),
  /** The last sign-out's `seq`: a newer one always counts higher, after the older is gone. */
  universitySignOutSeq: Schema.optional(Schema.Int),
  /**
   * Secrets held privately until settled: a page's 2FA key or backup codes until the person saves
   * them to a login, and a form's new password until the site's answer (or the person's).
   */
  pending: Schema.optional(Schema.Array(PendingRecord).check(Schema.isMaxLength(200))),
  /**
   * Round 1's used backup codes, one list for all logins: moved onto their logins on load
   * (`StoredAccount.usedCodes`) and dropped.
   */
  usedBackupCodes: Schema.optional(Schema.Array(UsedBackupCode)),
  /** Each login's passwords (`PasswordHistory`). */
  passwordHistory: Schema.optional(Schema.Array(PasswordHistory)),
  /** Password Undos still in their hour. */
  passwordUndos: Schema.optional(Schema.Array(PasswordReceipt)),
  /** Earlier passwords the person removed, for their Undo's hour. */
  removedVersions: Schema.optional(Schema.Array(RemovedVersion)),
  autoSubmits: Schema.optional(Schema.Array(AutoSubmit)),
  signInFailures: Schema.optional(Schema.Array(SignInFailure)),
  /** Values nothing refers to any more whose deletion hasn't been seen to finish: tried again. */
  unreferenced: Schema.optional(Schema.Array(ValueRef)),
  /**
   * Escrow names an earlier build journaled (round 17's orphans among them), with no record of
   * why: quarantined, never swept.
   */
  unreferencedEscrows: Schema.optional(Schema.Array(Schema.String)),
  /** Custom models escrows this build let go, each with why: only these are swept. */
  escrowJournal: Schema.optional(Schema.Array(EscrowJournalEntry)),
  /**
   * Values a record named that didn't read (each by its list, and its login if it said): never
   * deleted, until the login they belonged to is removed.
   */
  unreadable: Schema.optional(Schema.Array(UnreadableRefs)),
  /** Round 6's kept passwords: moved into `passwordHistory` on load, then dropped. */
  unconfirmed: Schema.optional(Schema.Array(Unconfirmed)),
});
export type AccountsState = typeof AccountsState.Type;
export const emptyState: AccountsState = {
  format: 1,
  agentAccess: true,
  accounts: [],
  profiles: [],
  onePasswordStatus: { state: "not-connected" },
};
export const Activity = Schema.Array(AccountActivityEntry);

export class AccountPersistence extends Context.Service<
  AccountPersistence,
  {
    readonly read: (
      name: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<Uint8Array>>, AccountsError>;
    readonly write: (
      name: string,
      value: Redacted.Redacted<Uint8Array>,
    ) => Effect.Effect<void, AccountsError>;
    /** Deletes a stored value: only the sweep calls it (`sweepUnreferenced`). */
    readonly remove: (name: string) => Effect.Effect<void, AccountsError>;
    /** Deletes a Custom models escrow (its own namespace); never a value. */
    readonly removeEscrow: (name: string) => Effect.Effect<void, AccountsError>;
    /** The store's temporary files a cut-short write left, reclaimed once old enough. */
    readonly reclaimTemporary: Effect.Effect<void>;
    /** Whether a record was ever stored, without opening the vault. */
    readonly exists: (name: string) => Effect.Effect<boolean, AccountsError>;
  }
>()("t3/scient/accounts/AccountPersistence") {}

export const layer = Layer.effect(
  AccountPersistence,
  Effect.gen(function* () {
    const store = yield* ServerSecretStore;
    const vault = yield* AccountVault;
    const unavailable = () =>
      new AccountsError({
        reason: "unavailable",
        message: "Scient Accounts data could not be persisted.",
      });
    return AccountPersistence.of({
      read: Effect.fn("AccountPersistence.read")(function* (name) {
        const stored = yield* store.get(name).pipe(Effect.mapError(unavailable));
        return Option.isNone(stored)
          ? Option.none()
          : Option.some(yield* vault.decrypt(name, stored.value));
      }),
      write: Effect.fn("AccountPersistence.write")(function* (name, value) {
        yield* store
          .set(name, yield* vault.encrypt(name, value))
          .pipe(Effect.mapError(unavailable));
      }),
      remove: Effect.fn("AccountPersistence.remove")((name) =>
        store.remove(name).pipe(Effect.mapError(unavailable)),
      ),
      removeEscrow: Effect.fn("AccountPersistence.removeEscrow")((name) =>
        /^accounts-model-escrow-v1-[a-zA-Z0-9_-]{1,80}$/.test(name)
          ? store.remove(name).pipe(Effect.mapError(unavailable))
          : Effect.fail(new AccountsError({ reason: "invalid-input", message: "Not an escrow." })),
      ),
      reclaimTemporary: store.reclaimTemporary ?? Effect.void,
      exists: Effect.fn("AccountPersistence.exists")((name) =>
        store.get(name).pipe(Effect.map(Option.isSome), Effect.mapError(unavailable)),
      ),
    });
  }),
);

/** Library accounts became website accounts carrying a library link. */
const foldLibraryDetails = (summary: Record<string, unknown>) => {
  const details = summary["details"] as { kind?: unknown } | undefined;
  return details?.kind === "library"
    ? { ...summary, details: { ...details, kind: "website" } }
    : summary;
};

const REFUSED_OUTCOMES: ReadonlySet<unknown> = new Set(["password-rejected", "code-rejected"]);

/**
 * Sign-ins were kept in `lastSignInOutcome` (Scient's last attempt) and `lastCheck` (what it last
 * saw), now one `signIn`. A refusal wins, as it outlasted every check; otherwise the check, which
 * was the newer of the two; otherwise the attempt, dated by the account's last save.
 */
const foldSignInFields = (summary: Record<string, unknown>) => {
  if (!("lastSignInOutcome" in summary || "lastCheck" in summary || "signedOut" in summary))
    return summary;
  const { lastSignInOutcome: outcome, lastCheck, signedOut: _signedOut, ...rest } = summary;
  const check = lastCheck as { state?: unknown; at?: unknown; message?: unknown } | undefined;
  const signIn = REFUSED_OUTCOMES.has(outcome)
    ? {
        state: outcome,
        at: check?.at ?? rest["updatedAt"],
        ...(check?.state === "rejected" && check.message ? { detail: check.message } : {}),
      }
    : check
      ? {
          // Only a refused key was "rejected" without a refused attempt.
          state: check.state === "rejected" ? "failed" : check.state,
          at: check.at,
          ...(check.message ? { detail: check.message } : {}),
        }
      : outcome
        ? { state: outcome === "needs-user" ? "needs-you" : outcome, at: rest["updatedAt"] }
        : undefined;
  // A sign-in that worked was a fact about the saved password; it now lives on the password.
  const secrets = rest["secrets"] as Record<string, object> | undefined;
  const password = secrets?.["password"];
  const verified =
    outcome === "signed-in" && password
      ? {
          secrets: {
            ...secrets,
            password: { ...password, verifiedAt: check?.at ?? rest["updatedAt"] },
          },
        }
      : {};
  return signIn ? { ...rest, ...verified, signIn } : { ...rest, ...verified };
};

const ORIGIN_PREFIXES = [
  ["Imported from", "import"],
  ["Copied from", "copy"],
] as const;

/** Imported and copied rows once said so only at the start of their detail; now in `from`. */
const foldSignInOrigin = (summary: Record<string, unknown>) => {
  const signIn = summary["signIn"] as
    | { state?: unknown; detail?: unknown; from?: unknown }
    | undefined;
  if (signIn?.state !== "unknown" || signIn.from !== undefined) return summary;
  const { detail } = signIn;
  const from = ORIGIN_PREFIXES.find(
    ([prefix]) => typeof detail === "string" && detail.startsWith(prefix),
  )?.[1];
  return from ? { ...summary, signIn: { ...signIn, from } } : summary;
};

/** Main's sign-outs and back-fill were fields of its profile record; they are its `main` now. */
const foldMainFields = (profile: unknown) => {
  if (typeof profile !== "object" || profile === null) return profile;
  if (!("signedOutSites" in profile || "backfilled" in profile)) return profile;
  const { signedOutSites, backfilled, ...rest } = profile as Record<string, unknown>;
  const existing = (rest["main"] ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    main: {
      ...(signedOutSites === undefined ? {} : { signedOutSites }),
      ...(backfilled === undefined ? {} : { backfilled }),
      ...existing,
    },
  };
};

const oldAccountSite = Schema.is(AccountSite);

function foldModelOrigins(summary: Record<string, unknown>) {
  const details = summary["details"];
  if (
    typeof details !== "object" ||
    details === null ||
    !("purpose" in details) ||
    details.purpose !== "custom-models" ||
    !("modelOrigins" in details) ||
    !Array.isArray(details.modelOrigins)
  )
    return summary;
  return { ...summary, details: { ...details, sites: details.modelOrigins } };
}

function encodeModelOrigins(account: StoredAccount): StoredAccount {
  const { summary } = account;
  const details = summary.details;
  if (details.kind !== "api-key" || details.purpose !== "custom-models") return account;
  // An older reader ignores this field and validates only the site spellings it understands.
  const compatible = {
    ...details,
    sites: details.sites.filter(oldAccountSite),
    modelOrigins: details.sites,
  };
  return { ...account, summary: { ...summary, details: compatible } };
}

export const customModelEscrowName = (legacyId: string) => `accounts-model-escrow-v1-${legacyId}`;

/** Causes rounds 6f and 6m removed (the cross-computer import, the refresh's Undo copy): read as a failure with no cause. */
const REMOVED_CAUSES = new Set(["notShared", "elsewhere", "ownerOff", "noCopy"]);
const withoutRemovedCause = (part: unknown) => {
  if (typeof part !== "object" || part === null || !("cause" in part)) return part;
  if (!REMOVED_CAUSES.has(String(part.cause))) return part;
  const { cause: _, ...rest } = part;
  return rest;
};
const foldOperation = (operation: unknown) => {
  if (typeof operation !== "object" || operation === null) return operation;
  const op = operation as Record<string, unknown>;
  const others = (list: unknown) =>
    Array.isArray(list)
      ? list.map((part) =>
          typeof part === "object" && part !== null
            ? { ...part, outcome: withoutRemovedCause((part as { outcome?: unknown }).outcome) }
            : part,
        )
      : list;
  const undone = op.undone as Record<string, unknown> | undefined;
  // A refresh's Undo, from before round 6m removed it, still under way: settled as failed, so
  // no store carries it out. One that ended stays as it ended (round 6n).
  const undonePart = (part: unknown) => {
    const read = withoutRemovedCause(part);
    return op.kind === "refresh" &&
      typeof read === "object" &&
      read !== null &&
      (read as { state?: unknown }).state === "pending"
      ? { ...read, state: "failed" }
      : read;
  };
  const undoneOthers = (list: unknown) =>
    Array.isArray(list)
      ? list.map((part) =>
          typeof part === "object" && part !== null
            ? { ...part, outcome: undonePart((part as { outcome?: unknown }).outcome) }
            : part,
        )
      : list;
  return {
    ...op,
    ...("server" in op ? { server: withoutRemovedCause(op.server) } : {}),
    ...("desktop" in op ? { desktop: withoutRemovedCause(op.desktop) } : {}),
    ...("others" in op ? { others: others(op.others) } : {}),
    ...(undone && typeof undone === "object"
      ? {
          undone: {
            ...undone,
            ...("server" in undone ? { server: undonePart(undone.server) } : {}),
            ...("desktop" in undone ? { desktop: undonePart(undone.desktop) } : {}),
            ...("others" in undone ? { others: undoneOthers(undone.others) } : {}),
          },
        }
      : {}),
  };
};
/**
 * Every list of the state: a record that no longer reads is dropped on its own (rounds 6h, 6i),
 * a desktop's browser profile within its report too, and a list that isn't one reads as empty.
 * One bad record never keeps the whole state, and so every account, from opening.
 */
const READABLE_LISTS: ReadonlyArray<readonly [string, Schema.Top]> = [
  ["accounts", StoredAccount],
  ["profiles", BrowserProfileRecord],
  ["detachedKeyLinks", AccountKeyLink],
  ["customModelEscrows", CustomModelEscrow],
  ["needsYou", AccountNeedsYou],
  ["signedOut", SignOut],
  ["keyLinks", AccountKeyLink],
  ["removedLogins", RemovedLogin],
  ["keptKeys", KeptKey],
  ["changes", AccountChange],
  ["sourceProfiles", SourceProfilesEntry],
  ["profileOperations", ProfileOperation],
  ["pendingPurges", PendingPurge],
  ["signOutSaves", SignOutSave],
  ["keyRefusals", KeyRefusal],
  ["senders", RemoteSender],
  ["neverAsk", Schema.String],
  ["senderKeys", SenderKey],
  ["universitySignOuts", UniversitySignOut],
  ["pending", PendingRecord],
  ["passwordHistory", PasswordHistory],
  ["passwordUndos", PasswordReceipt],
  ["removedVersions", RemovedVersion],
  ["autoSubmits", AutoSubmit],
  ["signInFailures", SignInFailure],
  ["unconfirmed", Unconfirmed],
  ["unreadable", UnreadableRefs],
  ["usedBackupCodes", UsedBackupCode],
  ["unreferenced", ValueRef],
  ["unreferencedEscrows", Schema.String],
  ["escrowJournal", EscrowJournalEntry],
  ["codeNotices", AccountCodeNotice],
  ["taskPins", Schema.Unknown],
  ["deferredRenewals", Schema.String],
];
/** The lists read record by record: every list of the state must be one (`readableLists.test`). */
export const READABLE_LIST_NAMES: ReadonlySet<string> = new Set(READABLE_LISTS.map(([key]) => key));
const READERS = READABLE_LISTS.map(
  ([key, schema]) =>
    [key, Schema.decodeUnknownOption(schema as Schema.Codec<unknown, unknown>)] as const,
);
const readsSource = Schema.decodeUnknownOption(BrowserSourceProfile);
/** Lists the state can't open without: one that isn't a list reads as empty, never as missing. */
const REQUIRED_LISTS = new Set(["accounts", "profiles"]);
/** One record of a list as today's, before it is read: each list's own fold, if it has one. */
const prepare = (key: string, item: unknown) =>
  key === "profileOperations"
    ? safely(foldOperation)(item)
    : key === "sourceProfiles"
      ? safely(readableSources)(item)
      : key === "pending"
        ? safely(foldPending)(item)
        : key === "passwordHistory"
          ? safely(foldPasswordHistory)(item)
          : item;
/** The marker a stored pin list that isn't one is kept under. */
const UNREADABLE_PIN_LIST = "unreadablePinList";
const readableLists = (state: Record<string, unknown>) => {
  const lists: Record<string, ReadonlyArray<unknown> | undefined> = {};
  for (const [key, reads] of READERS) {
    if (!(key in state)) continue;
    const list = state[key];
    if (!Array.isArray(list)) {
      // A pin list that isn't one may still hold a task's pin: kept whole under its marker, the
      // list's one entry, which reads as no task's pin and as any task's (`taskPinIn`).
      lists[key] = REQUIRED_LISTS.has(key)
        ? []
        : key === "taskPins"
          ? [{ [UNREADABLE_PIN_LIST]: list }]
          : undefined;
      continue;
    }
    lists[key] = list
      .map((item) => prepare(key, item))
      .filter((item) => Option.isSome(reads(item)));
  }
  return lists;
};
/**
 * The stored records, each as stored, by record, never by list: those a read drops (and the
 * entries within one), and those it reads beside what they read as. Every value a dropped one
 * names, or a read one names that its reading doesn't (a field this build doesn't know), stays
 * held, whatever else names it (`unreadable`).
 */
export const storedRecords = (
  stored: unknown,
): {
  readonly dropped: ReadonlyArray<{ list: string; record: unknown; within?: unknown }>;
  readonly read: ReadonlyArray<{ list: string; record: unknown; decoded: unknown }>;
} => {
  const dropped: Array<{ list: string; record: unknown; within?: unknown }> = [];
  const read: Array<{ list: string; record: unknown; decoded: unknown }> = [];
  if (typeof stored !== "object" || stored === null || !("accounts" in stored))
    return { dropped, read };
  const raw = foldPasswordSets(stored);
  const folded = foldStoredAccounts(stored);
  if (typeof folded !== "object" || folded === null) return { dropped, read };
  const lists = new Map(Object.entries(folded));
  for (const [key, reads] of READERS) {
    if (!(key in raw)) continue;
    const original = raw[key];
    const list = lists.get(key);
    if (!Array.isArray(list) || !Array.isArray(original)) {
      dropped.push({ list: key, record: original });
      continue;
    }
    list.forEach((item, index) => {
      const record = original[index];
      const prepared = prepare(key, item);
      const decoded = reads(prepared);
      if (Option.isNone(decoded)) return void dropped.push({ list: key, record });
      // Within a record that reads: a history's versions, a report's profiles and an older
      // build's pending targets (its fold discards them) that don't.
      const entries =
        key === "passwordHistory"
          ? "versions"
          : key === "sourceProfiles"
            ? "sources"
            : key === "pending"
              ? "targets"
              : undefined;
      const inner =
        entries && typeof record === "object" && record !== null && entries in record
          ? Reflect.get(record, entries)
          : undefined;
      const kept =
        entries && typeof prepared === "object" && prepared !== null && entries in prepared
          ? Reflect.get(prepared, entries)
          : undefined;
      if (!entries || !Array.isArray(inner))
        return void read.push({ list: key, record, decoded: decoded.value });
      const reading = new Set(
        Array.isArray(kept) ? kept.map((entry) => JSON.stringify(entry)) : [],
      );
      for (const entry of inner)
        if (!reading.has(JSON.stringify(entry)))
          dropped.push({ list: key, record: entry, within: record });
      // The rest of the record, its dropped entries aside (each held with its own login).
      read.push({
        list: key,
        record: {
          ...(record as object),
          [entries]: inner.filter((entry) => reading.has(JSON.stringify(entry))),
        },
        decoded: decoded.value,
      });
    });
  }
  return { dropped, read };
};
/** The state read as today's, then each list's records one by one. */
const readableState = (state: unknown) => {
  if (typeof state !== "object" || state === null || !("accounts" in state)) return state;
  const lists = readableLists(state as Record<string, unknown>);
  // The links of profiles that read, then made one per browser profile.
  const profiles = lists["profiles"];
  return { ...state, ...lists, ...(profiles ? { profiles: soleLinks(profiles) } : {}) };
};
/**
 * A desktop's report keeps every browser profile in it that still reads; a list of them that
 * isn't one reads as none, and the report stays (round 6j).
 */
const readableSources = (entry: unknown) => {
  if (typeof entry !== "object" || entry === null) return entry;
  const sources = (entry as { sources?: unknown }).sources;
  return {
    ...entry,
    sources: Array.isArray(sources)
      ? sources.filter((source) => Option.isSome(readsSource(source)))
      : [],
  };
};

/**
 * Two Scient profiles linked to one browser profile, as before round 6h: one link stays, the
 * others go, so a browser profile links to one Scient profile. Only records that read take part
 * (round 6j), matched by the one link rule, so a link made before folders or desktops were kept
 * meets its newer form. A profile in use is preferred over a removed one, then the newest link.
 */
const readsProfile = Schema.decodeUnknownOption(BrowserProfileRecord);
/**
 * Matched as each record reads (round 6k): a folder or name stored with spaces is the same one
 * once read. The stored rows are kept as they are; only their links are compared as read.
 */
const soleLinks = (profiles: ReadonlyArray<unknown>) => {
  const read = new Map(
    profiles.flatMap((row) => {
      const decoded = readsProfile(row);
      return Option.isSome(decoded) ? [[row, decoded.value] as const] : [];
    }),
  );
  const rank = (profile: BrowserProfileRecord) =>
    `${profile.removed || profile.retired ? 0 : 1}:${profile.source?.importedAt ?? ""}`;
  const best = [...read]
    .filter(([, profile]) => profile.source !== undefined)
    .toSorted(([, a], [, b]) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? 1 : -1));
  const links: Array<NonNullable<BrowserProfileRecord["source"]>> = [];
  const keep = new Set<unknown>();
  for (const [row, profile] of best) {
    const link = profile.source!;
    const taken = links.some((held) =>
      linksBrowserProfile(held, {
        browser: link.browser,
        name: link.profileName,
        directory: link.directory,
        computerId: link.computer?.id,
      }),
    );
    if (taken) continue;
    links.push(link);
    keep.add(row);
  }
  return profiles.map((row) => {
    if (!read.get(row)?.source || keep.has(row)) return row;
    const { source: _, ...unlinked } = row as Record<string, unknown>;
    return unlinked;
  });
};

/** A row's fold that throws leaves the row as stored: reading it then decides (round 6j). */
const safely =
  <A>(fold: (row: A) => unknown) =>
  (row: A) => {
    try {
      return fold(row);
    } catch {
      return row;
    }
  };
const foldAccount = (account: { summary?: Record<string, unknown> } | null) => {
  const summary = account?.summary;
  if (typeof summary !== "object" || summary === null) return account;
  return {
    ...account,
    summary: foldModelOrigins(foldSignInOrigin(foldSignInFields(foldLibraryDetails(summary)))),
  };
};

/**
 * Held secrets as an older build wrote them (a new password pinned by username, its site's
 * logins without their identity) are the person's to confirm, their values kept.
 */
const foldPending = (record: unknown) => {
  if (typeof record !== "object" || record === null) return record;
  const { pinnedUser, targets, ...rest } = record as Record<string, unknown>;
  const legacy =
    pinnedUser !== undefined ||
    (Array.isArray(targets) &&
      targets.some(
        (target) =>
          typeof target !== "object" ||
          target === null ||
          !("identity" in target) ||
          !("copyRefs" in target),
      ));
  return legacy ? { ...rest, unsampled: true } : record;
};

/**
 * Rounds 7 and 8 kept only the passwords no sign-in had settled (`passwordSets`), round 7 naming
 * their login once per set: each becomes the login's history.
 */
const foldPasswordSets = (state: object) => {
  const { passwordSets, ...rest } = state as Record<string, unknown>;
  if (!Array.isArray(passwordSets) || "passwordHistory" in rest) return rest;
  const passwordHistory = passwordSets.map((set) => {
    if (typeof set !== "object" || set === null) return set;
    const { accountId, identity, refs } = set as Record<string, unknown>;
    return {
      accountId,
      versions: (Array.isArray(refs) ? refs : []).map((entry) => {
        if (typeof entry !== "object" || entry === null) return entry;
        const { ref, refused, identity: own } = entry as Record<string, unknown>;
        return { ref, identity: own ?? identity, auto: true, ...(refused ? { refused } : {}) };
      }),
    };
  });
  return { ...rest, passwordHistory };
};

/** Older stored shapes, read as today's before decoding: each row on its own. */
export const foldStoredAccounts = (stored: unknown): unknown => {
  if (typeof stored !== "object" || stored === null || !("accounts" in stored)) return stored;
  const state = foldPasswordSets(stored);
  // Not a list: read as none, never as a state that doesn't open (round 6i).
  const accounts: ReadonlyArray<{ summary?: Record<string, unknown> } | null> = Array.isArray(
    stored.accounts,
  )
    ? stored.accounts
    : [];
  const profiles =
    "profiles" in state && Array.isArray(state["profiles"]) ? state["profiles"] : undefined;
  return {
    ...state,
    ...(profiles ? { profiles: profiles.map(safely(foldMainFields)) } : {}),
    accounts: accounts.map(safely(foldAccount)),
  };
};

export const withStoredAccountsFolded = (bytes: Redacted.Redacted<Uint8Array>) => {
  const text = new TextDecoder().decode(Redacted.value(bytes));
  try {
    return Redacted.make(
      new TextEncoder().encode(JSON.stringify(readableState(foldStoredAccounts(JSON.parse(text))))),
    );
  } catch {
    // Unreadable data keeps its own error from the decoder that follows.
    return bytes;
  }
};

export const decodePrivateJson = <A, E>(
  schema: Schema.Codec<A, E>,
  bytes: Redacted.Redacted<Uint8Array>,
) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(
    new TextDecoder().decode(Redacted.value(bytes)),
  ).pipe(
    Effect.mapError(
      () =>
        new AccountsError({
          reason: "unavailable",
          message: "Stored Scient Accounts data is unreadable.",
        }),
    ),
  );
export const encodePrivateJson = <A, E>(schema: Schema.Codec<A, E>, value: A) =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.map((json) => Redacted.make(new TextEncoder().encode(json))),
    Effect.mapError(
      () =>
        new AccountsError({
          reason: "unavailable",
          message: "Scient Accounts data could not be encoded.",
        }),
    ),
  );

// Validate the live shape first. Its on-disk representation also admits the previous release.
export const encodeAccountsState = (state: AccountsState) =>
  encodePrivateJson(AccountsState, state).pipe(
    Effect.map(() =>
      Redacted.make(
        new TextEncoder().encode(
          JSON.stringify({
            ...state,
            accounts: state.accounts.map(encodeModelOrigins),
          }),
        ),
      ),
    ),
  );
