import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { BuildArch } from "../lib/build-target-arch.ts";

export const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const decodeNodePtyManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);
export class WslNodePtyPrebuildMissingError extends Schema.TaggedError<WslNodePtyPrebuildMissingError>()(
  "WslNodePtyPrebuildMissingError",
  {
    prebuildPath: Schema.String,
  },
) {
  override get message(): string {
    return `WSL node-pty prebuild not found at ${this.prebuildPath}.`;
  }
}

export class WslNodePtyManifestReadError extends Schema.TaggedError<WslNodePtyManifestReadError>()(
  "WslNodePtyManifestReadError",
  {
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read node-pty version from ${this.manifestPath}.`;
  }
}

// WSL runs the same CPU arch as the Windows host; universal is mac-only.
export const resolveWslPrebuildArch = (arch: BuildArch): "x64" | "arm64" | undefined =>
  arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;

// Stage the prebuilt Linux node-pty binary into the packaged app so the WSL
// backend never compiles on the user's machine. node-pty publishes no Linux
// prebuilt and the WSL Linux Node can't load the Windows/Electron binary, so the
// Linux CI job builds pty.node and hands it here. We drop it into the staged
// node-pty's prebuilds/linux-<arch>/ with a t3code marker the WSL preflight
// checks (arch + node-pty version; the binary is N-API, hence ABI-stable across
// Node versions). A missing prebuild is a warning, not an error, so local and
// non-Windows builds still succeed — they just won't ship a working WSL backend.
export const stageWslNodePtyPrebuild = Effect.fn("stageWslNodePtyPrebuild")(function* (input: {
  readonly stageAppDir: string;
  readonly arch: BuildArch;
  readonly prebuildPath: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (input.prebuildPath === undefined) {
    yield* Effect.logWarning(
      "[desktop-artifact] No WSL node-pty prebuild provided (--wsl-prebuild / T3CODE_DESKTOP_WSL_PREBUILD); the packaged WSL backend will not start until a Linux pty.node is bundled.",
    );
    return;
  }

  const linuxArch = resolveWslPrebuildArch(input.arch);
  if (linuxArch === undefined) {
    yield* Effect.logWarning(
      `[desktop-artifact] No WSL node-pty prebuild mapping for arch "${input.arch}"; skipping WSL backend bundling.`,
    );
    return;
  }

  const prebuildExists = yield* fs
    .exists(input.prebuildPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!prebuildExists) {
    return yield* new WslNodePtyPrebuildMissingError({
      prebuildPath: input.prebuildPath,
    });
  }

  // Resolve through the (pnpm) symlink so we write into the stage's own node-pty
  // copy, never a shared content-addressable store.
  const nodePtyLink = path.join(input.stageAppDir, "node_modules", "node-pty");
  const nodePtyDir = yield* fs.realPath(nodePtyLink).pipe(Effect.orElseSucceed(() => nodePtyLink));

  const manifestPath = path.join(nodePtyDir, "package.json");
  const pkgRaw = yield* fs.readFileString(manifestPath);
  const manifest = yield* decodeNodePtyManifest(pkgRaw).pipe(
    Effect.mapError(
      (cause) =>
        new WslNodePtyManifestReadError({
          manifestPath,
          cause,
        }),
    ),
  );
  const nodePtyVersion = manifest.version;

  const prebuildDir = path.join(nodePtyDir, "prebuilds", `linux-${linuxArch}`);
  yield* fs.makeDirectory(prebuildDir, { recursive: true });
  yield* fs.copyFile(input.prebuildPath, path.join(prebuildDir, "pty.node"));
  const markerJson = yield* encodeJsonString({ arch: linuxArch, nodePtyVersion });
  yield* fs.writeFileString(path.join(prebuildDir, "t3code-wsl-node-pty.json"), `${markerJson}\n`);

  yield* Effect.log(
    `[desktop-artifact] Staged WSL node-pty prebuild (linux-${linuxArch}, node-pty ${nodePtyVersion}).`,
  );
});
