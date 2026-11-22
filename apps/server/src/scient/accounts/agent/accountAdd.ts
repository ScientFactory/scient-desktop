// @effect-diagnostics nodeBuiltinImport:off -- Card request ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import {
  AccountsError,
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountSummary,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { FetchHttpClient } from "effect/http";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { personWaitMs } from "../../../provider/ScientPersonWaitTools.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { ACCOUNT_SECRET_REQUEST_PREFIX } from "@t3tools/shared/scientAccountSecretRequest";
import { searchUniversities } from "../../papers/universityDirectory.ts";
import { continueWaitingPapers } from "../../papers/getPaper.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { accountUsage } from "./accountUse.ts";
import { guardedSignIn } from "./guardedSignIn.ts";
import { accountSessionScope } from "./scope.ts";
import type { ScientAccountsToolkit } from "./tools.ts";

type Input = Schema.Schema.Type<
  (typeof ScientAccountsToolkit.tools)["scient_account_add"]["parametersSchema"]
>;

const MAX_VALUE = 65_536;
const fail = (message: string) => new AccountsError({ reason: "unavailable", message });
const host = (site: string) => site.replace(/^https:\/\//, "").replace(/:\d+$/, "");

/**
 * An API key the agent may already use or the user turned off, so a card is never a duplicate.
 * The same name wins over the same variable, then over a shared site.
 */
const existingKey = (accounts: ReadonlyArray<AccountSummary>, input: Input) => {
  const keys = accounts.flatMap((account) =>
    account.details.kind === "api-key" ? [{ account, details: account.details }] : [],
  );
  return (
    keys.find(({ account }) => account.name.toLowerCase() === input.name.toLowerCase()) ??
    keys.find(({ details }) => input.envName !== undefined && details.envName === input.envName) ??
    keys.find(({ details }) =>
      (input.sites ?? []).some((site) => details.sites.some((own) => host(own) === host(site))),
    )
  )?.account;
};

/** The calling agent's driver, when the registry knows its instance. */
const callerDriver = Effect.fn("AccountsAgent.callerDriver")(function* (
  instanceId: ProviderInstanceId | undefined,
) {
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  if (instanceId === undefined || Option.isNone(registry)) return undefined;
  const providers = yield* registry.value.getProviders;
  return providers.find((provider) => provider.instanceId === instanceId)?.driver;
});

/** Kept between a card's close and the call's deadline, for the answer to reach the caller. */
const CARD_RETURN_MS = 5_000;
/** A card with less time left than this could not be answered, so it is not opened. */
const MIN_CARD_MS = 15_000;

/**
 * The time one tool call has for the person, shared by every card it opens: set when the call
 * starts, it ends for good once a card times out or the run ends under one.
 */
interface CardAllowance {
  readonly deadline: number;
  readonly ended: Ref.Ref<"cancelled" | "timed_out" | undefined>;
}

const CurrentCardAllowance = Context.Reference<CardAllowance | undefined>(
  "scient/accounts/CardAllowance",
  { defaultValue: () => undefined },
);

const startAllowance = Effect.gen(function* () {
  const invocation = yield* Effect.serviceOption(McpInvocationContext);
  const driver = yield* callerDriver(Option.getOrUndefined(invocation)?.thread?.providerInstanceId);
  return {
    // Less than the calling agent keeps one silent tool call open.
    deadline: (yield* Clock.currentTimeMillis) + personWaitMs(driver),
    ended: yield* Ref.make<"cancelled" | "timed_out" | undefined>(undefined),
  } satisfies CardAllowance;
});

/**
 * Runs a tool call that may open cards under one allowance from its start, so its cards together
 * end before the caller would drop the call. A call inside another keeps the outer allowance.
 */
export const withCardAllowance = Effect.fn("AccountsAgent.withCardAllowance")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  if ((yield* CurrentCardAllowance) !== undefined) return yield* effect;
  return yield* effect.pipe(Effect.provideService(CurrentCardAllowance, yield* startAllowance));
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
  },
) {
  if (scope.projectId === undefined) return yield* fail(card.notKept);
  const invocation = yield* McpInvocationContext;
  const allowance = (yield* CurrentCardAllowance) ?? (yield* startAllowance);
  const ended = yield* Ref.get(allowance.ended);
  if (ended !== undefined) return { status: ended };
  const left = allowance.deadline - (yield* Clock.currentTimeMillis) - CARD_RETURN_MS;
  if (left < MIN_CARD_MS) {
    yield* Ref.set(allowance.ended, "timed_out");
    return { status: "timed_out" as const };
  }
  const asked = yield* (yield* OrchestratorMcpService)
    .requestSecret(invocation, {
      label: card.label,
      reason: card.reason,
      ...(card.placeholder === undefined ? {} : { placeholder: card.placeholder }),
      clientRequestId: `${ACCOUNT_SECRET_REQUEST_PREFIX}${NodeCrypto.randomUUID()}`,
      timeoutMs: Math.floor(left),
    })
    .pipe(Effect.mapError((error) => fail(error.message)));
  if (asked.status === "cancelled" || asked.status === "timed_out") {
    yield* Ref.set(allowance.ended, asked.status);
  }
  if (asked.status !== "saved") return { status: asked.status };
  if (!("secretRef" in asked)) return yield* fail(card.notKept);
  const value = (yield* (yield* SecretRequests)
    .consume({ ref: asked.secretRef, projectId: scope.projectId })
    .pipe(Effect.mapError(() => fail(card.notKept)))).trim();
  if (value.length === 0 || value.length > MAX_VALUE)
    return yield* fail(`${card.notKept} It was empty or longer than ${MAX_VALUE} characters.`);
  return { status: "saved" as const, value };
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
 * Asks for a key in upstream's private secret card and keeps the answer as an API-key account.
 * The value moves from the card's one-use store into Accounts and never reaches the agent.
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
  if (scope.unattended || scope.projectId === undefined)
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
  const match = replacing ?? existingKey(session.accounts, input);
  if (match?.controls.access === "off")
    return { status: "turned_off" as const, accountId: match.accountId, name: match.name };
  if (match && !replacing)
    return { status: "exists" as const, accountId: match.accountId, usage: accountUsage(match) };
  // Saving a new value would cut the link, so a linked key is updated where it lives.
  const source = replacing?.secrets.token?.source;
  if (replacing && source !== undefined && source.type !== "scient")
    return { status: "linked" as const, accountId: replacing.accountId, name: replacing.name };

  const notKept = "The key was not kept. Ask the user to enter it again.";
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
  if (asked.status !== "saved") return { status: asked.status, note: cardEndedNote(asked.status) };
  // Access may have changed while the card waited.
  const current = yield* accounts.forSession(scope);
  const target = replacing
    ? current.accounts.find((account) => account.accountId === replacing.accountId)
    : undefined;
  if (!current.agentAccess || (replacing && (!target || target.controls.access === "off")))
    return yield* fail(`${notKept} Its access changed in Settings → Accounts & secrets meanwhile.`);
  const value = asked.value;
  const secrets = { token: { type: "scient" as const, value } };
  const saved = yield* (
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
            sites: input.sites ?? [],
            auth: input.header ? { type: "header", name: input.header } : { type: "bearer" },
            ...(input.envName === undefined ? {} : { envName: input.envName }),
          },
          secrets,
        })
  ).pipe(Effect.mapError(() => fail(notKept)));
  const account = (yield* accounts.forSession(scope)).accounts.find(
    (item) => item.accountId === saved.accountId,
  );
  return {
    status: "saved" as const,
    accountId: saved.accountId,
    usage: account ? accountUsage(account) : [],
  };
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
  const existing = session.accounts.find(
    ({ details, secrets }) =>
      details.kind === "website" &&
      sameSite(details.sites, site) &&
      (input.username !== undefined
        ? details.username?.toLowerCase() === input.username.toLowerCase()
        : secrets.password === undefined &&
          (details.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === DEFAULT_BROWSER_PROFILE_ID),
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

export const addAccount = Effect.fn("AccountsAgent.add")(function* (input: Input) {
  const scope = yield* accountSessionScope();
  return input.kind === "website" || input.kind === "university"
    ? yield* addSignIn(scope, input)
    : yield* askForAccountKey(scope, input);
}, withCardAllowance);
