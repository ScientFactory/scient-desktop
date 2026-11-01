import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { MANAGED_PYTHON_SPECIFICATIONS } from "../src/scient/compute/managed-python/specifications.ts";
import { ServerCliBuildAssetMissingError } from "./cliErrors.ts";

/**
 * Keep this build path synchronized with STAGED_BRIDGE_DIRECTORY in PythonComputeRuntime.ts. Spell
 * it locally: importing the server module would pull its runtime dependencies into the build
 * script.
 */
export const SCIENT_COMPUTE_BRIDGES = [
  {
    source: "src/scient/compute/bridge/scient_compute_bridge.py",
    asset: "dist/scient-compute-bridge/scient_compute_bridge.py",
  },
  {
    source: "src/scient/compute/bridge/scient_matlab_engine_bridge.py",
    asset: "dist/scient-compute-bridge/scient_matlab_engine_bridge.py",
  },
  {
    source: "src/scient/compute/bridge/scient_sql_kernel.py",
    asset: "dist/scient-compute-bridge/scient_sql_kernel.py",
  },
] as const;
const SCIENT_MANAGED_PYTHON_SOURCE = "src/scient/compute/managed-python";
const SCIENT_MANAGED_PYTHON_ASSET = "dist/scient-managed-python";
export const SCIENT_MANAGED_PYTHON_SPEC_FILES = MANAGED_PYTHON_SPECIFICATIONS.flatMap(
  ({ relativeDirectory }) =>
    ["pyproject.toml", "uv.lock"].map((file) =>
      relativeDirectory === "." ? file : `${relativeDirectory}/${file}`,
    ),
);

export const stageScientServerAssets = Effect.fn("stageScientServerAssets")(function* (
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  // Bridges are runtime data; stage their scripts, never their tests.
  for (const bridge of SCIENT_COMPUTE_BRIDGES) {
    const bridgeSource = path.join(serverDir, bridge.source);
    const bridgeTarget = path.join(serverDir, bridge.asset);
    if (!(yield* fs.exists(bridgeSource))) {
      return yield* new ServerCliBuildAssetMissingError({ assetPath: bridgeSource });
    }
    yield* fs.makeDirectory(path.dirname(bridgeTarget), { recursive: true });
    yield* fs.copyFile(bridgeSource, bridgeTarget);
    yield* Effect.log(`[cli] Staged the compute bridge into ${bridge.asset}`);
  }

  // The locked Scientific Python project is also runtime data. The server
  // copies these exact reviewed inputs into each private generation; it
  // must never resolve a package graph from source code or user config.
  const managedPythonSource = path.join(serverDir, SCIENT_MANAGED_PYTHON_SOURCE);
  const managedPythonTarget = path.join(serverDir, SCIENT_MANAGED_PYTHON_ASSET);
  for (const file of SCIENT_MANAGED_PYTHON_SPEC_FILES) {
    const source = path.join(managedPythonSource, file);
    if (!(yield* fs.exists(source))) {
      return yield* new ServerCliBuildAssetMissingError({ assetPath: source });
    }
    const target = path.join(managedPythonTarget, file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.copyFile(source, target);
  }
  yield* Effect.log(
    `[cli] Staged Scientific Python and MATLAB connection specifications into ${SCIENT_MANAGED_PYTHON_ASSET}`,
  );
});
