import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  EnvironmentFilePath,
  EnvironmentFilePrepareError,
  EnvironmentFilePrepareResult,
} from "./fileOpening.ts";

const decodeEnvironmentFilePrepareResult = Schema.decodeUnknownSync(EnvironmentFilePrepareResult);

describe("environment file opening contracts", () => {
  it("accepts a fully classified environment file", () => {
    expect(
      decodeEnvironmentFilePrepareResult({
        canonicalPath: "/Users/researcher/results/figure.svg",
        fileName: "figure.svg",
        byteLength: 1_024,
        mtimeMs: 1_725_000_000_000,
        presentation: {
          kind: "image",
          mediaType: "image/svg+xml",
        },
      }),
    ).toMatchObject({ fileName: "figure.svg", presentation: { kind: "image" } });
  });

  it("rejects NUL paths and invalid metadata", () => {
    expect(() => EnvironmentFilePath.make("/tmp/bad\0file")).toThrow();
    expect(() =>
      decodeEnvironmentFilePrepareResult({
        canonicalPath: "/tmp/file.txt",
        fileName: "file.txt",
        byteLength: -1,
        mtimeMs: null,
        presentation: { kind: "text", mediaType: "" },
      }),
    ).toThrow();
  });

  it("keeps user-facing failures structured and free of filesystem causes", () => {
    const error = new EnvironmentFilePrepareError({
      path: EnvironmentFilePath.make("/missing/paper.pdf"),
      failure: "not_found",
    });
    expect(error.message).toBe("The file no longer exists.");
    expect(error).toMatchObject({
      _tag: "EnvironmentFilePrepareError",
      failure: "not_found",
      path: "/missing/paper.pdf",
    });
  });
});
