import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ScientSkillRegistry from "../skills/ScientSkillRegistry.ts";
import * as DocumentLabRuntime from "./DocumentLabRuntime.ts";

const testConfig = ServerConfig.ServerConfig.layerTest(".", { prefix: "document-lab-runtime-" });

describe("Document Lab runtime", () => {
  it.effect("offers the built-in skills only for a complete desktop preview generation", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtime = DocumentLabRuntime.DocumentLabRuntime.use((runtime) => runtime.status);
      const readyConfig = ServerConfig.layer({
        ...config,
        mode: "desktop",
        devUrl: new URL("http://127.0.0.1:5733"),
      });
      const previewRuntime = runtime.pipe(
        Effect.provide(DocumentLabRuntime.layer.pipe(Layer.provide(readyConfig))),
      );
      const previewCatalog = ScientSkillRegistry.ScientSkillRegistry.use(
        (registry) => registry.current,
      ).pipe(
        Effect.provide(ScientSkillRegistry.layerForEnvironment.pipe(Layer.provide(readyConfig))),
      );

      expect(yield* previewRuntime).toEqual({ status: "unavailable", reason: "setup-incomplete" });
      expect(
        (yield* previewCatalog).catalog.releases.some(({ name }) => name === "word-docx"),
      ).toBe(false);

      const root = path.join(config.baseDir, "document-lab");
      const generation = "runtime-ABC123";
      const tools = path.join(root, generation, "tools");
      const python = path.join(root, generation, "python", "bin", "python");
      const nodeModules = path.join(tools, "node", "node_modules");
      for (const file of [
        python,
        path.join(tools, "doc.py"),
        path.join(tools, "gw.py"),
        path.join(nodeModules, "pptxgenjs", "package.json"),
      ]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const receipt = path.join(root, "active.json");
      const payload = { version: 1, generation, nativeBinDirs: ["/opt/homebrew/bin"] };
      yield* fs.writeFileString(receipt, JSON.stringify({ ...payload, generation: "../escape" }));
      expect(yield* previewRuntime).toEqual({ status: "unavailable", reason: "setup-incomplete" });

      yield* fs.writeFileString(receipt, JSON.stringify(payload));
      expect(yield* runtime.pipe(Effect.provide(DocumentLabRuntime.layer))).toEqual({
        status: "unavailable",
        reason: "preview-disabled",
      });
      expect(yield* previewRuntime).toEqual({
        status: "ready",
        inputPolicy: "trusted-fixtures",
        toolsPath: tools,
        pythonPath: python,
        nativePathPrefix: "/opt/homebrew/bin",
        nodeModulesPath: nodeModules,
      });
      const catalog = yield* previewCatalog;
      const word = catalog.catalog.releases.find(({ name }) => name === "word-docx");
      expect(word?.origin).toBe("scient");
      expect(catalog.defaultActive(word!)).toBe(true);
    }).pipe(
      Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.provideService(HostProcess.Platform, "darwin"),
    ),
  );
});
