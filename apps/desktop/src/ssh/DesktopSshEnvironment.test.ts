import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDesktopSshCliRunner } from "./DesktopSshEnvironment.ts";

const packagedEnvironment = DesktopEnvironment.DesktopEnvironment.pipe(
  Effect.provide(
    DesktopEnvironment.layer({
      dirname: "/Applications/T3 Code.app/Contents/Resources/app.asar/dist-electron",
      homeDirectory: "/Users/alice",
      platform: "darwin",
      processArch: "arm64",
      appVersion: "0.0.22",
      appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
      ),
    ),
  ),
);

describe("resolveDesktopSshCliRunner", () => {
  // SCIENT-FORK:START — the remote runs this release's Scient server package; a mirror is ignored.
  it.effect("runs the Scient server published with this release, not a mirror's archive", () =>
    Effect.gen(function* () {
      const environment = yield* packagedEnvironment;

      const runner = resolveDesktopSshCliRunner(environment, {
        T3CODE_RELEASE_BASE_URL: "https://mirror.example.com/t3code",
      });

      const packageSpec = resolveRemoteT3CliPackageSpec({ appVersion: "0.0.22" });
      assert.isDefined(packageSpec);
      assert.deepStrictEqual(runner, {
        packageSpec,
        nodeEngineRange: serverPackageJson.engines.node,
      });
    }),
  );
  // SCIENT-FORK:END
});
