import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FilesystemGetMetadataInput } from "./filesystem.ts";

describe("FilesystemGetMetadataInput", () => {
  const decode = Schema.decodeUnknownSync(FilesystemGetMetadataInput);

  it("preserves literal filename whitespace and rejects blank paths", () => {
    const paths = ["/tmp/report", "/tmp/report ", "/tmp/ report"];
    expect(decode({ paths }).paths).toEqual(paths);
    expect(() => decode({ paths: ["   "] })).toThrow();
  });
});
