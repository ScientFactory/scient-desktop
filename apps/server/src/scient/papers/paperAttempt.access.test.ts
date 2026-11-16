import {
  AccountId,
  EnvironmentId,
  ThreadId,
  type AccountSummary,
  type AccountTarget,
  type PaperItem,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { AccountsService } from "../accounts/AccountsService.ts";
import { fakeAccounts } from "../accounts/Accounts.testkit.ts";
import type * as PaperFetch from "./paperFetch.ts";
import type * as PaperLookup from "./paperLookup.ts";
import { clearHolds, fetchOnePaper, type PaperRequester } from "./paperAttempt.ts";

const opened = vi.hoisted(() => [] as Array<{ url: string; profileId: string }>);

// vi.mock factories are hoisted above this file's imports, so they import what they use.
/** Each journal answers with a paywall at its own address, and the PDF through a university. */
vi.mock("./paperFetch.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PaperFetch>();
  const { succeed } = await import("effect/Effect");
  const fetchFromPage: typeof actual.fetchFromPage = ({ url, profileId }) => {
    opened.push({ url, profileId });
    return succeed(
      url.includes("openathens")
        ? { status: "saved" as const, bytes: new Uint8Array([1]) }
        : {
            status: "no-access" as const,
            reason: "paywall" as const,
            message: "Paywall.",
            openUrl: url,
            profileId,
          },
    );
  };
  return { ...actual, fetchFromPage, defaultPaperProfile: succeed("main") };
});

vi.mock("./paperLookup.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PaperLookup>();
  const { succeed } = await import("effect/Effect");
  return {
    ...actual,
    lookUpPaper: (asked: { readonly doi?: string }) =>
      succeed({
        doi: asked.doi,
        landingUrl: `https://doi.org/${asked.doi}`,
        articleUrl: `https://${asked.doi?.replace("/", ".")}.example.org/article`,
        openAccess: [],
      }),
    articleAddress: () => succeed(undefined),
  };
});

vi.mock("../sources/researchKeys.ts", async () => {
  const { succeed } = await import("effect/Effect");
  return { readResearchKeys: () => succeed({}) };
});

const university = {
  accountId: AccountId.make("acc_university_fixture"),
  name: "Hebrew University",
  details: {
    kind: "website",
    sites: ["huji.ac.il"],
    profileId: "work",
    institution: {
      name: "Hebrew University",
      entityId: "https://idp.openathens.net/huji",
      domain: "huji.ac.il",
    },
  },
} as unknown as AccountSummary;

/** A conversation per paper: decisions are reused for a minute per conversation. */
const agent = (doi: string): PaperRequester => ({
  environmentId: EnvironmentId.make("env-fixture"),
  threadId: ThreadId.make(`thread-${doi}`),
  browser: true,
});

/** One paper, as an agent's request, with the university connected after it asked. */
const fetchAs = (
  doi: string,
  refused: (target: AccountTarget) => boolean,
  requester = agent(doi),
  accounts: ReadonlyArray<AccountSummary> = [university],
  later = true,
  agentAccess = true,
  needed?: PaperItem["needed"],
) =>
  Effect.gen(function* () {
    opened.length = 0;
    // Long after any earlier failure at the publisher, so its own page is tried first.
    if (later) yield* TestClock.adjust("2 hours");
    const fake = fakeAccounts({ accounts: [...accounts], agentAccess });
    const fiber = yield* fetchOnePaper(
      { doi, ...(needed ? { needed } : {}) },
      requester,
      () => Effect.undefined,
    ).pipe(
      Effect.provideService(AccountsService, {
        ...fake.service,
        authorize: (_scope, target) =>
          Effect.succeed(
            refused(target)
              ? ({ decision: "denied", reason: "declined" } as const)
              : ({ decision: "allowed" } as const),
          ),
      }),
      // The page, the lookup and the files are stubbed above; these only satisfy the types.
      Effect.provideService(AgentInvocationContext, {} as never),
      Effect.provideService(PreviewAutomationBroker, {} as never),
      Effect.provideService(HttpClient.HttpClient, {} as never),
      Effect.provideService(FileSystem.FileSystem, {} as never),
      Effect.forkChild,
    );
    // Publishers are paced at a reader's speed.
    for (let turn = 0; turn < 2; turn += 1) yield* TestClock.adjust("20 seconds");
    return { outcome: yield* Fiber.join(fiber), opened: [...opened] };
  });

it.effect("goes through a university connected after the agent asked, in its profile", () =>
  Effect.gen(function* () {
    const { outcome, opened } = yield* fetchAs("10.1/connected-later", () => false);
    expect(outcome).toMatchObject({ state: "saved", route: "university" });
    expect(opened.map(({ profileId }) => profileId)).toEqual(["work", "work"]);
    expect(opened[1]?.url).toContain("openathens");
  }),
);

it.effect("skips a university the conversation may not use, and says so", () =>
  Effect.gen(function* () {
    const account = yield* fetchAs("10.1/account-off", (target) => target.type === "account");
    expect(account.outcome).toMatchObject({
      state: "needs-you",
      needed: { kind: "access", site: "Hebrew University" },
    });
    expect(account.opened.map(({ url }) => url).join()).not.toContain("openathens");
    // Its profile closed to the conversation: the publisher opens in the default profile instead.
    const profile = yield* fetchAs(
      "10.1/profile-off",
      (target) => target.type === "profile" && target.profileId === "work",
    );
    expect(profile.outcome).toMatchObject({ needed: { kind: "access" } });
    expect(profile.opened.map(({ profileId }) => profileId)).toEqual(["main"]);
  }),
);

it.effect("decides again as soon as the university's access changes, not a minute later", () =>
  Effect.gen(function* () {
    const requester = agent("10.1/changed");
    const changing = {
      ...university,
      controls: { access: "allowed", scope: { type: "all-projects" } },
    };
    const refused = (target: AccountTarget) =>
      target.type === "account" && changing.controls.access === "off";
    const first = yield* fetchAs("10.1/changed-first", refused, requester, [changing as never]);
    expect(first.outcome).toMatchObject({ state: "saved", route: "university" });
    // Turned off in Settings right after: the next paper of the same conversation doesn't use it.
    changing.controls = { ...changing.controls, access: "off" };
    const next = yield* fetchAs(
      "10.1/changed-next",
      refused,
      requester,
      [changing as never],
      false,
    );
    expect(next.opened.map(({ url }) => url).join()).not.toContain("openathens");
    expect(next.outcome).toMatchObject({ needed: { kind: "access" } });
  }),
);

it.effect("stops at once when the user turns agents' access off, default profiles included", () =>
  Effect.gen(function* () {
    const requester = agent("10.1/switched");
    const on = { value: true };
    const refused = () => !on.value;
    yield* fetchAs("10.1/switched-first", refused, requester);
    on.value = false;
    const next = yield* fetchAs(
      "10.1/switched-next",
      refused,
      requester,
      [university],
      false,
      false,
    );
    expect(next.opened).toEqual([]);
  }),
);

it.effect("resumes a terms gate in its profile, but never after that profile is denied", () =>
  Effect.gen(function* () {
    clearHolds();
    const other = {
      ...university,
      accountId: AccountId.make("acc_other_university"),
      details: { ...university.details, profileId: "other" },
    } as AccountSummary;
    const needed = { kind: "terms" as const, site: "ai.nejm.org", profileId: "work" };
    const first = yield* fetchAs(
      "10.1/terms-profile",
      () => false,
      undefined,
      [other, university],
      true,
      true,
      needed,
    );
    expect(first.outcome).toMatchObject({ state: "saved", route: "university" });
    expect(first.opened.map(({ profileId }) => profileId)).toEqual(["work", "work"]);
    const denied = yield* fetchAs(
      "10.1/terms-denied",
      (target) => target.type === "profile" && target.profileId === "work",
      undefined,
      [other, university],
      true,
      true,
      needed,
    );
    expect(denied.outcome.state).not.toBe("saved");
    expect(denied.opened).toEqual([]);
  }),
);
