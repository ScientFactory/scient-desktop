import { describe, expect, it } from "@effect/vitest";

import { planInstall } from "./PythonLibraries.ts";

describe("planInstall", () => {
  // Python writes text with CRLF on Windows.
  const present = ["numpy\t2.3.4", "python-dateutil\t4.0.0", "torch\t2.9.0+cu121"].join("\r\n");

  it("installs only what the kernel lacks, a local build standing for its public version", () => {
    const resolved = [
      "numpy==2.3.4",
      "pandas==3.1.1",
      "Python_DateUtil==4.0.0",
      "    # via pandas",
      "torch==2.9.0",
      "tzdata==2026.6",
    ].join("\n");
    expect(planInstall(present, resolved)).toEqual({
      missing: ["pandas==3.1.1", "tzdata==2026.6"],
      conflicts: [],
    });
  });

  it("refuses a resolution that needs another version of something installed", () => {
    expect(planInstall(present, "torch==3.0.0\ntorchvision==0.30.0").conflicts).toEqual([
      "torch 3.0.0, but this environment has 2.9.0+cu121",
    ]);
  });
});
