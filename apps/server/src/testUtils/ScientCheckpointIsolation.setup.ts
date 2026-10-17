// @effect-diagnostics nodeBuiltinImport:off - lazy checkout detection at the test-only Git boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import { afterEach, vi } from "vite-plus/test";

import { makeCheckpointIsolationGuard } from "./ScientCheckpointIsolation.test-support.ts";

const checkout = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));
const guard = makeCheckpointIsolationGuard(() =>
  NodeChildProcess.execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      },
    },
  ).trim(),
);

vi.mock("../vcs/ScientCheckpointCapture.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vcs/ScientCheckpointCapture.ts")>();
  return {
    ...actual,
    prepareCheckpointStagingRepo: (
      input: Parameters<typeof actual.prepareCheckpointStagingRepo>[0],
    ) =>
      Effect.sync(() => guard.check(input)).pipe(
        Effect.andThen(actual.prepareCheckpointStagingRepo(input)),
      ),
  };
});

// A completed run or an expected domain error is not permission to ignore a safety violation.
afterEach(() => guard.assertNoViolations());
