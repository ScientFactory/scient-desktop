import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ComputeOutput, type ComputeOutput as ComputeOutputType } from "./contract.ts";
import {
  projectComputeOutputAreas,
  projectComputeOutputs,
  type ComputeProjectedRepresentation,
} from "./outputProjection.ts";

const decodeOutput = Schema.decodeUnknownSync(ComputeOutput);
const observedAt = (second: number) => `2026-08-23T12:00:${String(second).padStart(2, "0")}.000Z`;
const textBundle = (text: string) => ({
  representations: [{ mediaType: "text/plain", data: { _tag: "text", text } }],
  metadataJson: null,
});
const output = (value: Record<string, unknown>): ComputeOutputType =>
  decodeOutput({ observedAt: observedAt(Number(value.sequence ?? 0)), ...value });

describe("compute output projection", () => {
  it("keeps existing output variants unchanged", () => {
    const stream = output({ _tag: "stream", sequence: 0, stream: "stdout", text: "hello\n" });
    const image = output({
      _tag: "image",
      sequence: 1,
      mediaType: "image/png",
      contentHash: "sha256:image",
      byteLength: 12,
      width: null,
      height: null,
    });

    expect(projectComputeOutputs([stream, image])).toEqual([stream, image]);
  });

  it("projects display data and execute results without losing their origin", () => {
    const projected = projectComputeOutputs([
      output({
        _tag: "display-data",
        sequence: 1,
        bundle: textBundle("display"),
        displayId: "display-1",
      }),
      output({
        _tag: "execute-result",
        sequence: 2,
        bundle: textBundle("42"),
        executionCount: 7,
      }),
    ]);

    expect(projected).toMatchObject([
      { _tag: "representation", kind: "display-data", displayId: "display-1" },
      {
        _tag: "representation",
        kind: "execute-result",
        displayId: null,
        executionCount: 7,
      },
    ]);
  });

  it("updates every matching display across output areas without moving it", () => {
    const areas = projectComputeOutputAreas([
      {
        areaId: "cell-a",
        output: output({
          _tag: "display-data",
          sequence: 1,
          bundle: textBundle("old"),
          displayId: "shared",
        }),
      },
      {
        areaId: "cell-b",
        output: output({
          _tag: "display-data",
          sequence: 2,
          bundle: textBundle("also old"),
          displayId: "shared",
        }),
      },
      {
        areaId: "cell-b",
        output: output({
          _tag: "display-update",
          sequence: 3,
          bundle: textBundle("new"),
          displayId: "shared",
        }),
      },
    ]);

    const first = areas.get("cell-a")?.[0] as ComputeProjectedRepresentation;
    const second = areas.get("cell-b")?.[0] as ComputeProjectedRepresentation;
    expect(first).toMatchObject({ sequence: 1, revisionSequence: 3, bundle: textBundle("new") });
    expect(second).toMatchObject({ sequence: 2, revisionSequence: 3, bundle: textBundle("new") });
  });

  it("does not invent a display when an update has no matching identity", () => {
    expect(
      projectComputeOutputs([
        output({
          _tag: "display-update",
          sequence: 1,
          bundle: textBundle("orphan"),
          displayId: "missing",
        }),
      ]),
    ).toEqual([]);
  });

  it("does not apply an earlier update to a display created afterwards", () => {
    const projected = projectComputeOutputs([
      output({
        _tag: "display-update",
        sequence: 1,
        bundle: textBundle("earlier update"),
        displayId: "shared",
      }),
      output({
        _tag: "display-data",
        sequence: 2,
        bundle: textBundle("new display"),
        displayId: "shared",
      }),
    ]);

    expect(projected).toMatchObject([
      { _tag: "representation", revisionSequence: 2, bundle: textBundle("new display") },
    ]);
  });

  it("clears only the addressed output area and preserves Scient system facts", () => {
    const areas = projectComputeOutputAreas([
      {
        areaId: "cell-a",
        output: output({ _tag: "stream", sequence: 1, stream: "stdout", text: "old a" }),
      },
      {
        areaId: "cell-a",
        output: output({
          _tag: "system",
          sequence: 2,
          event: "output-truncated",
          detail: "bounded",
        }),
      },
      {
        areaId: "cell-b",
        output: output({ _tag: "stream", sequence: 3, stream: "stdout", text: "old b" }),
      },
      { areaId: "cell-a", output: output({ _tag: "clear-output", sequence: 4, wait: false }) },
    ]);

    expect(areas.get("cell-a")).toMatchObject([{ _tag: "system", detail: "bounded" }]);
    expect(areas.get("cell-b")).toMatchObject([{ _tag: "stream", text: "old b" }]);
  });

  it("defers a waiting clear through system facts until the next produced output", () => {
    const projected = projectComputeOutputs([
      output({ _tag: "stream", sequence: 1, stream: "stdout", text: "old" }),
      output({ _tag: "clear-output", sequence: 2, wait: true }),
      output({ _tag: "system", sequence: 3, event: "runtime-warning", detail: "notice" }),
      output({ _tag: "stream", sequence: 4, stream: "stdout", text: "new" }),
    ]);

    expect(projected).toMatchObject([
      { _tag: "system", detail: "notice" },
      { _tag: "stream", text: "new" },
    ]);
  });

  it("cannot resurrect a display by updating it after a waiting clear", () => {
    const projected = projectComputeOutputs([
      output({
        _tag: "display-data",
        sequence: 1,
        bundle: textBundle("old"),
        displayId: "display-1",
      }),
      output({ _tag: "clear-output", sequence: 2, wait: true }),
      output({
        _tag: "display-update",
        sequence: 3,
        bundle: textBundle("new"),
        displayId: "display-1",
      }),
    ]);

    expect(projected).toEqual([]);
  });

  it("folds a large output stream without recursion or mutating retained facts", () => {
    const transcript = Array.from({ length: 20_000 }, (_unused, index) =>
      output({
        _tag: "stream",
        sequence: index,
        observedAt: observedAt(0),
        stream: "stdout",
        text: `line ${String(index)}`,
      }),
    );
    const first = transcript[0];
    const projected = projectComputeOutputs(transcript);

    expect(projected).toHaveLength(20_000);
    expect(projected[0]).toBe(first);
    expect(transcript).toHaveLength(20_000);
  });

  it("projects a large adversarial display-update history in one bounded pass", () => {
    const count = 20_000;
    const facts = Array.from({ length: count }, (_unused, index) => [
      output({
        _tag: "display-data",
        sequence: index,
        observedAt: observedAt(0),
        bundle: textBundle(`initial ${String(index)}`),
        displayId: `display-${String(index)}`,
      }),
      output({
        _tag: "display-update",
        sequence: count + index,
        observedAt: observedAt(1),
        bundle: textBundle(`updated ${String(index)}`),
        displayId: `display-${String(index)}`,
      }),
    ]).flat();

    const projected = projectComputeOutputs(facts);

    expect(projected).toHaveLength(count);
    expect(projected[0]).toMatchObject({
      _tag: "representation",
      revisionSequence: count,
      bundle: textBundle("updated 0"),
    });
    expect(projected.at(-1)).toMatchObject({
      _tag: "representation",
      revisionSequence: count * 2 - 1,
      bundle: textBundle(`updated ${String(count - 1)}`),
    });
  });
});
