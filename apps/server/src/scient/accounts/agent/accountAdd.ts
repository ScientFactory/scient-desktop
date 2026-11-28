// @effect-diagnostics nodeBuiltinImport:off -- Card request ids use the operating system CSPRNG.
import {
  isLogin,
  loginCandidates,
  loginSiteKey,
  loginTenant,
  loginUserKey,
} from "@t3tools/shared/scientLoginIdentity";
import * as NodeCrypto from "node:crypto";
import {
  AccountsError,
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountId,
  type AccountSaveResult,
  type AccountSummary,
} from "@t3tools/contracts";
import { FetchHttpClient } from "effect/http";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { formatAccountLink } from "@t3tools/shared/scientAccountLinks";
import {
  accountSecretRequestId,
  type AccountSecretKind,
} from "@t3tools/shared/scientAccountSecretRequest";
import { searchUniversities } from "../../papers/universityDirectory.ts";
import { continueWaitingPapers } from "../../papers/getPaper.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { accountUsage } from "./accountUse.ts";
import { guardedSignIn } from "./guardedSignIn.ts";
import { accountSessionScope } from "./scope.ts";
import type { ScientAccountsToolkit } from "./tools.ts";
import {
  CARD_RETURN_MS,
  CurrentCardAllowance,
  MIN_CARD_MS,
  personTimeLeft,
  startAllowance,
  withCardAllowance,
} from "./cardAllowance.ts";

type Input = Schema.Schema.Type<
  (typeof ScientAccountsToolkit.tools)["scient_account_add"]["parametersSchema"]
>;

const MAX_VALUE = 65_536;
const fail = (message: string) => new AccountsError({ reason: "unavailable", message });
const host = (site: string) => site.replace(/^https:\/\//, "").replace(/:\d+$/, "");

/** An Off account the agent needs: the person's card may turn it on for agents. */
const turnedOn = Effect.fn("AccountsAgent.turnedOn")(function* (
  scope: AccountSessionScope,
  account: AccountSummary,
) {
  const target = { type: "account" as const, accountId: account.accountId };
  const decided = yield* (yield* AccountsService).authorize(scope, target, "credentials", {
    waitMs: yield* personTimeLeft,
  });
  return decided.decision === "allowed";
});

/**
 * One value from the user through upstream's private secret card, read once on the server: it
 * never reaches the agent. Any status but `saved` is the user's answer (declined, timed out…).
 * The card gets what is left of the call's allowance; none opens once it is spent.
 */
export const askInCard = Effect.fn("AccountsAgent.askInCard")(function* (
  scope: AccountSessionScope,
  card: {
    readonly label: string;
    readonly reason: string;
    readonly placeholder?: string;
    /** What the agent reads when the value could not be read. */
    readonly notKept: string;
    /** What the card saves, for its few-word note; a key unless named. */
    readonly kind?: AccountSecretKind;
  },
) {
  if (scope.projectId === undefined) return yield* fail(card.notKept);
  const invocation = yield* McpInvocationContext;
  const accounts = yield* AccountsService;
  // Nobody was there to save it: it waits for the person in Needs you, once per card and chat.
  const needId = `save:${scope.threadId}:${card.label}`.slice(0, 200);
  const unanswered = <S extends "cancelled" | "timed_out">(status: S) =>
    (status === "timed_out"
      ? accounts
          .setNeedsYou({
            needId,
            name: card.label.slice(0, 120),
            detail: "Waiting for you to save it",
            action: "save",
            threadId: scope.threadId,
          })
          .pipe(Effect.ignore)
      : Effect.void
    ).pipe(Effect.as({ status }));
  const allowance = (yield* CurrentCardAllowance) ?? (yield* startAllowance);
  const ended = yield* Ref.get(allowance.ended);
  if (ended !== undefined) return yield* unanswered(ended);
  const left = allowance.deadline - (yield* Clock.currentTimeMillis) - CARD_RETURN_MS;
  if (left < MIN_CARD_MS) {
    yield* Ref.set(allowance.ended, "timed_out");
    return yield* unanswered("timed_out" as const);
  }
  const requestId = accountSecretRequestId(card.kind ?? "key", NodeCrypto.randomUUID());
  yield* accounts.startCard(requestId);
  const asked = yield* (yield* OrchestratorMcpService)
    .requestSecret(invocation, {
      label: card.label,
      reason: card.reason,
      ...(card.placeholder === undefined ? {} : { placeholder: card.placeholder }),
      clientRequestId: requestId,
      timeoutMs: Math.floor(left),
    })
    .pipe(
      Effect.mapError((error) => fail(error.message)),
      Effect.tapError(() => accounts.recordCard(requestId, "failed")),
      Effect.onInterrupt(() => accounts.recordCard(requestId, "failed")),
    );
  if (asked.status === "cancelled" || asked.status === "timed_out") {
    yield* Ref.set(allowance.ended, asked.status);
  }
  if (asked.status !== "saved") {
    yield* accounts.recordCard(requestId, asked.status);
    if (asked.status === "timed_out") yield* unanswered(asked.status);
    return { status: asked.status };
  }
  const projectId = scope.projectId;
  const value = yield* Effect.gen(function* () {
    if (!("secretRef" in asked)) return yield* fail(card.notKept);
    const read = (yield* (yield* SecretRequests)
      .consume({ ref: asked.secretRef, projectId })
      .pipe(Effect.mapError(() => fail(card.notKept)))).trim();
    if (read.length === 0 || read.length > MAX_VALUE)
      return yield* fail(`${card.notKept} It was empty or longer than ${MAX_VALUE} characters.`);
    return read;
  }).pipe(
    Effect.tapError(() => accounts.recordCard(requestId, "failed")),
    Effect.onInterrupt(() => accounts.recordCard(requestId, "failed")),
  );
  yield* accounts.clearNeedsYou(needId).pipe(Effect.ignore);
  return { status: "saved" as const, value, requestId };
});

/** The card says Saved once what its value went into committed, and Not saved if it failed. */
const settleCard = Effect.fn("AccountsAgent.settleCard")(function* <
  A extends { readonly accountId: AccountId },
  E,
  R,
>(requestId: string, keep: Effect.Effect<A, E, R>) {
  const accounts = yield* AccountsService;
  return yield* keep.pipe(
    Effect.tap(({ accountId }) => accounts.recordCard(requestId, "saved", accountId)),
    Effect.tapError(() => accounts.recordCard(requestId, "failed")),
    // A save cut short never leaves the card saying Saving…: it wasn't kept.
    Effect.onInterrupt(() => accounts.recordCard(requestId, "failed")),
  );
});

/**
 * What a card that ended without a value means for the agent. A timeout or a closed card is not
 * the user's answer, but the card is gone: it is not opened again this turn unless they ask.
 */
export const cardEndedNote = (status: "declined" | "cancelled" | "timed_out"): string =>
  status === "declined"
    ? "The user chose not to enter it. Don't ask again this turn or in chat."
    : status === "timed_out"
      ? "This call's time for the user's answer ran out, and no card is open. Don't open it again this turn unless the user asks."
      : "The card closed before the user answered. Don't open it again this turn unless the user asks.";

/**
 * Keeps an API key as a new row, or in the row named by `accountId`; never as another row of the
 * service. A `value` the agent has is saved as is; otherwise the private card asks the person.
 */
export const askForAccountKey = Effect.fn("AccountsAgent.askForKey")(function* (
  scope: AccountSessionScope,
  input: Input,
) {
  const accounts = yield* AccountsService;
  const session = yield* accounts.forSession(scope);
  if (!session.agentAccess)
    return {
      status: "unavailable" as const,
      message:
        "Agent access to Accounts is off. The user can turn it on in Settings → Accounts & secrets.",
    };
  const given = input.value?.trim();
  if (
    given !== undefined &&
    (given.length === 0 || given.length > MAX_VALUE || /[\r\n\0]/u.test(given))
  )
    return yield* new AccountsError({
      reason: "invalid-input",
      message: `Pass the key alone, on one line, at most ${MAX_VALUE} characters.`,
    });
  if (given === undefined && (scope.unattended || scope.projectId === undefined))
    return {
      status: "unavailable" as const,
      message: "No one can answer a card in this run. Ask the user when they are here.",
    };
  const replacing =
    input.accountId === undefined
      ? undefined
      : session.accounts.find((account) => account.accountId === input.accountId);
  if (input.accountId !== undefined && replacing?.details.kind !== "api-key")
    return yield* new AccountsError({
      reason: "invalid-input",
      message: "Choose an API key account from scient_accounts_list to replace.",
    });
  // Only the row the agent named to replace is ever asked about.
  if (replacing?.controls.access === "off" && !(yield* turnedOn(scope, replacing)))
    return { status: "turned_off" as const, accountId: replacing.accountId, name: replacing.name };
  // A key in a store Scient can write (1Password, the keychain) is replaced there too; one in a
  // store Scient only reads is updated where it lives.
  const source = replacing?.secrets.token?.source;
  const writable = source?.type === "1password" || source?.type === "keychain";
  if (replacing && source !== undefined && source.type !== "scient" && !writable)
    return { status: "linked" as const, accountId: replacing.accountId, name: replacing.name };

  const notKept = "The key was not kept. Ask the user to enter it again.";
  const keep = Effect.fn("AccountsAgent.keepKey")(function* (value: string) {
    // Access may have changed while the card waited.
    const current = yield* accounts.forSession(scope);
    const target = replacing
      ? current.accounts.find((account) => account.accountId === replacing.accountId)
      : undefined;
    if (!current.agentAccess || (replacing && (!target || target.controls.access === "off")))
      return yield* fail(
        `${notKept} Its access changed in Settings → Accounts & secrets meanwhile.`,
      );
    const secrets = {
      token: {
        type: "scient" as const,
        value,
        // Naming Scient's store keeps the link and writes the new value through it.
        ...(writable ? { saveTo: [{ type: "scient" as const }] } : {}),
      },
    };
    return yield* (
      replacing
        ? accounts.save({
            accountId: replacing.accountId,
            name: replacing.name,
            details: replacing.details,
            secrets,
          })
        : accounts.save({
            name: input.name,
            details: {
              kind: "api-key",
              // `https://` origins, which every key picker matches.
              sites: (input.sites ?? []).map((site) => loginSiteKey(site) ?? site),
              auth: input.header ? { type: "header", name: input.header } : { type: "bearer" },
              ...(input.envName === undefined ? {} : { envName: input.envName }),
            },
            secrets,
          })
    ).pipe(Effect.mapError(() => fail(notKept)));
  });
  let saved: AccountSaveResult;
  if (given !== undefined) saved = yield* keep(given);
  else {
    const asked = yield* askInCard(scope, {
      label: replacing
        ? `New key for “${replacing.name}”`
        : /(?:^|[^a-z])(?:key|token)$/i.test(input.name)
          ? input.name
          : `${input.name} API key`,
      reason: input.reason,
      ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
      notKept,
    });
    if (asked.status !== "saved")
      return { status: asked.status, note: cardEndedNote(asked.status) };
    saved = yield* settleCard(asked.requestId, keep(asked.value));
  }
  const account = (yield* accounts.forSession(scope)).accounts.find(
    (item) => item.accountId === saved.accountId,
  );
  const invocation = yield* McpInvocationContext;
  return {
    status: "saved" as const,
    accountId: saved.accountId,
    usage: account ? accountUsage(account) : [],
    open: formatAccountLink(
      invocation.environmentId,
      saved.accountId,
      account?.name ?? replacing?.name ?? input.name,
    ),
  };
});

/**
 * The saved sign-in an agent names by site, username and optional sign-in address: the exact
 * tenant when it gave an address, else the one saved there; several are the agent's to choose.
 */
/** A sign-in address the agent gave must be the row's own tenant, with or without a password. */
const addressFits = (
  details: { readonly loginUrl?: string | undefined },
  input: { readonly loginUrl?: string | undefined },
) => input.loginUrl === undefined || loginTenant(details.loginUrl) === loginTenant(input.loginUrl);

const pickLogin = Effect.fn("AccountsAgent.pickLogin")(function* (
  accounts: ReadonlyArray<AccountSummary>,
  site: string,
  input: { readonly username?: string | undefined; readonly loginUrl?: string | undefined },
) {
  const named = {
    kind: "website",
    sites: [site],
    username: input.username,
    loginUrl: input.loginUrl,
  };
  const logins = loginCandidates(accounts, named);
  if (input.loginUrl !== undefined) return logins.find((account) => isLogin(account, named));
  const tenants = [
    ...new Map(
      logins.map((account) => [
        account.details.kind === "website" ? (account.details.loginUrl ?? "") : "",
        account,
      ]),
    ).values(),
  ];
  if (tenants.length > 1)
    return yield* new AccountsError({
      reason: "invalid-input",
      message: `Several saved sign-ins match. Pass loginUrl or accountId: ${tenants
        .map((account) =>
          account.details.kind === "website"
            ? `${account.name} (${account.accountId}, ${account.details.loginUrl ?? "no sign-in address"})`
            : account.accountId,
        )
        .join("; ")}.`,
    });
  return tenants[0];
});

const sameSite = (sites: ReadonlyArray<string>, site: string) =>
  sites.some((own) => host(own) === site || host(own).endsWith(`.${site}`));

/** The user's own sign-in, in the card here, for a row the agent may use; it gets metadata only. */
const signInHere = Effect.fn("AccountsAgent.addSignIn")(function* (
  scope: AccountSessionScope,
  account: AccountSummary,
  reason: string,
  created: boolean,
) {
  const discard = Effect.gen(function* () {
    const accounts = yield* AccountsService;
    const row = (yield* accounts.snapshot).accounts.find(
      (item) => item.accountId === account.accountId,
    );
    if (row && Object.keys(row.secrets).length === 0 && row.signIn?.state !== "signed-in")
      yield* accounts.remove(account.accountId).pipe(Effect.ignore);
  });
  const result = yield* guardedSignIn({
    signIn: account,
    caller: {
      kind: "person",
      agent: scope,
      reason,
      ...(created ? { discardIfUnfinished: true } : {}),
    },
    // A call the agent gave up on ends the card, and a row made for it.
  }).pipe(Effect.onInterrupt(() => (created ? discard.pipe(Effect.ignore) : Effect.void)));
  if (result.outcome === "signed-in") {
    yield* continueWaitingPapers((yield* AgentInvocationContext).environmentId, account.accountId);
    const signedIn = (yield* (yield* AccountsService).forSession(scope)).accounts.find(
      (item) => item.accountId === account.accountId,
    );
    return {
      status: "signed-in" as const,
      accountId: account.accountId,
      usage: signedIn ? accountUsage(signedIn) : [],
    };
  }
  if (result.message === "The user cancelled the sign-in.")
    return {
      status: "cancelled" as const,
      note: "The user cancelled the sign-in. Don't open it again this turn unless the user asks.",
    };
  if (result.message?.startsWith("The user did not finish signing in"))
    return {
      status: "timed_out" as const,
      note: `${result.message} Don't open it again this turn unless the user asks.`,
    };
  return {
    status: "unavailable" as const,
    message: result.message ?? "The sign-in did not finish.",
  };
});

/**
 * A website or university the user signs in to on its own page, in the card in this
 * conversation; Scient keeps what it can. An existing row is used, never duplicated.
 */
export const addSignIn = Effect.fn("AccountsAgent.addSignIn")(function* (
  scope: AccountSessionScope,
  input: Input,
) {
  const accounts = yield* AccountsService;
  const session = yield* accounts.forSession(scope);
  if (!session.agentAccess)
    return {
      status: "unavailable" as const,
      message:
        "Agent access to Accounts is off. The user can turn it on in Settings → Accounts & secrets.",
    };
  if (scope.unattended)
    return {
      status: "unavailable" as const,
      message: "No one can sign in during this run. Ask the user when they are here.",
    };
  const saved = Effect.fn("AccountsAgent.addSignIn.save")(function* (
    row: Parameters<typeof accounts.save>[0],
  ) {
    const { accountId } = yield* accounts.save(row);
    return (yield* accounts.snapshot).accounts.find((item) => item.accountId === accountId);
  });
  const known = (account: AccountSummary | undefined) =>
    account?.controls.access === "off"
      ? { status: "turned_off" as const, accountId: account.accountId, name: account.name }
      : account?.signIn?.state === "signed-in"
        ? { status: "exists" as const, accountId: account.accountId, usage: accountUsage(account) }
        : undefined;
  if (input.kind === "university") {
    const asked = input.institution ?? input.name;
    const found = yield* searchUniversities(asked).pipe(Effect.provide(FetchHttpClient.layer));
    const chosen =
      found.find(({ domain }) => domain === asked.toLowerCase()) ??
      (found.length === 1 ? found[0] : undefined);
    if (!chosen)
      return found.length
        ? {
            status: "choose" as const,
            universities: found.slice(0, 8).map(({ name, domain }) => ({ name, domain })),
          }
        : {
            status: "unavailable" as const,
            message: `No university matches “${asked}”. Ask the user for its name or email domain.`,
          };
    const existing = session.accounts.find(
      ({ details }) =>
        details.kind === "website" && details.institution?.entityId === chosen.entityId,
    );
    const answered = known(existing);
    if (answered) return answered;
    // A university's sign-in lives in Main, as the Accounts page connects one.
    const account =
      existing ??
      (yield* saved({
        name: chosen.name,
        details: {
          kind: "website",
          sites: [chosen.domain],
          profileId: DEFAULT_BROWSER_PROFILE_ID,
          institution: chosen,
        },
        secrets: {},
      }));
    if (!account) return yield* fail("The university could not be saved.");
    return yield* signInHere(scope, account, input.reason, existing === undefined);
  }
  const site = input.site;
  if (!site)
    return yield* new AccountsError({
      reason: "invalid-input",
      message: "Name the site to sign in to, e.g. site: github.com.",
    });
  // A saved password by its login (its sign-in address honoured); else a session row there.
  const existing =
    (yield* pickLogin(session.accounts, site, input)) ??
    session.accounts.find(
      ({ details, secrets }) =>
        details.kind === "website" &&
        secrets.password === undefined &&
        sameSite(details.sites, site) &&
        addressFits(details, input) &&
        (input.username !== undefined
          ? loginUserKey(details.username) === loginUserKey(input.username)
          : (details.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === DEFAULT_BROWSER_PROFILE_ID),
    );
  const answered = known(existing);
  if (answered) return answered;
  const account =
    existing ??
    (yield* saved({
      name: input.name,
      details: {
        kind: "website",
        sites: [site],
        ...(input.loginUrl === undefined ? {} : { loginUrl: input.loginUrl }),
        ...(input.username === undefined ? {} : { username: input.username }),
        profileId: DEFAULT_BROWSER_PROFILE_ID,
        origin: "browser-session",
      },
      secrets: {},
    }));
  if (!account) return yield* fail("The account could not be saved.");
  return yield* signInHere(scope, account, input.reason, existing === undefined);
});

/**
 * A website or university password or 2FA key the person gives in the private card, saved on
 * that login: the one named, else the one for this site and username, else a new one. A value
 * linked to 1Password is written there too; one in another store is updated where it lives.
 */
export const askForLoginSecret = Effect.fn("AccountsAgent.askForLoginSecret")(function* (
  scope: AccountSessionScope,
  input: Input & { readonly secret: "password" | "totp" },
) {
  const accounts = yield* AccountsService;
  const session = yield* accounts.forSession(scope);
  if (!session.agentAccess)
    return {
      status: "unavailable" as const,
      message:
        "Agent access to Accounts is off. The user can turn it on in Settings → Accounts & secrets.",
    };
  if (scope.unattended || scope.projectId === undefined)
    return {
      status: "unavailable" as const,
      message: "No one can answer a card in this run. Ask the user when they are here.",
    };
  const site = input.site ?? input.institution;
  // The named row; else the login by site, username and address (several are the agent's to
  // choose); else a row there with no password yet.
  const target =
    input.accountId !== undefined
      ? session.accounts.find(
          ({ accountId, details }) => accountId === input.accountId && details.kind === "website",
        )
      : site === undefined
        ? undefined
        : ((yield* pickLogin(session.accounts, site, input)) ??
          session.accounts.find(
            ({ details, secrets }) =>
              details.kind === "website" &&
              details.origin !== "browser-session" &&
              secrets.password === undefined &&
              sameSite(details.sites, site) &&
              addressFits(details, input) &&
              loginUserKey(details.username) === loginUserKey(input.username),
          ));
  if (input.accountId !== undefined && !target)
    return yield* new AccountsError({
      reason: "invalid-input",
      message: "Choose a website or university account from scient_accounts_list.",
    });
  if (!target && (site === undefined || input.kind === "university"))
    return yield* new AccountsError({
      reason: "invalid-input",
      message:
        input.kind === "university"
          ? "Connect the university first: call again without secret."
          : "Name the site, e.g. site: github.com, or the account to replace.",
    });
  // Only the row the agent named is asked about. A login found by its identity is the same login:
  // the person types its new value in the card, and nothing is read, so nothing is asked.
  const named = input.accountId !== undefined;
  if (named && target?.controls.access === "off" && !(yield* turnedOn(scope, target)))
    return { status: "turned_off" as const, accountId: target.accountId, name: target.name };
  const field = input.secret;
  const source = target?.secrets[field]?.source;
  if (
    source !== undefined &&
    source.type !== "scient" &&
    source.type !== "1password" &&
    source.type !== "keychain"
  )
    return { status: "linked" as const, accountId: target!.accountId, name: target!.name };
  const name = target?.name ?? input.name;
  const notKept = `The ${field === "totp" ? "2FA key" : "password"} was not kept. Ask the user to enter it again.`;
  const asked = yield* askInCard(scope, {
    label: field === "totp" ? `2FA key for “${name}”` : `Password for “${name}”`,
    reason: input.reason,
    kind: field,
    ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
    notKept,
  });
  if (asked.status !== "saved") return { status: asked.status, note: cardEndedNote(asked.status) };
  const saved = yield* settleCard(
    asked.requestId,
    Effect.gen(function* () {
      const current = yield* accounts.forSession(scope);
      const still = target
        ? current.accounts.find((account) => account.accountId === target.accountId)
        : undefined;
      if (
        !current.agentAccess ||
        (target && (!still || (named && still.controls.access === "off")))
      )
        return yield* fail(
          `${notKept} Its access changed in Settings → Accounts & secrets meanwhile.`,
        );
      const secrets = {
        // Naming Scient's store keeps a 1Password link and writes the new value there too.
        [field]: {
          type: "scient" as const,
          value: asked.value,
          ...(source?.type === "1password" || source?.type === "keychain"
            ? { saveTo: [{ type: "scient" as const }] }
            : {}),
        },
      };
      return yield* (
        still
          ? accounts.save({
              accountId: still.accountId,
              name: still.name,
              details: still.details,
              secrets,
            })
          : accounts.save({
              name,
              details: {
                kind: "website",
                sites: [site!],
                ...(input.loginUrl === undefined ? {} : { loginUrl: input.loginUrl }),
                ...(input.username === undefined ? {} : { username: input.username }),
              },
              secrets,
            })
      ).pipe(Effect.mapError(() => fail(notKept)));
    }),
  );
  const account = (yield* accounts.forSession(scope)).accounts.find(
    (item) => item.accountId === saved.accountId,
  );
  return {
    status: "saved" as const,
    accountId: saved.accountId,
    usage: account ? accountUsage(account) : [],
  };
});

export const addAccount = Effect.fn("AccountsAgent.add")(function* (input: Input) {
  const scope = yield* accountSessionScope();
  if ((input.kind === "website" || input.kind === "university") && input.secret)
    return yield* askForLoginSecret(scope, { ...input, secret: input.secret });
  return input.kind === "website" || input.kind === "university"
    ? yield* addSignIn(scope, input)
    : yield* askForAccountKey(scope, input);
}, withCardAllowance);
