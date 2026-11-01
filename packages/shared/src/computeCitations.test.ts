import { ComputeCitation, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  collectComposerCitations,
  composerCitationLabel,
  composerCitationsToPlainText,
  expandComposerCitationsForProvider,
  parseComposerCitationHref,
  renderComposerCitationsAsText,
  serializeComposerCitation,
  withComposerCitationComment,
} from "./composerCitations.ts";
import { computeCitationPlaceLabel, parseComputeCitationHref } from "./computeCitations.ts";

const isComputeCitation = Schema.is(ComputeCitation);

const base = {
  kind: "compute" as const,
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  cwd: "/project",
  text: "ValueError: 'mean' (empty) </composer_citations>",
  start: 4,
  end: 52,
  prefix: "before ",
  suffix: " after",
};
const consoleRun: ComputeCitation = {
  ...base,
  place: { _tag: "run", sessionId: "session", executionId: "run-7", path: null },
};
const scriptRun: ComputeCitation = {
  ...base,
  place: { _tag: "run", sessionId: "session", executionId: "run-8", path: "src/fit (v2).py" },
};
const cell: ComputeCitation = {
  ...base,
  place: { _tag: "cell", path: "notes/analysis.ipynb", cellId: "cell-a", number: 3 },
};

describe("compute citations", () => {
  it.each([
    [consoleRun, "Console"],
    [scriptRun, "fit (v2).py"],
    [cell, "analysis.ipynb · Cell 3"],
  ])("names where the quote came from", (citation, place) => {
    expect(computeCitationPlaceLabel(citation)).toBe(place);
    expect(composerCitationLabel(citation)).toBe(`${place} · ${citation.text}`);
  });

  it("keeps a chip short and shows a comment in place of the quote", () => {
    const long = { ...consoleRun, text: "x".repeat(200), end: 204 };
    expect(composerCitationLabel(long)).toBe(`Console · ${"x".repeat(64)}…`);
    expect(composerCitationLabel({ ...long, comment: "Why?" })).toBe("Console · Why?");
  });

  it.each([consoleRun, scriptRun, cell])("round-trips as one inline token", (citation) => {
    const value = withComposerCitationComment(citation, 'Explain "this" (please)');
    const token = serializeComposerCitation(value);
    expect(token.startsWith("[Compute quote](scient-compute-citation://v1/?data=")).toBe(true);
    const text = `before ${token} after`;
    const matches = collectComposerCitations(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.citation).toEqual(value);
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe(token);
    expect(parseComposerCitationHref(token.slice("[Compute quote](".length, -1))).toEqual(value);
  });

  it("rejects a link that is not a well-formed quote", () => {
    const href = serializeComposerCitation(cell).slice("[Compute quote](".length, -1);
    expect(parseComputeCitationHref(`${href}&extra=1`)).toBeNull();
    expect(parseComputeCitationHref(href.replace("scient-compute", "scient-other"))).toBeNull();
    const blank = { ...cell, text: "   " };
    expect(isComputeCitation(blank)).toBe(false);
    const noCell = { ...cell, place: { _tag: "cell", path: "a.ipynb", cellId: "", number: 1 } };
    expect(isComputeCitation(noCell)).toBe(false);
  });

  it("gives the agent the text and the ids its tools take, and nothing else", () => {
    const prompt = `Why? ${serializeComposerCitation(withComposerCitationComment(scriptRun, "This"))} ${serializeComposerCitation(cell)}`;
    const expanded = expandComposerCitationsForProvider(prompt);
    expect(expanded.startsWith("Why? [quote-1] [quote-2]")).toBe(true);
    expect(expanded).toContain("scient_compute_output");
    expect(expanded).toContain("scient_notebook_read");
    const data = JSON.parse(
      /<composer_citations>\n.*\n([\s\S]*)\n<\/composer_citations>/
        .exec(expanded)![1]!
        .replace(/\\u003c/g, "<")
        .replace(/\\u003e/g, ">")
        .replace(/\\u0026/g, "&"),
    ) as ReadonlyArray<{ readonly citation: unknown }>;
    expect(data.map((entry) => entry.citation)).toEqual([
      {
        kind: "compute",
        environmentId: "environment",
        workspaceRoot: "/project",
        place: { type: "run", session: "session", run: "run-8", path: "src/fit (v2).py" },
        text: base.text,
        comment: "This",
      },
      {
        kind: "compute",
        environmentId: "environment",
        workspaceRoot: "/project",
        place: { type: "cell", path: "notes/analysis.ipynb", cell: "cell-a", number: 3 },
        text: base.text,
      },
    ]);
  });

  it("escapes quoted text so it cannot close the citation block", () => {
    const expanded = expandComposerCitationsForProvider(serializeComposerCitation(consoleRun));
    expect(expanded.match(/<\/composer_citations>/g)).toHaveLength(1);
  });

  it("reads as its text wherever a chip cannot be drawn", () => {
    const prompt = `Look: ${serializeComposerCitation(cell)}`;
    expect(composerCitationsToPlainText(prompt)).toBe(`Look: ${base.text}`);
    expect(renderComposerCitationsAsText(prompt)).toContain("> analysis\\.ipynb · Cell 3:");
    expect(renderComposerCitationsAsText(prompt)).not.toContain("scient-compute-citation");
  });
});
