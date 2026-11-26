// @effect-diagnostics globalDate:off -- Watch fixtures use fixed ISO timestamps.
import { describe, expect, it } from "@effect/vitest";

import {
  type LiteratureWatch,
  type LiteratureWatchFound,
  type LiteratureWatchRun,
  literatureWatchCandidates,
  literatureWatchWindow,
  publishLiteratureWatchRun,
  retuneLiteratureWatch,
  triageLiteratureWatchItem,
} from "./literatureWatch.ts";

const now = new Date("2026-11-26T09:00:00Z");

function found(title: string, rest: Partial<LiteratureWatchFound> = {}): LiteratureWatchFound {
  return { title, authors: [], authorCount: 0, ids: {}, services: ["pubmed"], ...rest };
}

function watch(rest: Partial<LiteratureWatch> = {}): LiteratureWatch {
  return {
    formatVersion: 1,
    watchId: "watch-1",
    title: "Replay",
    request: "Hippocampal replay",
    queries: { pubmed: "replay[tiab]" },
    everyDays: 7,
    covered: {},
    seen: [],
    briefings: [],
    createdAt: now.toISOString(),
    createdBy: "agent",
    updatedAt: now.toISOString(),
    ...rest,
  };
}

function run(candidates: ReadonlyArray<LiteratureWatchFound>, delivered?: number) {
  const listed = literatureWatchCandidates(candidates, []).candidates;
  return {
    formatVersion: 1,
    watchId: "watch-1",
    runId: "run-1",
    startedAt: now.toISOString(),
    services: [
      { service: "pubmed", from: "2026-11-17", to: "2026-11-26", status: "complete", found: 2 },
      { service: "arxiv", from: "2026-11-17", to: "2026-11-26", status: "failed", found: 0 },
    ],
    alreadySeen: 0,
    candidates: listed,
    delivered: delivered ?? listed.length,
  } satisfies LiteratureWatchRun;
}

describe("literatureWatchCandidates", () => {
  it("merges a work found by two services and drops works an earlier run judged", () => {
    const result = literatureWatchCandidates(
      [
        found("Replay during sleep predicts planning in rats", {
          ids: { pmid: "1", doi: "10.1/A" },
        }),
        found("Replay during sleep predicts planning in rats.", {
          ids: { doi: "10.1/a", openalex: "W9" },
          services: ["openalex"],
          abstract: "Longer abstract from OpenAlex.",
        }),
        found("Sharp-wave ripples in human hippocampus", { ids: { arxiv: "2611.00001v2" } }),
      ],
      [{ keys: ["arxiv:2611.00001"], fate: "passed", runId: "run-0" }],
    );
    expect(result.alreadySeen).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      candidateId: "c1",
      ids: { pmid: "1", doi: "10.1/A", openalex: "W9" },
      services: ["pubmed", "openalex"],
      abstract: "Longer abstract from OpenAlex.",
    });
  });
});

describe("literatureWatchCandidates title fallback", () => {
  it("keeps two papers that share a title but not a DOI", () => {
    const result = literatureWatchCandidates(
      [
        found("Hippocampal replay supports flexible planning in rats", { ids: { doi: "10.1/a" } }),
        found("Hippocampal replay supports flexible planning in rats", { ids: { doi: "10.1/b" } }),
      ],
      [],
    );
    expect(result.candidates).toHaveLength(2);
  });
});

describe("literatureWatchWindow", () => {
  it("looks back a month first, then resumes from the covered day with overlap", () => {
    expect(literatureWatchWindow(watch(), "pubmed", now)).toEqual({
      from: "2026-10-27",
      to: "2026-11-26",
    });
    const covered = watch({ covered: { pubmed: "2026-11-19", openalex: "2026-11-19" } });
    expect(literatureWatchWindow(covered, "pubmed", now).from).toBe("2026-11-17");
    expect(literatureWatchWindow(covered, "openalex", now).from).toBe("2026-10-27");
  });

  it("keeps reaching back to the watch's first month until a service answers once", () => {
    const failedFirst = watch({ createdAt: "2026-11-12T09:00:00.000Z", covered: {} });
    expect(literatureWatchWindow(failedFirst, "pubmed", now).from).toBe("2026-10-13");
  });

  it("reaches back to the gap when the app was closed longer than the OpenAlex rescan", () => {
    const stale = watch({ covered: { openalex: "2026-09-01" } });
    expect(literatureWatchWindow(stale, "openalex", now).from).toBe("2026-08-30");
  });
});

describe("publishLiteratureWatchRun", () => {
  const candidates = [
    found("Replay during sleep predicts planning in rats", { ids: { pmid: "1" } }),
    found("Unrelated cardiology trial in adults over sixty", { ids: { pmid: "2" } }),
  ];

  it("freezes the picks, records every screened candidate, and moves only services that answered", () => {
    const next = publishLiteratureWatchRun(
      watch({ covered: { arxiv: "2026-11-10" } }),
      run(candidates),
      { picks: [{ candidateId: "c1", why: "On topic.", details: [], evidence: "abstract" }] },
      now,
    );
    expect(next.covered).toEqual({ pubmed: "2026-11-26", arxiv: "2026-11-10" });
    expect(next.seen.map((entry) => entry.fate)).toEqual(["shown", "passed"]);
    expect(next.briefings[0]).toMatchObject({ briefingId: "run-1", screened: 2 });
    expect(next.briefings[0]!.items.map((item) => item.candidate.candidateId)).toEqual(["c1"]);
  });

  it("keeps every service's day when the agent did not see all candidates", () => {
    const next = publishLiteratureWatchRun(watch(), run(candidates, 1), { picks: [] }, now);
    expect(next.covered).toEqual({});
    expect(next.seen).toHaveLength(1);
    expect(next.briefings[0]).toMatchObject({ screened: 1, unscreened: 1 });
  });

  it("refuses a pick the agent was not given", () => {
    expect(() =>
      publishLiteratureWatchRun(
        watch(),
        run(candidates, 1),
        { picks: [{ candidateId: "c2", why: "x", details: [], evidence: "title" }] },
        now,
      ),
    ).toThrow("not a candidate");
  });
});

describe("triageLiteratureWatchItem", () => {
  it("sets and clears what the person did without changing the briefing", () => {
    const published = publishLiteratureWatchRun(
      watch(),
      run([found("Replay during sleep predicts planning in rats", { ids: { pmid: "1" } })]),
      { picks: [{ candidateId: "c1", why: "On topic.", details: [], evidence: "abstract" }] },
      now,
    );
    const target = { briefingId: "run-1", candidateId: "c1" };
    const kept = triageLiteratureWatchItem(
      published,
      target,
      { triage: { action: "kept", at: now.toISOString(), by: "user", sourceId: "s1" } },
      now,
    );
    expect(kept.briefings[0]!.items[0]!.triage?.action).toBe("kept");
    const cleared = triageLiteratureWatchItem(kept, target, { triage: null }, now);
    expect(cleared.briefings[0]!.items[0]).not.toHaveProperty("triage");
    expect(cleared.briefings[0]!.items[0]!.why).toBe("On topic.");
  });
});

describe("retuneLiteratureWatch", () => {
  it("reads the last month again and rejudges passed papers, keeping shown ones", () => {
    const retuned = retuneLiteratureWatch(
      watch({
        covered: { pubmed: "2026-11-25", arxiv: "2026-10-01" },
        seen: [
          { keys: ["pmid:1"], fate: "shown", runId: "run-1" },
          { keys: ["pmid:2"], fate: "passed", runId: "run-1" },
        ],
      }),
      now,
    );
    expect(retuned.covered).toEqual({ pubmed: "2026-10-29", arxiv: "2026-10-01" });
    expect(literatureWatchWindow(retuned, "pubmed", now).from).toBe("2026-10-27");
    expect(retuned.seen.map((entry) => entry.keys[0])).toEqual(["pmid:1"]);
  });
});
