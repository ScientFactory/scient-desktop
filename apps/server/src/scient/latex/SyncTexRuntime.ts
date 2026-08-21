// @effect-diagnostics nodeBuiltinImport:off -- Native runtime receipts are verified at the server boundary.
import * as NodeCrypto from "node:crypto";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";

const RuntimeFile = Schema.Struct({
  file: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
});
const RuntimeReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  component: Schema.Literal("synctex"),
  cliVersion: Schema.String,
  parserVersion: Schema.String,
  platformKey: Schema.String,
  files: Schema.Array(RuntimeFile),
});
const decodeRuntimeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeReceipt));

export type SyncTexRuntimeErrorReason = "damaged" | "missing" | "unsupported";

export class SyncTexRuntimeError extends Schema.TaggedErrorClass<SyncTexRuntimeError>()(
  "SyncTexRuntimeError",
  {
    reason: Schema.Literals(["damaged", "missing", "unsupported"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ResolvedSyncTexRuntime {
  readonly command: string;
  readonly source: "bundled";
}

export function syncTexRuntimePlatformKey(platform: string, architecture: string): string | null {
  const key = `${platform}-${architecture}`;
  return new Set(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]).has(key) ? key : null;
}

function executableName(platform: string): string {
  return platform === "win32" ? "synctex.exe" : "synctex";
}

export class SyncTexRuntime extends Context.Service<
  SyncTexRuntime,
  { readonly resolve: Effect.Effect<ResolvedSyncTexRuntime, SyncTexRuntimeError> }
>()("t3/scient/latex/SyncTexRuntime") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const platformKey = syncTexRuntimePlatformKey(platform, architecture);
  const executable = executableName(platform);

  const resolveUncached = Effect.fn("scient.latex.syncTexRuntime.resolve")(function* () {
    if (platformKey === null) {
      return yield* new SyncTexRuntimeError({
        reason: "unsupported",
        detail: `Scient does not ship source navigation for ${platform}-${architecture}.`,
      });
    }
    const configured = config.syncTexNavigatorPath;
    const bundledCandidates = [
      path.resolve(import.meta.dirname, "synctex-runtime", platformKey, executable),
      path.resolve(import.meta.dirname, "../synctex-runtime", platformKey, executable),
      path.resolve(
        import.meta.dirname,
        "../../../../../native/synctex-runtime",
        platformKey,
        executable,
      ),
    ];
    const candidates = configured === undefined ? bundledCandidates : [configured];
    for (const candidate of candidates) {
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      const directory = path.dirname(candidate);
      const receiptPath = path.join(directory, "provenance.json");
      const verified = yield* Effect.gen(function* () {
        const receipt = yield* fileSystem
          .readFileString(receiptPath)
          .pipe(Effect.flatMap(decodeRuntimeReceipt));
        if (
          receipt.platformKey !== platformKey &&
          !(platform === "darwin" && receipt.platformKey === "darwin-universal")
        )
          return false;
        const expected = receipt.files.find((file) => file.file === path.basename(candidate));
        if (expected === undefined || !/^[a-f0-9]{64}$/u.test(expected.sha256)) return false;
        const bytes = yield* fileSystem.readFile(candidate);
        if (Number(bytes.byteLength) !== expected.size) return false;
        const actual = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        if (actual !== expected.sha256) return false;
        if (platform !== "win32") {
          const stat = yield* fileSystem.stat(candidate);
          // Windows' WSL sidecar is copied out of ASAR byte-for-byte, which
          // deliberately does not preserve POSIX mode bits. Restore only a
          // missing execute bit, and only after the pinned hash is verified;
          // already executable packaged helpers remain completely read-only.
          if ((stat.mode & 0o111) === 0) yield* fileSystem.chmod(candidate, 0o755);
        }
        return true;
      }).pipe(Effect.orElseSucceed(() => false));
      if (!verified) {
        return yield* new SyncTexRuntimeError({
          reason: "damaged",
          detail: "Scient's source-navigation helper failed its integrity check.",
        });
      }
      return { command: candidate, source: "bundled" } as const;
    }
    return yield* new SyncTexRuntimeError({
      reason: "missing",
      detail: "Scient's source-navigation helper is missing.",
    });
  });

  const resolve = yield* Effect.cached(resolveUncached());
  return SyncTexRuntime.of({ resolve });
});

export const layer = Layer.effect(SyncTexRuntime, make);

export const layerTest = (
  runtime: ResolvedSyncTexRuntime = { command: "synctex", source: "bundled" },
) => Layer.succeed(SyncTexRuntime, SyncTexRuntime.of({ resolve: Effect.succeed(runtime) }));
