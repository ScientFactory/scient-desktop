import { AccountId, type AccountSummary } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { withNeedsYouSettled } from "./needsYou.ts";

const at = "2026-11-26T10:00:00.000Z";
const id = AccountId.make("acc_needs_fixture");
const need = { needId: `sign-in:${id}`, name: "Row", detail: "Sign in", accountId: id, since: at };
const other = { needId: "connector:x", name: "Connector", detail: "Reconnect", since: at };
const rows = (signIn?: AccountSummary["signIn"]) => [
  { summary: { accountId: id, ...(signIn ? { signIn } : {}) } as AccountSummary },
];

it("drops an entry once its row is removed or seen signed in, and keeps the rest", () => {
  const waiting = { accounts: rows({ state: "signed-out", at }), needsYou: [need, other] };
  expect(withNeedsYouSettled(waiting)).toBe(waiting);
  expect(withNeedsYouSettled({ ...waiting, accounts: [] }).needsYou).toEqual([other]);
  expect(
    withNeedsYouSettled({ ...waiting, accounts: rows({ state: "signed-in", at, by: "look" }) })
      .needsYou,
  ).toEqual([other]);
});
