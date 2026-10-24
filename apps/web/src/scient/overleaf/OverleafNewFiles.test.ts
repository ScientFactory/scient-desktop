import { describe, expect, it } from "vite-plus/test";

import { actionableDecisions } from "./OverleafNewFiles";
import type { OverleafFileDecision } from "./overleafModel";

const review = {
  additions: [
    { path: "sent.tex", size: 1, selected: true, skippedBecause: null },
    { path: "main.aux", size: 1, selected: false, skippedBecause: "build-output" },
    { path: "huge.bin", size: 60_000_000, selected: false, skippedBecause: "too-large" },
  ],
  localOnly: ["notes.md"],
};

describe("actionableDecisions", () => {
  it("keeps only the decisions the shown review still lists and allows", () => {
    const decisions = new Map<string, OverleafFileDecision>([
      ["sent.tex", "keep"], // a file it sends can be kept here
      ["main.aux", "send"], // a skipped file can be sent
      ["notes.md", "send"], // a file kept only here can be sent
      ["huge.bin", "send"], // Overleaf refuses it: never sent
      ["old.aux", "send"], // no longer listed (deleted)
      ["gone.tex", "keep"],
    ]);
    expect([...actionableDecisions(review, decisions)]).toEqual([
      ["sent.tex", "keep"],
      ["main.aux", "send"],
      ["notes.md", "send"],
    ]);
  });

  it("drops a decision whose file changed sides", () => {
    const decisions = new Map<string, OverleafFileDecision>([
      ["sent.tex", "send"],
      ["main.aux", "keep"],
      ["notes.md", "keep"],
    ]);
    expect(actionableDecisions(review, decisions).size).toBe(0);
    expect(actionableDecisions(null, decisions).size).toBe(0);
  });

  it("keeps decisions a review from a sync that carried them already encodes", () => {
    const encoded = {
      additions: [
        // Kept here: the rule would send it, the review leaves it out.
        { path: "kept.tex", size: 1, selected: false, skippedBecause: null },
        // Sent anyway: the rule skips it, the review selects it.
        { path: "main.aux", size: 1, selected: true, skippedBecause: "build-output" },
      ],
      localOnly: [],
    };
    const decisions = new Map<string, OverleafFileDecision>([
      ["kept.tex", "keep"],
      ["main.aux", "send"],
    ]);
    expect(actionableDecisions(encoded, decisions)).toBe(decisions);
  });
});
