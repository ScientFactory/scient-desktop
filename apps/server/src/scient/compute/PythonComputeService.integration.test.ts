// @effect-diagnostics nodeBuiltinImport:off -- gated integration test uses an explicitly selected Python.
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ComputeLanguageId } from "@scientfactory/compute";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as OwnedLocalEndpoints from "../../localEndpoints/OwnedLocalEndpointRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as LocalAnalysisStore from "../analysis/LocalAnalysisStore.ts";
import * as LocalDuplexProcess from "../execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import * as LocalComputeStore from "./LocalComputeStore.ts";
import * as ScientificRuntimePreferences from "./ScientificRuntimePreferences.ts";
import { ComputeSessionService, layerWithRuntimeBindings } from "./ComputeSessionService.ts";
import { pythonRuntimeBinding } from "./PythonComputeRuntime.ts";

const TEST_PYTHON = NodeProcess.env.SCIENT_TEST_PYTHON;
const PYTHON = ComputeLanguageId.make("python");

describe.runIf(Boolean(TEST_PYTHON))("Python Compute service integration", () => {
  it.live("starts and closes the real kernel twice through verifyRuntime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        if (!TEST_PYTHON) return yield* Effect.die("SCIENT_TEST_PYTHON is not set.");
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-python-verify-project-",
        });
        const state = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-python-verify-state-",
        });
        const serviceLayer = layerWithRuntimeBindings(
          pythonRuntimeBinding.pipe(Effect.map((binding) => [binding])),
        ).pipe(
          Layer.provide(
            ScientificRuntimePreferences.layer.pipe(
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(LocalAnalysisStore.layer),
            ),
          ),
          Layer.provide(LocalComputeStore.layer),
          Layer.provide(LocalExecutionProcess.layer),
          Layer.provide(LocalDuplexProcess.layer),
          Layer.provide(OwnedLocalEndpoints.layer),
          Layer.provide(ServerConfig.layerTest(cwd, state)),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const verification = yield* service.verifyRuntime({
              languageId: PYTHON,
              executable: TEST_PYTHON,
              workingDirectory: cwd,
              refresh: true,
            });
            expect(verification).toMatchObject({
              readiness: "ready",
              connection: "verified",
              message: "Connection verified. The test session was closed.",
            });
          }
        }).pipe(Effect.provide(serviceLayer));
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("90 seconds")),
  );
});
