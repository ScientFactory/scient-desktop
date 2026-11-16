import {
  AccountId,
  EnvironmentId,
  ThreadId,
  type AccountSummary,
  type AccountTarget,
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
import { fetchOnePaper, type PaperRequester } from "./paperAttempt.ts";

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
const fetchAs = (doi: string, refused: (target: AccountTarget) => boolean) =>
  Effect.gen(function* () {
    opened.length = 0;
    // Long after any earlier failure at the publisher, so its own page is tried first.
    yield* TestClock.adjust("2 hours");
    const fake = fakeAccounts({ accounts: [university] });
    const fiber = yield* fetchOnePaper({ doi }, agent(doi), () => Effect.undefined).pipe(
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
    for (let minute = 0; minute < 5; minute += 1) yield* TestClock.adjust("1 minute");
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
