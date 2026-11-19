import {
  AccountCodeSources,
  AccountKeyLink,
  BrowserProfileChoices,
  AccountsError,
  AccountSummary,
  AccountWriteStore,
  BrowserProfileRecord,
  AccountActivityEntry,
  EnvironmentId,
  IsoDateTime,
  OnePasswordStatus,
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
export const AccountsState = Schema.Struct({
  format: Schema.Literal(1),
  agentAccess: Schema.Boolean,
  accounts: Schema.Array(StoredAccount),
  profiles: Schema.Array(BrowserProfileRecord),
  profileChoices: Schema.optional(BrowserProfileChoices),
  codeSources: Schema.optional(AccountCodeSources),
  keyLinks: Schema.optional(Schema.Array(AccountKeyLink)),
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
  /** On the desktop: the key each other computer issued it as a sender. */
  senderKeys: Schema.optional(
    Schema.Array(Schema.Struct({ environmentId: EnvironmentId, key: Schema.String })),
  ),
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
    readonly remove: (name: string) => Effect.Effect<void, AccountsError>;
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

/** Older stored shapes, read as today's before decoding. */
export const foldStoredAccounts = (state: unknown): unknown => {
  if (typeof state !== "object" || state === null || !("accounts" in state)) return state;
  if (!Array.isArray(state.accounts)) return state;
  const profiles =
    "profiles" in state && Array.isArray(state.profiles) ? state.profiles : undefined;
  return {
    ...state,
    ...(profiles ? { profiles: profiles.map(foldMainFields) } : {}),
    accounts: state.accounts.map((account) => {
      const summary = account?.summary;
      if (typeof summary !== "object" || summary === null) return account;
      return {
        ...account,
        summary: foldSignInOrigin(foldSignInFields(foldLibraryDetails(summary))),
      };
    }),
  };
};

export const withStoredAccountsFolded = (bytes: Redacted.Redacted<Uint8Array>) => {
  const text = new TextDecoder().decode(Redacted.value(bytes));
  try {
    return Redacted.make(
      new TextEncoder().encode(JSON.stringify(foldStoredAccounts(JSON.parse(text)))),
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
