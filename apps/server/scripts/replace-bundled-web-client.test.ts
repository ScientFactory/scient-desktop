import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "vitest";

import { replaceBundledWebClient } from "./replace-bundled-web-client.ts";

describe("replaceBundledWebClient", () => {
  it("removes stale client assets before copying the current web build", async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-web-client-" });
      const webDist = path.join(root, "web-dist");
      const clientTarget = path.join(root, "server-dist", "client");

      yield* fs.makeDirectory(webDist, { recursive: true });
      yield* fs.makeDirectory(clientTarget, { recursive: true });
      yield* fs.writeFileString(path.join(webDist, "index.html"), "current");
      yield* fs.writeFileString(path.join(clientTarget, "stale-logo.svg"), "obsolete");

      expect(yield* replaceBundledWebClient(webDist, clientTarget)).toBe(true);
      expect(yield* fs.readFileString(path.join(clientTarget, "index.html"))).toBe("current");
      expect(yield* fs.exists(path.join(clientTarget, "stale-logo.svg"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });

  it("leaves the existing client untouched when the web build is absent", async () => {
    await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-web-client-" });
      const clientTarget = path.join(root, "server-dist", "client");
      const existingAsset = path.join(clientTarget, "index.html");

      yield* fs.makeDirectory(clientTarget, { recursive: true });
      yield* fs.writeFileString(existingAsset, "existing");

      expect(yield* replaceBundledWebClient(path.join(root, "missing"), clientTarget)).toBe(false);
      expect(yield* fs.readFileString(existingAsset)).toBe("existing");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });
});
