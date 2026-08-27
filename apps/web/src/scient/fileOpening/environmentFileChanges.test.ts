import { EnvironmentFilePath, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { environmentFileChanges } from "./environmentFileChanges";

describe("environmentFileChanges", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("shares one subscription atom for the same environment and exact path", () => {
    const target = {
      environmentId,
      input: { path: EnvironmentFilePath.make("/workspace/report.html") },
    };

    expect(environmentFileChanges(target)).toBe(
      environmentFileChanges({
        environmentId,
        input: { path: EnvironmentFilePath.make("/workspace/report.html") },
      }),
    );
  });

  it("isolates different environments and paths", () => {
    const first = environmentFileChanges({
      environmentId,
      input: { path: EnvironmentFilePath.make("/workspace/report.html") },
    });

    expect(
      environmentFileChanges({
        environmentId,
        input: { path: EnvironmentFilePath.make("/workspace/other.html") },
      }),
    ).not.toBe(first);
    expect(
      environmentFileChanges({
        environmentId: EnvironmentId.make("environment-2"),
        input: { path: EnvironmentFilePath.make("/workspace/report.html") },
      }),
    ).not.toBe(first);
  });
});
