import { describe, expect, it } from "@effect/vitest";
import type { AccountSummary, ProjectId } from "@t3tools/contracts";

import { lookClass, pinFor, pinVerdict } from "./taskPins.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const PROJECT = "project-a" as ProjectId;

const row = (overrides: Record<string, unknown> = {}, details: Record<string, unknown> = {}) =>
  ({
    accountId: "acc_hours0001",
    name: "Hours",
    details: {
      kind: "website",
      sites: ["hours.example.test"],
      username: "Dana@Example.test",
      profileId: "work",
      ...details,
    },
    controls: { access: "allowed", scope: { type: "all-projects" } },
    secrets: {},
    signIn: { state: "signed-in", at: "2026-11-26T08:00:00.000Z" },
    ...overrides,
  }) as unknown as AccountSummary;

const pin = pinFor("task:hours", row(), "env-here", PROJECT)!;
const verdict = (
  account: AccountSummary | undefined,
  more: Partial<Parameters<typeof pinVerdict>[0]> = {},
) =>
  pinVerdict({
    pin,
    account,
    environmentId: "env-here",
    projectId: PROJECT,
    agentAccess: true,
    needsYou: [],
    now: NOW,
    ...more,
  }).class;

describe("pinFor", () => {
  it("refuses a sign-in with no username, whose identity a run couldn't check", () => {
    expect(pinFor("task:hours", row({}, { username: undefined }), "env-here", PROJECT)).toBe(
      undefined,
    );
  });
});

describe("pinVerdict", () => {
  it("runs only as the same sign-in, in its profile, on this computer", () => {
    expect(verdict(row(), { environmentId: "env-other" })).toBe("not-allowed");
    expect(verdict(row({}, { profileId: "home" }))).toBe("not-allowed");
    expect(verdict(row({}, { username: "someone@example.test" }))).toBe("not-allowed");
    expect(verdict(undefined)).toBe("not-allowed");
    // An email is the same sign-in whatever its case.
    expect(verdict(row({}, { username: "dana@example.test" }))).toBe("look");
  });

  it("is signed in but not allowed when the row is off or kept to other projects", () => {
    expect(verdict(row({ controls: { access: "off", scope: { type: "all-projects" } } }))).toBe(
      "not-allowed",
    );
    expect(
      verdict(
        row({ controls: { access: "allowed", scope: { type: "projects", projectIds: ["b"] } } }),
      ),
    ).toBe("not-allowed");
  });

  it("knows a waiting sign-in without a visit, and trusts a fresh look", () => {
    expect(
      verdict(row(), {
        needsYou: [
          {
            needId: "sign-in:acc_hours0001",
            name: "Hours",
            detail: "Waiting for you to sign in",
            since: "2026-11-26T11:00:00.000Z",
          },
        ],
      }),
    ).toBe("signed-out");
    expect(verdict(row({ signIn: { state: "signed-in", at: "2026-11-26T11:45:00.000Z" } }))).toBe(
      "worked",
    );
  });
});

describe("lookClass", () => {
  it("tells a site it couldn't reach from a sign-out, and lets a look that couldn't tell run", () => {
    expect(lookClass("unknown", true)).toBe("unreachable");
    expect(lookClass("unknown", false)).toBe("worked");
    // A site limiting access refused it; a sign-in that failed otherwise confirmed nothing.
    expect(lookClass("limited", false)).toBe("not-allowed");
    expect(lookClass("failed", false)).toBe("unreachable");
    expect(lookClass("needs-you", false)).toBe("signed-out");
  });
});
