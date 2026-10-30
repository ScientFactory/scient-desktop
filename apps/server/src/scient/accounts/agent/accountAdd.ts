// @effect-diagnostics nodeBuiltinImport:off -- Card request ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import { AccountsError, type AccountSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { ACCOUNT_SECRET_REQUEST_PREFIX } from "@t3tools/shared/scientAccountSecretRequest";
import { accountUsage } from "./accountUse.ts";
import { accountSessionScope } from "./scope.ts";
import type { ScientAccountsToolkit } from "./tools.ts";

type Input = Schema.Schema.Type<
  (typeof ScientAccountsToolkit.tools)["scient_account_add"]["parametersSchema"]
>;

const MAX_VALUE = 65_536;
const fail = (message: string) => new AccountsError({ reason: "unavailable", message });
const host = (site: string) => site.replace(/^https:\/\//, "").replace(/:\d+$/, "");

/** An API key the agent may already use or the user turned off, so a card is never a duplicate. */
const existingKey = (accounts: ReadonlyArray<AccountSummary>, input: Input) =>
  accounts.find((account) => {
    if (account.details.kind !== "api-key") return false;
    const details = account.details;
    return (
      account.name.toLowerCase() === input.name.toLowerCase() ||
      (input.envName !== undefined && details.envName === input.envName) ||
      (input.sites ?? []).some((site) => details.sites.some((own) => host(own) === host(site)))
    );
  });

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
      message: "Agent access to Accounts is off. The user can turn it on in Settings → Accounts.",
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

  const orchestrator = yield* OrchestratorMcpService;
  const asked = yield* orchestrator
    .requestSecret(yield* McpInvocationContext, {
      label: replacing
        ? `New key for “${replacing.name}”`
        : /\b(?:key|token)$/i.test(input.name)
          ? input.name
          : `${input.name} API key`,
      reason: input.reason,
      ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
      clientRequestId: `${ACCOUNT_SECRET_REQUEST_PREFIX}${NodeCrypto.randomUUID()}`,
    })
    .pipe(Effect.mapError((error) => fail(error.message)));
  if (asked.status !== "saved") return { status: asked.status };
  if (!("secretRef" in asked)) return yield* fail("The key could not be read.");

  const notKept = "The key was not kept. Ask the user to enter it again.";
  const value = (yield* (yield* SecretRequests)
    .consume({ ref: asked.secretRef, projectId: scope.projectId })
    .pipe(Effect.mapError(() => fail(notKept)))).trim();
  if (value.length === 0 || value.length > MAX_VALUE)
    return yield* fail(`${notKept} It was empty or longer than ${MAX_VALUE} characters.`);
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

export const addAccount = Effect.fn("AccountsAgent.add")(function* (input: Input) {
  return yield* askForAccountKey(yield* accountSessionScope(), input);
});
