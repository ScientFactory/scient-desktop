import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { hasUnseenCompletion } from "../../components/Sidebar.logic";
import { makeThreadFixture } from "../../test-fixtures";
import { countUnreadConversations, environmentCatalogComplete } from "./unreadConversations";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const before = "2026-10-22T09:00:00.000Z";
const answered = "2026-10-22T10:00:00.000Z";
const now = "2026-10-22T12:00:00.000Z";
const at = DateTime.makeUnsafe;
const parking = { capabilities: { threadSettlement: true, threadSnooze: true } };
const configs = new Map(
  [local, remote].map((id) => [id, { environment: parking } as unknown as EnvironmentServerConfig]),
);

type Source = ReturnType<typeof makeThreadFixture>["source"];
/** An answered thread its server last saw visited before the answer: the sidebar shows it unread. */
const thread = (id: string, patch: Partial<Source> = {}, environmentId = local) =>
  presentThreadShell(environmentId, {
    ...makeThreadFixture().source,
    id: ThreadId.make(id),
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    latestCompletedAnswer: {
      turnId: TurnId.make("run"),
      messageId: MessageId.make("answer"),
      completedAt: answered,
    },
    lastVisitedAt: at(before),
    ...patch,
  });
const count = (
  threads: ReadonlyArray<ReturnType<typeof thread>>,
  localVisits: Record<string, string> = {},
  serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig> = configs,
) => countUnreadConversations({ threads, localVisits, serverConfigs, now });
const key = (id: string, environmentId = local) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));

it("counts exactly the rows the sidebar marks unread, in every environment", () => {
  const threads = [
    thread("one"),
    thread("one", {}, remote),
    thread("read", { lastVisitedAt: at(answered) }),
  ];
  expect(threads.map(hasUnseenCompletion)).toEqual([true, true, false]);
  expect(count(threads)).toBe(2);
});

it("follows the server's read state, wherever the thread was read or marked unread", () => {
  // Read on another client: this device's older visit no longer counts.
  expect(count([thread("one", { lastVisitedAt: at(answered) })], { [key("one")]: before })).toBe(0);
  // Marked unread on the server, even though this device visited later.
  expect(count([thread("one")], { [key("one")]: answered })).toBe(1);
  // Servers without visit tracking use this device's visits.
  expect(count([thread("one", { lastVisitedAt: undefined })], { [key("one")]: before })).toBe(1);
  expect(count([thread("one", { lastVisitedAt: undefined })], { [key("one")]: answered })).toBe(0);
  // A thread never visited has no unread dot.
  expect(count([thread("one", { lastVisitedAt: null })])).toBe(0);
});

it("leaves out threads the sidebar hides or parks", () => {
  const hidden = [
    thread("archived", { archivedAt: at(answered) }),
    thread("unfiled", { projectId: null as unknown as ProjectId }),
    thread("child", {
      lineage: {
        rootThreadId: ThreadId.make("one"),
        parentThreadId: ThreadId.make("one"),
        relationshipToParent: "subagent",
      },
    }),
    thread("settled", { settledOverride: "settled", settledAt: at(answered) }),
    thread("snoozed", { snoozedUntil: at("2026-10-23T09:00:00.000Z"), snoozedAt: at(answered) }),
  ];
  expect(count(hidden)).toBe(0);
  // A pinned thread and one whose snooze has ended are in view.
  const visible = [
    thread("pinned", { pinnedAt: at(before) }),
    thread("woke", { snoozedUntil: at(answered), snoozedAt: at(before) }),
  ];
  expect(count(visible)).toBe(2);
});

it("ignores parking an environment does not support, as the sidebar does", () => {
  const settled = thread("settled", { settledOverride: "settled", settledAt: at(answered) });
  expect(count([settled], {}, new Map())).toBe(1);
});

it("knows every environment once this machine's is listed, unless it is turned off", () => {
  const entry = (tag: string) => ({ enabled: true, target: { _tag: tag } });
  const catalog = (ready: boolean, ...tags: string[]) =>
    ({
      isReady: ready,
      entries: new Map(tags.map((tag, index) => [`environment-${index}`, entry(tag)])),
    }) as unknown as Parameters<typeof environmentCatalogComplete>[0];
  expect(environmentCatalogComplete(catalog(false, "PrimaryConnectionTarget"), false)).toBe(false);
  expect(environmentCatalogComplete(catalog(true), false)).toBe(false);
  expect(environmentCatalogComplete(catalog(true, "SavedConnectionTarget"), false)).toBe(false);
  expect(
    environmentCatalogComplete(
      catalog(true, "SavedConnectionTarget", "PrimaryConnectionTarget"),
      false,
    ),
  ).toBe(true);
  // With it turned off, the saved catalog is complete, even once its last environment is removed.
  expect(environmentCatalogComplete(catalog(false), true)).toBe(false);
  expect(environmentCatalogComplete(catalog(true), true)).toBe(true);
  expect(environmentCatalogComplete(catalog(true, "SavedConnectionTarget"), true)).toBe(true);
});
