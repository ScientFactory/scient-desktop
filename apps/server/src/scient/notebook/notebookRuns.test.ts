import { describe, expect, it } from "@effect/vitest";
import type { ComputeExecutionRecord } from "@t3tools/contracts";

import { mergedReads } from "./notebookRuns.ts";

const cell = (reads?: { files: ReadonlyArray<string>; inputWrites?: ReadonlyArray<string> }) =>
  ({
    result:
      reads === undefined
        ? {}
        : {
            reads: {
              files: reads.files.map((path) => ({ path, size: 1, mtimeNs: "1", ctimeNs: "1" })),
              truncated: false,
              ...(reads.inputWrites === undefined ? {} : { inputWrites: reads.inputWrites }),
            },
          },
  }) as unknown as ComputeExecutionRecord;

describe("a notebook run's inputs", () => {
  it("keeps a file read before a later cell rewrote it, and drops one an earlier cell wrote", async () => {
    const reads = await mergedReads([
      cell({ files: ["/p/lookup.csv"], inputWrites: ["/p/made.csv"] }),
      cell({ files: ["/p/made.csv"], inputWrites: ["/p/lookup.csv"] }),
    ]);
    expect(reads?.files.map((file) => file.path)).toEqual(["/p/lookup.csv"]);
    expect(reads?.truncated).toBe(false);
  });

  it("calls inputs incomplete when a cell has no read record", async () => {
    const reads = await mergedReads([cell({ files: ["/p/a.csv"] }), cell()]);
    expect(reads?.truncated).toBe(true);
  });
});
