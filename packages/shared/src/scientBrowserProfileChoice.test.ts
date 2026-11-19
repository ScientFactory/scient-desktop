import { describe, expect, it } from "@effect/vitest";

import {
  pickBrowserProfile,
  profileRows,
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
  profiles: ["default", "yaacov", "work", "huji"],
  rows: [],
  choices: undefined,
  defaultProfileId: "default",
};
const choices = (
  thread?: { profileId: string; sites?: Record<string, { profileId: string; at: string }> },
  project?: string,
) => ({
  projects: project ? { "project-a": project } : {},
  threads: thread ? { "thread-a": { profileId: thread.profileId, sites: thread.sites ?? {} } } : {},
});

describe("pickBrowserProfile", () => {
  const huji = (profileId: string) => ({ profileId, sites: ["huji.ac.il"] });

  it("keeps the conversation's, then the project's profile while it has a row for the site", () => {
    expect(
      pickBrowserProfile({
        ...base,
        rows: [huji("yaacov"), huji("work")],
        choices: choices({ profileId: "yaacov" }, "work"),
      }),
    ).toEqual({ profileId: "yaacov", reason: "conversation" });
    // A new conversation uses its project's profile, with nothing written for it.
    expect(
      pickBrowserProfile({ ...base, rows: [huji("work")], choices: choices(undefined, "work") }),
    ).toEqual({ profileId: "work", reason: "project" });
    // A page with no site to check keeps the pairing.
    expect(
      pickBrowserProfile({
        ...base,
        url: "http://example.com",
        choices: choices(undefined, "work"),
      }),
    ).toEqual({ profileId: "work", reason: "project" });
  });

  it("sends a paired profile without a row for the site to Main, whoever else is signed in", () => {
    expect(
      pickBrowserProfile({
        ...base,
        rows: [huji("huji")],
        choices: choices({ profileId: "yaacov" }),
      }),
    ).toEqual({ profileId: "default", reason: "main" });
    // Without Main among the eligible profiles, the default.
    expect(
      pickBrowserProfile({
        ...base,
        profiles: ["yaacov", "work"],
        defaultProfileId: "work",
        choices: choices({ profileId: "yaacov" }),
      }),
    ).toEqual({ profileId: "work", reason: "default" });
  });

  it("opens an unpaired tab in the default, even where one profile alone has a row", () => {
    expect(pickBrowserProfile({ ...base, rows: [huji("huji")] })).toEqual({
      profileId: "default",
      reason: "default",
    });
  });

  it("counts a row in any state: imported, copied or signed out", () => {
    const rows = profileRows(
      (["unknown", "signed-out", "password-rejected"] as const).map((state) => ({
        details: { kind: "website", profileId: "work", sites: ["huji.ac.il"] },
        signIn: { state },
      })),
    );
    expect(rows).toHaveLength(3);
    expect(
      pickBrowserProfile({ ...base, rows: rows.slice(1, 2), choices: choices(undefined, "work") }),
    ).toEqual({ profileId: "work", reason: "project" });
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
        rows: google,
        choices: choices({
          profileId: "default",
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
      profileId: "default",
      reason: "default",
    });
  });

  it("skips a paired profile that isn't available", () => {
    expect(
      pickBrowserProfile({
        ...base,
        profiles: ["default", "work"],
        rows: [huji("work")],
        choices: choices({ profileId: "yaacov" }, "work"),
      }),
    ).toEqual({ profileId: "work", reason: "project" });
  });

  describe("finding 16, Overleaf", () => {
    const pick = (paired: string | undefined) =>
      pickBrowserProfile({
        url: "https://www.overleaf.com/project",
        threadId: "thread-new",
        projectId: undefined,
        profiles: ["default", ...F16_RECORDS.map((record) => record.profileId)],
        rows: profileRows(F16_ROWS),
        choices: paired
          ? { projects: {}, threads: { "thread-new": { profileId: paired, sites: {} } } }
          : undefined,
        defaultProfileId: "default",
      });

    it("keeps a conversation paired with Work on Overleaf, where Work has its rows", () => {
      expect(pick("profile-work")).toEqual({ profileId: "profile-work", reason: "conversation" });
      expect(
        F16_ROWS.some(
          (row) =>
            row.details.profileId === "profile-work" && row.details.username === F16_WORK_USERNAME,
        ),
      ).toBe(true);
    });

    it("opens Main for a paired profile with no Overleaf row, and Main without a pairing", () => {
      expect(pick("profile-digitalowl")).toEqual({ profileId: "default", reason: "main" });
      expect(pick(undefined)).toEqual({ profileId: "default", reason: "default" });
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
        site({ signIn: { state: "unknown", from: "import" } }),
        site({ signIn: { state: "unknown", from: "copy" } }),
      ]),
    ).toHaveLength(2);
  });
});
