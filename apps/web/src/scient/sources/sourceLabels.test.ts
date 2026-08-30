import { describe, expect, it } from "vite-plus/test";

import { newlyObservedSourceIds, sourceAddedLabel } from "./sourceLabels";

describe("sourceAddedLabel", () => {
  it("prioritizes the transient just-added state", () => {
    expect(sourceAddedLabel("not-a-date", true)).toBe("Just added");
  });

  it("identifies agent-added sources during the transient state", () => {
    expect(sourceAddedLabel("not-a-date", true, true)).toBe("Just added by an agent");
  });

  it("uses Added today for the current local calendar day", () => {
    expect(sourceAddedLabel(new Date().toISOString(), false)).toBe("Added today");
  });

  it("falls back to a formatted date for older sources", () => {
    expect(sourceAddedLabel("2020-01-02T12:00:00.000Z", false)).toMatch(/^Added /u);
  });
});

describe("newlyObservedSourceIds", () => {
  const recentCutoff = Date.parse("2026-08-30T13:30:00.000Z");
  const recentUserSource = {
    sourceId: "recent-user",
    importedAt: "2026-08-30T13:35:00.000Z",
    origin: { actor: "user" },
  };
  const recentAgentSource = {
    sourceId: "recent-agent",
    importedAt: "2026-08-30T13:36:00.000Z",
    origin: { actor: "agent" },
  };
  const newlyAddedUserSource = {
    sourceId: "new-user",
    importedAt: "2026-08-30T13:37:00.000Z",
    origin: { actor: "user" },
  };
  const olderSource = {
    sourceId: "older-user",
    importedAt: "2026-08-30T12:00:00.000Z",
    origin: { actor: "user" },
  };

  it("does not treat recent user records as newly added on the initial overview", () => {
    expect(newlyObservedSourceIds([recentUserSource, olderSource], null, recentCutoff)).toEqual([]);
  });

  it("keeps recent agent additions discoverable on the initial overview", () => {
    expect(
      newlyObservedSourceIds([recentUserSource, recentAgentSource], null, recentCutoff),
    ).toEqual(["recent-agent"]);
  });

  it("marks only IDs that appear after an established overview baseline", () => {
    expect(
      newlyObservedSourceIds(
        [olderSource, recentUserSource, newlyAddedUserSource],
        new Set([olderSource.sourceId, recentUserSource.sourceId]),
        recentCutoff,
      ),
    ).toEqual(["new-user"]);
  });
});
