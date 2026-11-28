import type { AccountsSnapshot, AccountSummary } from "@t3tools/contracts";
import { universityGroups } from "@t3tools/shared/scientUniversityGroups";
import { describe, expect, it } from "vite-plus/test";
import {
  lastEndOf,
  openSignOut,
  signingIn,
  unclearedHost,
  recentEnd,
  shownUniversities,
  signInRow,
  universityStatus,
  universityWaiting,
} from "./universityView";

const row = (accountId: string, signIn?: AccountSummary["signIn"]) =>
  ({
    accountId,
    name: "Hebrew University",
    details: {
      kind: "website",
      sites: ["huji.ac.il"],
      institution: {
        name: "HUJI",
        entityId: "https://idp.huji.ac.il/openathens",
        domain: "huji.ac.il",
      },
    },
    secrets: {},
    ...(signIn ? { signIn } : {}),
  }) as unknown as AccountSummary;
const group = (...rows: AccountSummary[]) => universityGroups(rows)[0]!;
const end = (
  outcome: NonNullable<AccountsSnapshot["signInEnds"]>[number]["outcome"],
  at: string,
) => ({
  accountId: "acc_huji" as AccountSummary["accountId"],
  outcome,
  at,
});

describe("the Library's word on a university", () => {
  it("ends every press in its outcome, from the server, on every window", () => {
    const huji = group(row("acc_huji", { state: "signed-out", at: "2026-11-25T18:00:00.000Z" }));
    const before = { signInEnds: [] };
    const pressed = { lastEnd: lastEndOf(huji, before) };
    expect(universityStatus(huji, before, pressed, false)).toBe("signing-in");
    // The attempt ended: the same answer on this window, a reloaded one and another one.
    const after = { signInEnds: [end("needs-you", "2026-11-25T18:34:02.000Z")] };
    expect(universityStatus(huji, after, pressed, false)).toBe("needs-you");
    expect(universityStatus(huji, after, undefined, false)).toBe("needs-you");
  });

  it("lets a later look replace an attempt's end, and keeps a sign-out the person chose", () => {
    const seenLater = group(
      row("acc_huji", { state: "signed-in", at: "2026-11-25T19:00:00.000Z" }),
    );
    const ended = { signInEnds: [end("timed-out", "2026-11-25T18:34:02.000Z")] };
    expect(universityStatus(seenLater, ended, undefined, false)).toBe("signed-in");
    const out = group(
      row("acc_huji", { state: "signed-out", at: "2026-11-25T19:00:00.000Z", by: "action" }),
    );
    expect(universityStatus(out, ended, undefined, false)).toBe("signed-out");
    // Until every target of its sign-out is cleared, it says so and Sign out stays on offer.
    const clearing = {
      ...ended,
      universitySignOuts: [
        {
          opId: "op-1",
          seq: 1,
          accountIds: [out.rows[0]!.accountId],
          pending: [{ profileId: "default", site: "proxy.library-vendor.com" }],
        },
      ],
    };
    expect(universityStatus(out, clearing, undefined, false)).toBe("sign-out-unfinished");
    expect(unclearedHost(openSignOut(out, clearing))).toBe("proxy.library-vendor.com");
    // A sign-in paused at a code runs no more: the university isn't "signing in".
    const paused = {
      attempts: [
        {
          attemptId: "a",
          threadId: "t",
          tabId: "tab",
          accountId: out.rows[0]!.accountId,
          state: "pending" as const,
        },
      ],
    } as unknown as Parameters<typeof signingIn>[1];
    expect(signingIn(out, paused)).toBe(false);
    expect(universityWaiting("signed-out")).toBe(false);
  });

  it("says it couldn't check rather than repeating an old answer", () => {
    const unseen = group(row("acc_huji"));
    expect(universityStatus(unseen, {}, undefined, true)).toBe("unclear");
  });

  it("signs in through the row with the saved password, and keeps a sibling's failed try in view", () => {
    const directory = row("acc_huji", { state: "signed-in", at: "2026-11-25T10:00:00.000Z" });
    const legacy = {
      ...row("acc_huji_library", { state: "needs-you", at: "2026-11-25T18:34:01.000Z" }),
      details: {
        kind: "website",
        sites: ["huji.ac.il"],
        proxyUrl: "https://go.openathens.net/redirector/huji.ac.il?url={url}",
      },
      secrets: { password: { source: { type: "scient" } } },
    } as unknown as AccountSummary;
    const huji = group(directory, legacy);
    expect(signInRow(huji).accountId).toBe("acc_huji_library");
    const failed = {
      signInEnds: [{ ...end("failed", "2026-11-25T18:34:02.000Z"), accountId: legacy.accountId }],
    };
    expect(universityStatus(huji, failed, undefined, false)).toBe("signed-in");
    expect(recentEnd(huji, failed)).toBe("failed");
    // A newer look at the sibling says nothing about the library row's failed try.
    const lookedAgain = group(
      { ...directory, signIn: { state: "signed-in", at: "2026-11-25T19:00:00.000Z" } },
      legacy,
    );
    expect(recentEnd(lookedAgain, failed)).toBe("failed");
  });

  it("groups only against a server that speaks it; an older one keeps a line per row", () => {
    const accounts = [row("acc_huji"), { ...row("acc_huji_library"), name: "HUJI library" }];
    expect(shownUniversities({ accounts, accountsProtocol: 2 })).toHaveLength(1);
    expect(shownUniversities({ accounts })).toHaveLength(2);
  });
});
