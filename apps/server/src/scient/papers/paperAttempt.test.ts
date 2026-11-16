import type { AccountSummary } from "@t3tools/contracts";
import { beforeEach, expect, it } from "@effect/vitest";
import { clearHolds, laneFor, nextMove, noteRefusal } from "./paperAttempt.ts";

const paper = { landingUrl: "https://doi.org/10.1/x", openAccess: [] };
const university = {
  accountId: "acc_fixture",
  name: "Hebrew University",
  details: {
    kind: "website",
    sites: ["huji.ac.il"],
    institution: { name: "Hebrew University", entityId: "x", domain: "huji.ac.il" },
  },
} as unknown as AccountSummary;
const universities = [university];
const missed = (
  route: "publisher" | "university",
  reason: "sign-in" | "bot-check" | "terms" | "paywall",
) => ({
  route,
  ...(route === "university" ? { account: university } : {}),
  result: {
    status: "no-access" as const,
    reason,
    message: "m",
    openUrl: "https://a.org/",
    profileId: "main",
  },
});
const tried = (
  site: string,
  rest: {
    missed: Parameters<typeof nextMove>[1]["missed"];
    universities?: ReadonlyArray<AccountSummary>;
    withheld?: ReadonlyArray<AccountSummary>;
  },
) => ({
  universities: [],
  withheld: [],
  checked: undefined,
  site,
  lane: laneFor(site),
  ...rest,
});

beforeEach(() => clearHolds());

it("asks for a sign-in once, so every paper behind it waits on the same request", () => {
  const first = nextMove(
    paper,
    tried("a.org", { missed: [missed("university", "sign-in")], universities }),
  );
  expect(first).toMatchObject({
    state: "needs-you",
    needed: { kind: "sign-in", site: "Hebrew University", accountId: university.accountId },
  });
  // The next paper tried no route at all: the first one's request covers it.
  expect(nextMove(paper, tried("b.org", { missed: [], universities }))).toMatchObject({
    state: "needs-you",
    needed: { kind: "sign-in", accountId: university.accountId },
  });
});

it("reads a bot check as needing a person at that publisher, in that profile only", () => {
  expect(
    nextMove(paper, tried("c.org", { missed: [missed("publisher", "bot-check")], universities })),
  ).toMatchObject({
    needed: { kind: "check", site: "c.org", profileId: "main" },
  });
  expect([...laneFor("c.org").checks.keys()]).toEqual(["main"]);
});

it("holds terms for the affected profile and releases them for a later retry", () => {
  const outcome = nextMove(
    paper,
    tried("ai.nejm.org", { missed: [missed("university", "terms")], universities }),
  );
  expect(outcome).toMatchObject({
    state: "needs-you",
    needed: { kind: "terms", site: "ai.nejm.org", profileId: "main" },
  });
  expect(laneFor("ai.nejm.org").checks.get("main")?.kind).toBe("terms");
  clearHolds();
  expect(laneFor("ai.nejm.org").checks.get("main")).toBeUndefined();
});

it("asks for a university when none is connected, and for access when one is held back", () => {
  expect(
    nextMove(paper, tried("d.org", { missed: [missed("publisher", "paywall")] })),
  ).toMatchObject({
    state: "needs-you",
    needed: { kind: "university" },
  });
  expect(
    nextMove(
      paper,
      tried("d.org", { missed: [missed("publisher", "paywall")], withheld: universities }),
    ),
  ).toMatchObject({
    state: "needs-you",
    needed: { kind: "access", site: "Hebrew University", accountId: university.accountId },
  });
});

it("says the library doesn't subscribe only after its route was tried", () => {
  expect(
    nextMove(paper, tried("e.org", { missed: [missed("university", "paywall")], universities })),
  ).toEqual({
    state: "no-access",
    paper,
    message: "Hebrew University doesn't seem to subscribe to this journal.",
  });
});

it("pauses a publisher after refusals in a row, doubling up to a limit", () => {
  const lane = laneFor("f.org");
  noteRefusal(lane, 0);
  noteRefusal(lane, 0);
  expect(lane.pausedUntil).toBe(0);
  noteRefusal(lane, 0);
  expect(lane.pausedUntil).toBe(15 * 60 * 1000);
  noteRefusal(lane, 0);
  expect(lane.pausedUntil).toBe(30 * 60 * 1000);
  for (let time = 0; time < 8; time += 1) noteRefusal(lane, 0);
  expect(lane.pausedUntil).toBe(4 * 60 * 60 * 1000);
});
