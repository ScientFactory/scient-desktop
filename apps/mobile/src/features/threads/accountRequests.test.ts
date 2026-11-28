import {
  ACCOUNTS_PROTOCOL_2,
  AccountId,
  ThreadId,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { accountRequestsIn, needSignIn } from "./accountRequests";

const chat = ThreadId.make("thread-chat");
const renewal = ThreadId.make("thread-renewal");
const handoff = (threadId: ThreadId) => ({
  handoffId: `handoff-${threadId}`,
  threadId,
  accountId: AccountId.make("acc_fixture1"),
  accountName: "Fixture",
  site: "example.com",
  tabId: "tab-fixture",
  kind: "code" as const,
  startedAt: "2026-11-26T10:00:00.000Z",
  expiresAt: "2026-11-26T10:03:00.000Z",
});
const snapshot = {
  accountsProtocol: ACCOUNTS_PROTOCOL_2,
  approvals: [],
  handoffs: [handoff(chat), handoff(renewal)],
  needsYou: [
    {
      needId: "sign-in:a",
      name: "Fixture",
      detail: "Sign in again.",
      since: "2026-11-26T10:00:00.000Z",
    },
  ],
} as unknown as AccountsSnapshot;

it("puts a sign-in waiting with no chat on the phone's list, not in a chat", () => {
  const outside = accountRequestsIn(snapshot, { outside: new Set([chat]) });
  // Renewal's wait has no chat the phone lists; the Needs-you entry has none at all.
  expect(outside.handoffs.map(({ threadId }) => threadId)).toEqual([renewal]);
  expect(outside.needs).toHaveLength(1);
  const inChat = accountRequestsIn(snapshot, { threadId: chat });
  expect(inChat.handoffs.map(({ threadId }) => threadId)).toEqual([chat]);
  expect(inChat.needs).toEqual([]);
});

it("starts the person's sign-in from the phone, beside its chat or on its own", () => {
  const need = {
    needId: "sign-in:acc_fixture1",
    name: "Fixture",
    detail: "Waiting for you to sign in",
    action: "sign-in" as const,
    accountId: AccountId.make("acc_fixture1"),
    since: "2026-11-26T10:00:00.000Z",
  };
  expect(needSignIn({ ...need, threadId: chat }, { outside: new Set() })).toEqual({
    accountId: need.accountId,
    threadId: chat,
  });
  // A scheduled run's wait has no chat: the sign-in still starts, and its steps show here.
  expect(needSignIn(need, { outside: new Set() })?.threadId).toBe("scient-accounts-phone");
  expect(needSignIn({ ...need, action: "allow" }, { threadId: chat })).toBeUndefined();
});
