import { it } from "@effect/vitest";
import { AccountId, ThreadId, type AccountSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { expect } from "vite-plus/test";

import { fakeAccounts } from "../Accounts.testkit.ts";
import { AccountsService } from "../AccountsService.ts";
import { needsYou } from "./cardAllowance.ts";
import { recordSignInEnd } from "./signInEnds.ts";

const accountId = AccountId.make("acc_university1");
const row = { accountId, name: "Synthetic University" } as AccountSummary;

it.effect("a sign-in the person left unfinished waits in Needs you until it signs in", () =>
  Effect.gen(function* () {
    const fake = fakeAccounts({ accounts: [row] });
    const end = (outcome: "needs-user" | "signed-in") =>
      recordSignInEnd(accountId, Exit.succeed({ outcome })).pipe(
        Effect.provideService(AccountsService, fake.service),
      );
    yield* end("needs-user");
    expect(fake.needs.get(`sign-in:${accountId}`)).toMatchObject({
      name: "Synthetic University",
      accountId,
    });
    yield* end("signed-in");
    expect(fake.needs.size).toBe(0);
  }),
);

it.effect(
  "an agent's card nobody answered waits in Needs you as one entry, a sign-in's shared",
  () =>
    Effect.gen(function* () {
      const fake = fakeAccounts({ accounts: [row] });
      const scope = {
        threadId: ThreadId.make("thread-synthetic"),
        projectId: undefined,
        unattended: false,
      };
      const target = { type: "account" as const, accountId };
      const unanswered = (action: "sign-in" | "credentials") =>
        needsYou(target, scope, action).pipe(Effect.provideService(AccountsService, fake.service));
      yield* unanswered("credentials");
      yield* unanswered("credentials");
      yield* unanswered("sign-in");
      expect([...fake.needs.keys()]).toEqual([`allow:${accountId}`, `sign-in:${accountId}`]);
      expect(fake.needs.get(`allow:${accountId}`)).toMatchObject({
        name: "Synthetic University",
        threadId: scope.threadId,
      });
    }),
);
