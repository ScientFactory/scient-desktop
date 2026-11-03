import { describe, expect, it } from "@effect/vitest";

import {
  pickBrowserProfile,
  profileSignIns,
  siteIdentities,
} from "./scientBrowserProfileChoice.ts";
import {
  F16_RECORDS,
  F16_ROWS,
  F16_WORK_USERNAME,
} from "./scientBrowserProfileChoice.f16.fixture.ts";

const base = {
  url: "https://portal.huji.ac.il/courses",
  threadId: "thread-a",
  projectId: "project-a",
  profiles: ["main", "yaacov", "work", "huji"],
  signIns: [],
  choices: undefined,
  defaultProfileId: "main",
};
const choices = (
  thread?: { profileId: string; sites?: Record<string, { profileId: string; at: string }> },
  project?: string,
) => ({
  projects: project ? { "project-a": project } : {},
  threads: thread ? { "thread-a": { profileId: thread.profileId, sites: thread.sites ?? {} } } : {},
});

describe("pickBrowserProfile", () => {
  const huji = (profileId: string, createdAt = "2026-10-01T00:00:00Z") => ({
    profileId,
    sites: ["huji.ac.il"],
    createdAt,
  });

  it("keeps the conversation's, then the project's profile, else the default", () => {
    expect(
      pickBrowserProfile({ ...base, choices: choices({ profileId: "yaacov" }, "work") }),
    ).toEqual({
      profileId: "yaacov",
      reason: "conversation",
    });
    // A new conversation uses its project's profile, with nothing written for it.
    expect(pickBrowserProfile({ ...base, choices: choices(undefined, "work") })).toEqual({
      profileId: "work",
      reason: "project",
    });
    expect(pickBrowserProfile({ ...base, url: "http://example.com" })).toEqual({
      profileId: "main",
      reason: "default",
    });
  });

  it("keeps a pairing unless another profile is signed in to the page and it is not", () => {
    const signIns = [huji("huji")];
    expect(
      pickBrowserProfile({ ...base, signIns, choices: choices({ profileId: "yaacov" }) }),
    ).toEqual({
      profileId: "huji",
      reason: "signed-in",
    });
    // A pairing that is signed in holds against the oldest identity.
    expect(
      pickBrowserProfile({
        ...base,
        signIns: [huji("work"), huji("huji", "2026-09-01T00:00:00Z")],
        choices: choices(undefined, "work"),
      }),
    ).toEqual({ profileId: "work", reason: "project" });
  });

  it("prefers Main among the signed-in profiles, then the oldest identity", () => {
    const signIns = [huji("work", "2026-10-02T00:00:00Z"), huji("huji", "2026-10-01T00:00:00Z")];
    expect(pickBrowserProfile({ ...base, signIns })).toEqual({
      profileId: "huji",
      reason: "signed-in",
    });
    expect(pickBrowserProfile({ ...base, signIns: [...signIns, huji("main")] })).toEqual({
      profileId: "main",
      reason: "signed-in",
    });
  });

  it("lets this conversation's choice for the site, or one sign-in's other site, win", () => {
    const at = "2026-10-30T10:00:00Z";
    const google = [
      { profileId: "work", sites: ["google.com"] },
      { profileId: "yaacov", sites: ["google.com"] },
    ];
    expect(
      pickBrowserProfile({
        ...base,
        url: "https://docs.google.com/",
        signIns: google,
        choices: choices({
          profileId: "main",
          sites: { "mail.google.com": { profileId: "yaacov", at } },
        }),
      }),
    ).toEqual({ profileId: "yaacov", reason: "site" });
  });

  it("never follows a switch made in another conversation", () => {
    // The latest switch from any conversation used to decide every new tab.
    const elsewhere = {
      projects: {},
      threads: {
        "thread-b": {
          profileId: "work",
          sites: { "portal.huji.ac.il": { profileId: "work", at: "2026-10-31T00:00:00Z" } },
        },
      },
    };
    expect(pickBrowserProfile({ ...base, choices: elsewhere })).toEqual({
      profileId: "main",
      reason: "default",
    });
  });

  it("ignores signed-out and unavailable profiles", () => {
    expect(
      pickBrowserProfile({
        ...base,
        profiles: ["main", "yaacov"],
        signIns: [huji("huji"), { ...huji("yaacov"), signedOut: true }],
        choices: choices({ profileId: "yaacov" }, "work"),
      }),
    ).toEqual({ profileId: "yaacov", reason: "conversation" });
  });

  describe("finding 16, Overleaf", () => {
    const pick = (accounts: ReadonlyArray<(typeof F16_ROWS)[number]>) =>
      pickBrowserProfile({
        url: "https://www.overleaf.com/project",
        threadId: "thread-new",
        projectId: undefined,
        profiles: ["default", ...F16_RECORDS.map((record) => record.profileId)],
        signIns: profileSignIns(accounts),
        choices: undefined,
        defaultProfileId: "default",
      });
    // What `accounts.mainFilled` writes: Main's row for the site, not yet seen working.
    const copied = {
      accountId: "acc_f16overleafmain",
      details: {
        kind: "website",
        sites: ["overleaf.com"],
        username: F16_WORK_USERNAME,
        profileId: "default",
        origin: "browser-session",
      },
      secrets: {},
      signIn: { state: "unknown", at: "2026-11-04T09:00:00.000Z", detail: "Copied from Work" },
      createdAt: "2026-11-04T09:00:00.000Z",
    };

    it("opens Work before a copy, and still Work once Main holds an unchecked copy", () => {
      expect(pick(F16_ROWS)).toEqual({ profileId: "profile-work", reason: "signed-in" });
      expect(pick([...F16_ROWS, copied])).toEqual({
        profileId: "profile-work",
        reason: "signed-in",
      });
    });

    it("opens Main, as the same person, once a look sees Main signed in", () => {
      const seen = { ...copied, signIn: { state: "signed-in", at: "2026-11-04T09:05:00.000Z" } };
      expect(pick([...F16_ROWS, seen])).toEqual({ profileId: "default", reason: "signed-in" });
      expect(seen.details.username).toBe(
        F16_ROWS.find(
          (row) => row.signIn?.state === "signed-in" && row.details.profileId === "profile-work",
        )?.details.username,
      );
    });
  });
});

describe("profileSignIns", () => {
  it("orders a site's identities oldest first, without refused or limited ones", () => {
    const row = (profileId: string, createdAt: string, state = "signed-in") => ({
      details: { kind: "website", profileId, sites: ["google.com"], username: "a@b.co" },
      secrets: {},
      signIn: { state },
      createdAt,
    });
    const rows = [
      row("work", "2026-10-02T00:00:00Z"),
      row("yaacov", "2026-10-01T00:00:00Z"),
      row("refused", "2026-09-01T00:00:00Z", "password-rejected"),
      row("code", "2026-09-01T00:00:00Z", "code-rejected"),
      row("limited", "2026-09-01T00:00:00Z", "limited"),
    ];
    expect(
      siteIdentities(rows, "https://mail.google.com/").map((signIn) => signIn.profileId),
    ).toEqual(["yaacov", "work"]);
    expect(siteIdentities(rows, "https://notgoogle.com/")).toEqual([]);
    expect(siteIdentities(rows, undefined)).toEqual([]);
  });

  it("follows what a check found, in either direction", () => {
    const row = {
      details: { kind: "website", profileId: "work", sites: ["google.com"], username: "a@b.co" },
      secrets: {},
    };
    expect(profileSignIns([{ ...row, signIn: { state: "signed-in" } }])).toEqual([
      { profileId: "work", sites: ["google.com"] },
    ]);
    // Also a sign-in by Scient seen signed out since: the one state is the newer look.
    expect(profileSignIns([{ ...row, signIn: { state: "signed-out" } }])).toEqual([]);
  });

  it("counts recorded sessions and successful sign-ins, never a saved password alone", () => {
    const site = (patch: object) => ({
      details: { kind: "website", profileId: "work", sites: ["huji.ac.il"] },
      secrets: {},
      ...patch,
    });
    const password = { password: { source: { type: "scient" } } };
    expect(
      profileSignIns([
        site({}),
        site({ secrets: password }),
        site({ secrets: password, signIn: { state: "signed-in" } }),
        site({ signIn: { state: "signed-out" } }),
      ]),
    ).toHaveLength(2);
  });
});
