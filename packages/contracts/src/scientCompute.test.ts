import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ComputeRuntimeInspection } from "./scientCompute.ts";

const decodeRuntimeInspection = Schema.decodeUnknownSync(ComputeRuntimeInspection);

describe("scient compute contracts", () => {
  it("keeps pre-Toolkit runtime-inspection payloads readable", () => {
    const inspection = decodeRuntimeInspection({
      contractVersion: 1,
      scope: "environment",
      languages: [
        {
          descriptor: {
            languageId: "python",
            displayName: "Python",
            sourceExtensions: [".py"],
            capabilities: ["execute"],
          },
          enabled: true,
          configuredExecutable: null,
          runtimes: [
            {
              profile: {
                languageId: "python",
                source: "path",
                executable: "/usr/bin/python3",
                languageVersion: "3.12.0",
                architecture: "arm64",
                displayName: "Python 3.12.0",
              },
              verification: {
                profile: {
                  languageId: "python",
                  source: "path",
                  executable: "/usr/bin/python3",
                  languageVersion: "3.12.0",
                  architecture: "arm64",
                  displayName: "Python 3.12.0",
                },
                readiness: "ready",
                missingRequirements: [],
                message: null,
              },
            },
          ],
        },
      ],
    });

    expect(inspection.languages[0]?.toolkits).toEqual([]);
    expect(inspection.languages[0]?.runtimes[0]?.toolkits).toEqual([]);
    expect(inspection.languages[0]?.runtimes[0]?.verification.packages).toEqual([]);
  });
});
