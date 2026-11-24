import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../../config.ts";
import * as DocumentOfficeToolchain from "./DocumentOfficeToolchain.ts";
import { OFFICE_TOOLCHAIN } from "./officeToolchainManifest.ts";

const testConfig = ServerConfig.ServerConfig.layerTest(".", {
  prefix: "document-office-toolchain-",
});
const pinned = `${OFFICE_TOOLCHAIN.engine} ${OFFICE_TOOLCHAIN.version} ${OFFICE_TOOLCHAIN.buildId}`;

describe("Document Lab office toolchain", () => {
  // The fake engine is a POSIX shell script; Windows runs the real engine in qualification.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "is ready only in an opted-in dev app with the pinned engine answering its exact version",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const preview = ServerConfig.layer({
          ...config,
          mode: "desktop",
          devUrl: new URL("http://127.0.0.1:5733"),
        });
        const status = (platform: NodeJS.Platform, arch: NodeJS.Architecture, layer = preview) =>
          DocumentOfficeToolchain.DocumentOfficeToolchain.use((toolchain) => toolchain.status).pipe(
            Effect.provide(DocumentOfficeToolchain.layer.pipe(Layer.provide(layer))),
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.Architecture, arch),
          );
        const officeRoot = path.join(config.baseDir, "document-lab", "office");
        const soffice = path.join(officeRoot, "runtime-1", "program", "soffice");
        yield* fs.makeDirectory(path.dirname(soffice), { recursive: true });
        const engine = (printed: string) =>
          fs
            .writeFileString(soffice, `#!/bin/sh\necho "${printed}"\n`)
            .pipe(Effect.andThen(fs.chmod(soffice, 0o755)));
        yield* engine(pinned);
        const receipt = (overrides: Record<string, unknown> = {}) =>
          fs.writeFileString(
            path.join(officeRoot, "active.json"),
            JSON.stringify({
              version: 1,
              engine: "LibreOffice",
              engineVersion: OFFICE_TOOLCHAIN.version,
              buildId: OFFICE_TOOLCHAIN.buildId,
              platformArch: "linux-x64",
              provisioning: "pinned-archive",
              archiveSha256: OFFICE_TOOLCHAIN.assets["linux-x64"].sha256,
              sofficePath: soffice,
              ...overrides,
            }),
          );

        const released = testConfig.pipe(Layer.provide(NodeServices.layer), Layer.orDie);
        expect(yield* status("linux", "x64", released)).toEqual({
          status: "unavailable",
          reason: "preview-disabled",
        });
        expect(yield* status("linux", "arm64")).toMatchObject({ reason: "unsupported-platform" });
        expect(yield* status("win32", "arm64")).toMatchObject({ reason: "unsupported-platform" });
        expect(yield* status("linux", "x64")).toMatchObject({ reason: "setup-incomplete" });

        yield* receipt({ sofficePath: "/usr/bin/soffice" });
        expect(yield* status("linux", "x64")).toMatchObject({ reason: "setup-incomplete" });
        yield* receipt({ archiveSha256: "0".repeat(64) });
        expect(yield* status("linux", "x64")).toMatchObject({ reason: "setup-incomplete" });
        yield* receipt({ engineVersion: "26.8.3.2" });
        expect(yield* status("linux", "x64")).toMatchObject({ reason: "unpinned-engine" });

        yield* receipt();
        expect(yield* status("linux", "x64")).toEqual({
          status: "ready",
          engine: "LibreOffice",
          version: OFFICE_TOOLCHAIN.version,
          buildId: OFFICE_TOOLCHAIN.buildId,
          platformArch: "linux-x64",
          provisioning: "pinned-archive",
          sofficePath: soffice,
          inputPolicy: "trusted-fixtures",
          isolation: "process-boundary",
        });

        // The receipt alone is not trusted: the engine must print the pinned build.
        yield* engine("LibreOffice 26.2.4.2 another-build");
        expect(yield* status("linux", "x64")).toMatchObject({ reason: "unpinned-engine" });
      }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});
