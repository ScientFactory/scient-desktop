import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  ScientProjectInitializationResult,
  ScientProjectInitializeRequest,
} from "./scientProject.ts";

const decodeInitializeRequest = Schema.decodeUnknownSync(ScientProjectInitializeRequest);
const decodeInitializationResult = Schema.decodeUnknownSync(ScientProjectInitializationResult);

describe("Scient project contracts", () => {
  it("accepts bounded initialization requests", () => {
    expect(decodeInitializeRequest({ root: "/tmp/study" })).toEqual({ root: "/tmp/study" });
    expect(() => decodeInitializeRequest({ root: "  " })).toThrow();
  });

  it("decodes an initialized result", () => {
    const result = decodeInitializationResult({
      root: "/tmp/study",
      state: "initialized",
      canInitialize: false,
      issues: [],
      existingFiles: ["PROJECT.md", ".scient/project.json"],
      created: ["PROJECT.md", ".scient/project.json"],
      preserved: [],
    });
    expect(result.state).toBe("initialized");
  });
});
