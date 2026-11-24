import { expect, it } from "vitest";
import { ComputeResultRevisionId, type NotebookAlternatives } from "@t3tools/contracts";

import {
  alternativeAt,
  readerBaseline,
  renderAlternativeProse,
  sweepValues,
} from "./notebookReaderModel";

const currentSource = "a".repeat(64);

it("matches normalized settings and changes only values from this notebook", () => {
  const published = {
    revision: ComputeResultRevisionId.make("r000000000001"),
    parameters: [
      { name: "x", source: "default", value: "1" },
      { name: "flag", source: "default", value: "true" },
    ],
    notebookDigestVersion: 1,
    codeSha256: currentSource,
    outputs: [],
    values: [{ output: "metrics.json", pointer: "/n", value: "10" }],
  } satisfies NotebookAlternatives["runs"][number];
  const alternative = {
    ...published,
    revision: ComputeResultRevisionId.make("r000000000002"),
    parameters: [
      { name: "flag", source: "default", value: "true" },
      { name: "x", source: "override", value: "2.0" },
    ],
    values: [{ output: "metrics.json", pointer: "/n", value: "20" }],
  } satisfies NotebookAlternatives["runs"][number];
  const runs: NotebookAlternatives["runs"] = [published, alternative];
  expect(alternativeAt(runs, published, { x: "2" }, currentSource)).toEqual({
    current: alternative,
    sourceStatus: "current",
  });
  expect(alternativeAt(runs, published, { x: "3" }, currentSource)).toEqual({
    current: null,
    sourceStatus: null,
  });
  expect(
    alternativeAt(
      [published, { ...alternative, codeSha256: "b".repeat(64) }],
      published,
      {
        x: "2",
      },
      currentSource,
    ),
  ).toEqual({ current: null, sourceStatus: "earlier" });
  expect(alternativeAt(runs, published, {}, undefined)).toEqual({
    current: published,
    sourceStatus: "unconfirmed",
  });
  const sameSetting = { ...alternative, parameters: published.parameters };
  expect(alternativeAt([sameSetting, published], published, {}, currentSource)).toEqual({
    current: published,
    sourceStatus: "current",
  });
  const old = { ...alternative, codeSha256: "b".repeat(64) };
  const legacy = { ...alternative, notebookDigestVersion: undefined };
  expect(readerBaseline([old, legacy, alternative], null, currentSource)).toBe(alternative);
  expect(readerBaseline([old], null, currentSource)).toBeUndefined();
  expect(alternativeAt([published, legacy], published, { x: "2" }, currentSource)).toEqual({
    current: null,
    sourceStatus: "unconfirmed",
  });
  expect(alternativeAt([old, sameSetting], old, { x: "1" }, currentSource)).toEqual({
    current: sameSetting,
    sourceStatus: "current",
  });
  const prose =
    "[10](scient-result:r000000000001/metrics.json#/n), [6](scient-result:r000000000003/metrics.json#/n)";
  const revisions = new Set(["r000000000001", "r000000000002"]);
  expect(renderAlternativeProse(prose, revisions, alternative, "Missing")).toBe(
    "[20](scient-result:r000000000002/metrics.json#/n), [6](scient-result:r000000000003/metrics.json#/n)",
  );
  expect(renderAlternativeProse(prose, revisions, null, "Missing")).toContain("[Missing]");
  expect(sweepValues({ min: 0.3, max: 0.7, step: 0.1 })).toEqual([
    "0.3",
    "0.4",
    "0.5",
    "0.6",
    "0.7",
  ]);
});

it("opens the newest legacy sweep setting and browses retained settings with unconfirmed source", () => {
  const older = {
    revision: ComputeResultRevisionId.make("r000000000001"),
    finishedAt: "2026-11-23T10:00:00Z",
    parameters: [{ name: "x", source: "override", value: "1" }],
    values: [{ output: "metrics.json", pointer: "/n", value: "10" }],
    outputs: [],
  } satisfies NotebookAlternatives["runs"][number];
  const newest = {
    ...older,
    revision: ComputeResultRevisionId.make("r000000000002"),
    finishedAt: "2026-11-23T11:00:00Z",
    parameters: [{ name: "x", source: "override", value: "2" }],
    values: [{ output: "metrics.json", pointer: "/n", value: "20" }],
  } satisfies NotebookAlternatives["runs"][number];
  const runs = [newest, older];
  const baseline = readerBaseline(runs, null, currentSource);
  expect(alternativeAt(runs, baseline, {}, currentSource, null)).toEqual({
    current: newest,
    sourceStatus: "unconfirmed",
  });
  expect(alternativeAt(runs, baseline, { x: "1" }, currentSource, null)).toEqual({
    current: older,
    sourceStatus: "unconfirmed",
  });
});
