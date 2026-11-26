import { describe, expect, it, vi } from "vite-plus/test";

import {
  agentVerificationLabel,
  newlyObservedSourceIds,
  observeLibraryList,
  sourceAddedLabel,
  sourcePinLabel,
} from "./sourceLabels";

describe("sourceAddedLabel", () => {
  it("prioritizes the transient just-added state", () => {
    expect(sourceAddedLabel("not-a-date", true)).toBe("Just added");
  });

  it("uses Added today for the current local calendar day", () => {
    const today = "2026-10-20T12:00:00.000Z";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(today));
      expect(sourceAddedLabel(today, false)).toBe("Added today");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a formatted date for older sources", () => {
    expect(sourceAddedLabel("2020-01-02T12:00:00.000Z", false)).toMatch(/^Added /u);
  });
});

describe("agentVerificationLabel", () => {
  it.each([
    { origin: { actor: "user" }, verification: { state: "verified" as const }, label: "" },
    { origin: { actor: "agent" }, verification: undefined, label: "" },
    {
      origin: { actor: "agent" },
      verification: { state: "unchecked" as const },
      label: " · Not yet checked",
    },
  ])("labels $origin.actor sources with $verification", ({ label, ...record }) => {
    expect(agentVerificationLabel(record)).toBe(label);
  });
});

describe("newlyObservedSourceIds", () => {
  const TEN_MINUTES = 10 * 60_000;
  const at = (time: string) => Date.parse(`2026-08-30T${time}:00.000Z`);
  const source = (sourceId: string, time: string, actor = "user") => ({
    sourceId,
    importedAt: `2026-08-30T${time}:00.000Z`,
    origin: { actor },
  });
  const read = (time: string, ...sourceIds: ReadonlyArray<string>) => ({
    firstReadAt: at(time),
    sourceIds: new Set(sourceIds),
  });

  it("on a tab's first read marks only an agent's additions of the last ten minutes", () => {
    const records = [
      source("user-now", "13:35"),
      source("agent-now", "13:36", "agent"),
      source("agent-earlier", "13:00", "agent"),
    ];
    expect(newlyObservedSourceIds(records, null, at("13:40"), TEN_MINUTES)).toEqual(["agent-now"]);
  });

  it("marks what arrived since the window first read the Library, however long ago that was", () => {
    // Nobody looked for an hour; an agent added a paper forty minutes ago.
    const records = [source("seen", "12:00"), source("while-away", "13:00", "agent")];
    expect(
      newlyObservedSourceIds(records, read("12:20", "seen"), at("13:40"), TEN_MINUTES),
    ).toEqual(["while-away"]);
  });

  it("never marks a source only new to this list: another scope, or one back from the Trash", () => {
    const records = [source("in-project", "12:00"), source("library-only", "09:00")];
    expect(
      newlyObservedSourceIds(records, read("13:39", "in-project"), at("13:40"), TEN_MINUTES),
    ).toEqual([]);
  });

  it("never marks a pin served from its snapshot, as one moved to the Trash is", () => {
    const records = [{ ...source("snapshot", "13:39"), fromSnapshot: true as const }];
    expect(newlyObservedSourceIds(records, read("13:30"), at("13:40"), TEN_MINUTES)).toEqual([]);
  });
});

describe("observeLibraryList", () => {
  const TEN_MINUTES = 10 * 60_000;
  const at = (time: string) => Date.parse(`2026-11-25T${time}:00.000Z`);
  const source = (sourceId: string, time: string, actor = "user") => ({
    sourceId,
    importedAt: `2026-11-25T${time}:00.000Z`,
    origin: { actor },
  });

  it("never marks a paper the project showed when the no-project Library opens", () => {
    const observations = new Map();
    // The no-project Library was last read while empty; the work then went on in the project.
    expect(observeLibraryList(observations, "env", [], at("19:27"), TEN_MINUTES)).toEqual([]);
    const papers = [source("attention", "19:29"), source("neuromorphic", "19:28")];
    observeLibraryList(observations, "env", papers, at("19:30"), TEN_MINUTES);
    expect(observeLibraryList(observations, "env", papers, at("19:42"), TEN_MINUTES)).toEqual([]);
  });

  it("marks what an agent added to My Library while the project was shown, on switching", () => {
    const observations = new Map();
    const pinned = source("pinned", "12:00");
    observeLibraryList(observations, "env", [pinned], at("13:00"), TEN_MINUTES);
    // The agent's paper is not in the project, so the project's later reads never show it.
    observeLibraryList(observations, "env", [pinned], at("13:06"), TEN_MINUTES);
    expect(
      observeLibraryList(
        observations,
        "env",
        [pinned, source("library-only", "13:03", "agent"), source("old", "09:00")],
        at("13:10"),
        TEN_MINUTES,
      ),
    ).toEqual(["library-only"]);
  });

  it("marks what an agent added while the window showed no Library", () => {
    const observations = new Map();
    const seen = source("seen", "12:00");
    observeLibraryList(observations, "env", [seen], at("12:20"), TEN_MINUTES);
    expect(
      observeLibraryList(
        observations,
        "env",
        [seen, source("while-away", "13:00", "agent")],
        at("13:40"),
        TEN_MINUTES,
      ),
    ).toEqual(["while-away"]);
  });
});

describe("sourcePinLabel", () => {
  it("marks pins only in the Library view, and a pin this library lacks in either view", () => {
    expect(sourcePinLabel({ pinned: true }, "library")).toBe(" · In this project");
    expect(sourcePinLabel({ pinned: false }, "library")).toBe("");
    expect(sourcePinLabel({ pinned: true }, "project")).toBe("");
    expect(sourcePinLabel({}, undefined)).toBe("");
    expect(sourcePinLabel({ pinned: true, fromSnapshot: true }, "project")).toBe(
      " · Not in this Library",
    );
  });
});
