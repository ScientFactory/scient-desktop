// @effect-diagnostics nodeBuiltinImport:off -- Opaque request ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import type { AccountSummary } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SIGN_IN_CODE_REQUEST_PREFIX } from "@t3tools/shared/scientAccountSecretRequest";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { siteOf } from "@t3tools/shared/scientSiteMatch";
import { chooseCodeFor, usedKeys } from "../signIn/codeChoice.ts";
import { readCodesFresh } from "../signIn/codeSourcesHelper.ts";
import { serviceIdentity, type CodeCandidate } from "../signIn/messageCodes.ts";

/** The registrable site of an attempt key's origin. */
const siteOfKey = (key: string) => {
  const origin = key.split("|")[0] ?? "";
  return siteOf(URL.canParse(origin) ? new URL(origin).hostname : "");
};

/** A texted code is stamped by the phone, whose clock may run a little behind; only for offering. */
const CLOCK_SLACK_MS = 10_000;
/** A message whose code went into a page is not used again for an hour. */
const USED_FOR_MS = 60 * 60_000;

/**
 * The engine's ways of getting a code, for every sign-in. The private card reaches every device the
 * user has, and never completes when no one can answer, so the page and the sources keep the
 * sign-in going. Codes from this Mac are on unless the user turned them off; macOS still has to
 * give Scient Full Disk Access before any is read.
 */
export const signInCodes = Effect.fn("AccountsAgent.signInCodes")(function* (
  scope: AccountSessionScope,
  account: Pick<AccountSummary, "name" | "details">,
  /** The attempt's site and identity (`attemptKey`). */
  key: string,
) {
  const accounts = yield* AccountsService;
  const attempts = yield* accounts.signInAttempts;
  const orchestrator = yield* Effect.serviceOption(OrchestratorMcpService);
  const caller = yield* Effect.serviceOption(McpInvocationContext);
  const requests = yield* Effect.serviceOption(SecretRequests);
  const sites = "sites" in account.details ? account.details.sites : [];
  const username = "username" in account.details ? account.details.username : undefined;
  // The words that name this service and no sibling; shared, its codes are the person's to tap.
  const { service, shared } = serviceIdentity({ name: account.name, sites });
  // Read at every look and before every entry: turning the switch off stops an open wait at once.
  const enabled = accounts.codeSourcesOn;
  const site = siteOfKey(key);
  // From the start: a rival's code can arrive between its submit and its first look.
  const waiter = NodeCrypto.randomUUID();
  const waiting = attempts.codeWaits.get(site) ?? new Set<string>();
  attempts.codeWaits.set(site, waiting.add(waiter));
  /** Another sign-in on the site, running or kept at a code, could be waiting for any code. */
  const alone = () =>
    waiting.size === 1 &&
    ![...attempts.pending.keys()].some((other) => other !== key && siteOfKey(other) === site);
  let inserted: CodeCandidate | undefined;
  return {
    askCode: (asked: string): Effect.Effect<string> => {
      const { projectId } = scope;
      if (
        Option.isNone(orchestrator) ||
        Option.isNone(caller) ||
        Option.isNone(requests) ||
        projectId === undefined ||
        scope.unattended
      )
        return Effect.never;
      return orchestrator.value
        .requestSecret(caller.value, {
          label: `Code for ${asked}`,
          reason: `${asked} sent a sign-in code for ${account.name}. It goes straight into the page.`,
          placeholder: "123456",
          clientRequestId: `${SIGN_IN_CODE_REQUEST_PREFIX}${NodeCrypto.randomUUID()}`,
        })
        .pipe(
          Effect.flatMap((answer) =>
            answer.status === "saved" && "secretRef" in answer
              ? requests.value.consume({ ref: answer.secretRef, projectId })
              : Effect.never,
          ),
          Effect.map((code) => code.trim()),
          Effect.catch(() => Effect.never),
        );
    },
    codes: {
      enabled,
      version: accounts.codeSourcesVersion,
      look: Effect.fn("AccountsAgent.lookForCodes")(function* (look: {
        readonly since: number;
        readonly requestedAt: number | undefined;
      }) {
        if (!(yield* enabled)) return { automatic: undefined, offered: [] };
        const now = yield* Clock.currentTimeMillis;
        for (const [used, until] of attempts.usedCodes)
          if (until <= now) attempts.usedCodes.delete(used);
        // Every code in Messages and Mail since then, read by a new process each look.
        const found = yield* readCodesFresh({
          sinceMs: look.since - CLOCK_SLACK_MS,
          service,
          ...(shared ? { shared } : {}),
          sites,
          username,
        });
        return chooseCodeFor(found, {
          used: new Set(attempts.usedCodes.keys()),
          alone: alone(),
          requestedAt: look.requestedAt,
          confirmed: attempts.codeSenders.get(site) ?? new Set(),
        });
      }),
      used: (candidate: CodeCandidate) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            inserted = candidate;
            for (const used of usedKeys(candidate)) attempts.usedCodes.set(used, now + USED_FOR_MS);
          }),
        ),
      /** The sign-in worked after a found code: its sender is this site's from now on. */
      worked: Effect.sync(() => {
        if (!inserted?.sender) return;
        attempts.codeSenders.set(
          site,
          (attempts.codeSenders.get(site) ?? new Set<string>()).add(inserted.sender),
        );
      }),
      release: Effect.sync(() => {
        waiting.delete(waiter);
        if (waiting.size === 0 && attempts.codeWaits.get(site) === waiting)
          attempts.codeWaits.delete(site);
      }),
    },
  };
});
