import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { makeHarness } from "../Accounts.testkit.ts";
import { guardedSignIn, keepTyped } from "./guardedSignIn.ts";

const origin = "https://example.com";
const threadId = ThreadId.make("thread-fixture");
const tabId = PreviewTabId.make("tab-fixture");
/** The site's form, behind a CAPTCHA Scient leaves to the person. */
const form = (document: number, refused = false) => ({
  origin,
  url: `${origin}/login`,
  username: "#user",
  password: "#password",
  otp: null,
  submit: "button",
  challenge: "captcha",
  signedIn: false,
  document,
  refused,
});
const signedIn = {
  origin,
  url: `${origin}/home`,
  username: null,
  password: null,
  otp: null,
  submit: null,
  challenge: null,
  signedIn: true,
  document: 3,
};

it.effect(
  "a saved password the site refused, then the person's own that signs in: theirs is kept, never the refused one",
  () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save({
        name: "Synthetic website",
        details: { kind: "website", sites: [origin], username: "synthetic-user" },
        secrets: { password: { type: "scient", value: "old-password" } },
      });
      const attempts = (yield* service.signInAttempts).typed;
      /** The desktop's capture of a password submitted in the attempt's tab. */
      const captured = (password: string) =>
        keepTyped({
          attemptId: [...attempts.keys()][0]!,
          threadId,
          tabId,
          origin,
          path: "/login",
          step: "password",
          username: "synthetic-user",
          password,
        }).pipe(Effect.provideService(AccountsService, service));
      let look = 0;
      const pages = [form(1), form(1), form(2, true), form(2, true), signedIn];
      const broker = PreviewAutomationBroker.of({
        connect: () => Effect.succeed(Stream.empty),
        focusHost: () => Effect.void,
        respond: () => Effect.void,
        invoke: <A>(request: { readonly operation: string; readonly input?: unknown }) =>
          Effect.gen(function* () {
            const input = (request.input ?? {}) as Record<string, unknown>;
            if (request.operation === "accountWaitForLoad" && input.settleMs === 400) {
              look++;
              // The web autofill fills the saved password; the person submits it, and the site
              // refuses it.
              if (look === 1) {
                const filled = yield* service.fillValues(accountId, origin, {
                  threadId,
                  tabId,
                  url: `${origin}/login`,
                });
                yield* captured(filled.password!);
                yield* service.recordUse(
                  {
                    target: { type: "account", accountId },
                    action: "sign-in",
                    signInOutcome: "password-rejected",
                    outcome: "error",
                    byPerson: true,
                    attempt: filled.attempt!,
                  },
                  undefined,
                  true,
                );
              }
              // The person types the right one, and it signs in.
              if (look === 3) yield* captured("new-password");
            }
            if (request.operation === "evaluate")
              return pages[Math.min(look, pages.length - 1)] as A;
            return {
              tabId,
              tabs: [{ tabId, url: `${origin}/login`, profileId: "default", ownedByCaller: true }],
            } as A;
          }).pipe(Effect.orDie),
      });
      const account = (yield* service.snapshot).accounts.find(
        (entry) => entry.accountId === accountId,
      )!;
      const result = yield* guardedSignIn({ signIn: account, caller: { kind: "person" } }).pipe(
        Effect.provideService(AccountsService, service),
        Effect.provideService(PreviewAutomationBroker, broker),
        Effect.provideService(AgentInvocationContext, {
          threadId,
          environmentId: EnvironmentId.make("env-fixture"),
          providerSessionId: "user-run:thread-fixture",
          providerInstanceId: ProviderInstanceId.make("scient"),
          capabilities: new Set(["preview", "accounts"] as const),
          issuedAt: 0,
        }),
      );
      expect(result.outcome).toBe("signed-in");
      // regression: the autofill's submit counted as the person's, so theirs wasn't kept; and the
      // sign-in proved the refused saved password, which the next sign-in filled again.
      const held = yield* service.resolveSecrets(accountId, ["password"]);
      expect(held.password && Redacted.value(held.password)).toBe("new-password");
      const history = (yield* service.snapshot).accounts.find(
        (entry) => entry.accountId === accountId,
      )!.secrets.password!.history!;
      const old = [];
      for (const entry of history)
        if ((yield* service.reveal(accountId, "version", entry.version)).value === "old-password")
          old.push(entry);
      expect(old).toHaveLength(1);
      expect(old[0]!.refused).toBe(true);
      expect(old[0]!.provenAt).toBeUndefined();
      expect((yield* service.fillValues(accountId, origin)).password).toBe("new-password");
      // Told as "Password updated", with Undo.
      expect(
        (yield* service.snapshot).passwordUpdates?.some((update) => update.accountId === accountId),
      ).toBe(true);
    }),
);
