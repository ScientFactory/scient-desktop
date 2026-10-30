import { describe, expect, it } from "@effect/vitest";

import { pickBrowserProfile } from "./scientBrowserProfileChoice.ts";

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
  it("opens a site where it is signed in, over the conversation's profile", () => {
    expect(
      pickBrowserProfile({
        ...base,
        signIns: [{ profileId: "huji", sites: ["huji.ac.il"] }],
        choices: choices({ profileId: "yaacov" }),
      }),
    ).toEqual({ profileId: "huji", signedInSite: "portal.huji.ac.il" });
  });

  it("lets the user's switch for this site in this conversation win over a sign-in", () => {
    const switched = { "portal.huji.ac.il": { profileId: "work", at: "2026-10-30T10:00:00Z" } };
    expect(
      pickBrowserProfile({
        ...base,
        signIns: [{ profileId: "huji", sites: ["huji.ac.il"] }],
        choices: choices({ profileId: "work", sites: switched }),
      }).profileId,
    ).toBe("work");
  });

  it("breaks a tie between signed-in profiles by the latest switch, then the conversation, project and default", () => {
    const signIns = [
      { profileId: "work", sites: ["huji.ac.il"] },
      { profileId: "huji", sites: ["huji.ac.il"] },
    ];
    expect(pickBrowserProfile({ ...base, signIns }).profileId).toBe("work");
    expect(
      pickBrowserProfile({ ...base, signIns, choices: choices(undefined, "huji") }).profileId,
    ).toBe("huji");
    const elsewhere = {
      projects: {},
      threads: {
        "thread-b": {
          profileId: "huji",
          sites: { "portal.huji.ac.il": { profileId: "huji", at: "2026-10-30T09:00:00Z" } },
        },
      },
    };
    expect(pickBrowserProfile({ ...base, signIns, choices: elsewhere }).profileId).toBe("huji");
  });

  it("ignores signed-out and unavailable profiles, then falls back to conversation, project and default", () => {
    expect(
      pickBrowserProfile({
        ...base,
        profiles: ["main", "yaacov"],
        signIns: [
          { profileId: "huji", sites: ["huji.ac.il"] },
          { profileId: "yaacov", sites: ["huji.ac.il"], signedOut: true },
        ],
        choices: choices({ profileId: "yaacov" }, "work"),
      }),
    ).toEqual({ profileId: "yaacov" });
    expect(
      pickBrowserProfile({ ...base, url: undefined, choices: choices(undefined, "work") }),
    ).toEqual({ profileId: "work" });
    expect(pickBrowserProfile({ ...base, url: "http://example.com" })).toEqual({
      profileId: "main",
    });
  });
});
