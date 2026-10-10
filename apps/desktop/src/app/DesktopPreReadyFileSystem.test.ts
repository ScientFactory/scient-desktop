import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("preserves exclusive file ownership during pre-ready startup", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-pre-ready-fs-" });
      const userData = path.join(root, "electron-userdata");
      const statePath = path.join(userData, "Local State");
      const startupFs = DesktopPreReadyFileSystem.make;
      assert.isFalse(yield* startupFs.exists(statePath));
      yield* startupFs.makeDirectory(userData, { recursive: true });
      yield* startupFs.writeFileString(statePath, "owned state", { flag: "wx" });
      const error = yield* startupFs
        .writeFileString(statePath, "replacement", { flag: "wx" })
        .pipe(Effect.flip);
      assert.equal(error.reason._tag, "AlreadyExists");
      assert.equal(yield* startupFs.readFileString(statePath), "owned state");
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "fails instead of treating an unreadable profile as missing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-pre-ready-fs-" });
        const statePath = path.join(root, "Local State");
        yield* fileSystem.writeFileString(statePath, "owned state");
        yield* fileSystem.chmod(root, 0o000);
        yield* Effect.addFinalizer(() => fileSystem.chmod(root, 0o700).pipe(Effect.orDie));

        const exit = yield* Effect.exit(DesktopPreReadyFileSystem.make.exists(statePath));

        assert.isTrue(Exit.isFailure(exit));
      }),
  );
});
