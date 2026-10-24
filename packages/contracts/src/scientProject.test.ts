import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { ScientProjectInitializeRequest } from "./scientProject.ts";

const decodeInitializeRequest = Schema.decodeUnknownSync(ScientProjectInitializeRequest);

describe("Scient project contracts", () => {
  it("accepts bounded initialization requests", () => {
    expect(decodeInitializeRequest({ root: "/tmp/study" })).toEqual({ root: "/tmp/study" });
    expect(() => decodeInitializeRequest({ root: "  " })).toThrow();
  });
});
