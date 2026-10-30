// @effect-diagnostics nodeBuiltinImport:off -- Opaque request ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import type { AccountSummary, PreviewAutomationStatus, PreviewTabId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { codeInMailFeed, mailFeedScript, MAIL_FEED_URL } from "../signIn/mailCodes.ts";
import { readMessageCode } from "../signIn/messageCodes.ts";

/** The newest code from the sources the user turned on, if one arrived since the sign-in began. */
const findSignInCode = Effect.fn("AccountsAgent.findSignInCode")(function* (
  sinceMs: number,
  profileId: string | undefined,
) {
  const sources = (yield* (yield* AccountsService).snapshot).codeSources;
  if (sources?.messages) {
    const code = yield* Effect.try(() => readMessageCode(sinceMs)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (code !== undefined) return code;
  }
  if (!sources?.mail) return undefined;
  const broker = yield* PreviewAutomationBroker;
  const scope = yield* AgentInvocationContext;
  const invoke = <A>(
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    input: unknown,
    tabId?: PreviewTabId,
  ) =>
    broker.invoke<A>({
      scope,
      operation,
      input,
      ...(tabId === undefined ? {} : { tabId }),
      updateCurrentTab: false,
    });
  return yield* Effect.acquireUseRelease(
    invoke<PreviewAutomationStatus>("open", {
      url: MAIL_FEED_URL,
      ...(profileId === undefined ? {} : { profileId }),
      open: false,
      reuseExistingTab: false,
    }),
    ({ tabId }) =>
      Effect.gen(function* () {
        if (!tabId) return undefined;
        yield* invoke("accountWaitForLoad", {}, tabId);
        const feed = yield* invoke<unknown>("evaluate", { expression: mailFeedScript }, tabId);
        return typeof feed === "string" ? codeInMailFeed(feed, sinceMs) : undefined;
      }),
    ({ tabId }) => (tabId ? invoke("close", {}, tabId).pipe(Effect.ignore) : Effect.void),
  ).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * The engine's two ways of getting a code. The private card reaches every device the user has, and
 * never completes when no one can answer, so the page and the sources keep the sign-in going.
 */
export const signInCodes = Effect.fn("AccountsAgent.signInCodes")(function* (
  scope: AccountSessionScope,
  account: Pick<AccountSummary, "name" | "details">,
) {
  const accounts = yield* AccountsService;
  const broker = yield* PreviewAutomationBroker;
  const invocation = yield* AgentInvocationContext;
  const orchestrator = yield* Effect.serviceOption(OrchestratorMcpService);
  const caller = yield* Effect.serviceOption(McpInvocationContext);
  const requests = yield* Effect.serviceOption(SecretRequests);
  const profileId = "profileId" in account.details ? account.details.profileId : undefined;
  return {
    askCode: (site: string): Effect.Effect<string> => {
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
          label: `Code for ${site}`,
          reason: `${site} sent a sign-in code for ${account.name}. It goes straight into the page.`,
          placeholder: "123456",
          clientRequestId: `scient-sign-in-code:${NodeCrypto.randomUUID()}`,
        })
        .pipe(
          Effect.flatMap((asked) =>
            asked.status === "saved" && "secretRef" in asked
              ? requests.value.consume({ ref: asked.secretRef, projectId })
              : Effect.never,
          ),
          Effect.map((code) => code.trim()),
          Effect.catch(() => Effect.never),
        );
    },
    findCode: (sinceMs: number): Effect.Effect<string | undefined> =>
      findSignInCode(sinceMs, profileId).pipe(
        Effect.provideService(AccountsService, accounts),
        Effect.provideService(PreviewAutomationBroker, broker),
        Effect.provideService(AgentInvocationContext, invocation),
        Effect.orElseSucceed(() => undefined),
      ),
  };
});
