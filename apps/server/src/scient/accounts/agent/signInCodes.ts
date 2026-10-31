// @effect-diagnostics nodeBuiltinImport:off -- Opaque request ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import type { AccountsError, AccountSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SIGN_IN_CODE_REQUEST_PREFIX } from "@t3tools/shared/scientAccountSecretRequest";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { readMessageCode, serviceWords } from "../signIn/messageCodes.ts";

/** The newest code in Messages, if the user turned that on and one arrived since sign-in began. */
const findSignInCode = Effect.fn("AccountsAgent.findSignInCode")(function* (
  sinceMs: number,
  service: ReadonlyArray<string>,
  sources: Effect.Effect<{ readonly messages?: boolean | undefined } | undefined, AccountsError>,
) {
  if (!(yield* sources)?.messages) return undefined;
  return yield* Effect.try(() => readMessageCode(sinceMs, service)).pipe(
    Effect.orElseSucceed(() => undefined),
  );
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
  const orchestrator = yield* Effect.serviceOption(OrchestratorMcpService);
  const caller = yield* Effect.serviceOption(McpInvocationContext);
  const requests = yield* Effect.serviceOption(SecretRequests);
  const service = serviceWords({
    name: account.name,
    sites: "sites" in account.details ? account.details.sites : [],
  });
  // Read once: a snapshot asks every source control tool, and the code is looked for every second.
  const sources = yield* Effect.cached(accounts.snapshot.pipe(Effect.map((s) => s.codeSources)));
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
          clientRequestId: `${SIGN_IN_CODE_REQUEST_PREFIX}${NodeCrypto.randomUUID()}`,
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
      findSignInCode(sinceMs, service, sources).pipe(Effect.orElseSucceed(() => undefined)),
  };
});
