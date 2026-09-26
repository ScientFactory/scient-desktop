// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

const sourceDirectory = NodePath.resolve(NodeURL.fileURLToPath(new URL(".", import.meta.url)));

describe("Oh My Pi RPC package boundary", () => {
  it("stays a wire client and does not import Scient orchestration", () => {
    const files = NodeFS.readdirSync(sourceDirectory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    const forbidden = [
      "@t3tools/",
      "ProviderRuntimeEvent",
      "node:child_process",
      "child_process",
      "apps/server",
      "Oh My Pi",
    ];
    for (const file of files) {
      const source = NodeFS.readFileSync(NodePath.join(sourceDirectory, file), "utf8");
      for (const pattern of forbidden) {
        expect(source.includes(pattern), `${file} imports ${pattern}`).toBe(false);
      }
    }
  });
});
