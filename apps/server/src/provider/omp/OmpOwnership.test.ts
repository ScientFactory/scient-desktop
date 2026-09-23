// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

describe("Oh My Pi ownership inventory", () => {
  it("lists owned files and is checked by the shared seam inventory", () => {
    const root = NodePath.resolve(
      NodeURL.fileURLToPath(new URL(".", import.meta.url)),
      "../../../../../",
    );
    const decodeManifest = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          ownedRoots: Schema.Array(Schema.String),
          ownedFiles: Schema.Array(Schema.String),
          upstreamMounts: Schema.Array(
            Schema.Struct({ path: Schema.String, anchor: Schema.String }),
          ),
        }),
      ),
    );
    const manifest = decodeManifest(
      NodeFS.readFileSync(NodePath.join(root, "scient-omp-seams.json"), "utf8"),
    );
    for (const relative of [
      ...manifest.ownedRoots,
      ...manifest.ownedFiles,
      ...manifest.upstreamMounts.map((mount) => mount.path),
    ]) {
      expect(NodeFS.existsSync(NodePath.join(root, relative)), relative).toBe(true);
    }
    const checker = NodeFS.readFileSync(
      NodePath.join(root, "scripts/scient-seam-check.mjs"),
      "utf8",
    );
    expect(checker.includes('omp: { schema: 2, signals: "ompDiffSignals" }')).toBe(true);
    const rpcDir = NodePath.join(root, "packages/effect-omp-rpc/src");
    for (const name of NodeFS.readdirSync(rpcDir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const source = NodeFS.readFileSync(NodePath.join(rpcDir, name), "utf8");
      expect(source.includes("@t3tools/"), name).toBe(false);
      expect(source.includes("ProviderRuntimeEvent"), name).toBe(false);
    }
    const runtime = NodeFS.readFileSync(
      NodePath.join(root, "apps/server/src/provider/omp/OmpSessionRuntime.ts"),
      "utf8",
    );
    expect(runtime.includes("ProviderRuntimeEvent")).toBe(false);
  });
});
