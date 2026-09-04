import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveAntigravityAcpCatalogAsset } from "@scientfactory/provider-runtime";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import { makeAntigravityInstallation } from "../src/provider/AntigravityInstallation.ts";
import { ManagedRuntimeCatalogDataSchema } from "../src/scient/providerLifecycle/ManagedRuntimeCatalog.ts";

class AntigravityAcpQualificationError extends Schema.TaggedErrorClass<AntigravityAcpQualificationError>()(
  "AntigravityAcpQualificationError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

const fail = (detail: string) => new AntigravityAcpQualificationError({ detail });

const main = Effect.gen(function* () {
  const index = process.argv.indexOf("--catalog");
  const catalogPath = index < 0 ? undefined : process.argv[index + 1];
  if (!catalogPath) return yield* fail("--catalog is required.");
  const fs = yield* FileSystem.FileSystem;
  const catalog = yield* fs
    .readFileString(catalogPath)
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(ManagedRuntimeCatalogDataSchema)),
      ),
    );
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const asset = resolveAntigravityAcpCatalogAsset(catalog, platform, arch);
  if (!asset) return yield* fail(`No approved Antigravity ACP artifact for ${platform}-${arch}.`);
  const baseDir = yield* fs.makeTempDirectoryScoped({
    prefix: "scient-antigravity-acp-qualification-",
  });
  const installation = yield* makeAntigravityInstallation({ baseDir, releaseAsset: asset });
  const started = yield* installation.start;
  const terminal = yield* installation.changes.pipe(
    Stream.filter(
      (state) =>
        state.operationId === started.operationId &&
        ["succeeded", "failed", "cancelled"].includes(state.phase),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
  if (terminal.phase !== "succeeded")
    return yield* fail(terminal.message ?? "ACP installation did not succeed.");
  const executable = yield* installation.resolve();
  if (
    executable.version !== asset.version ||
    executable.registryVersion !== asset.registryVersion
  ) {
    return yield* fail("ACP installed release identity does not match its qualified candidate.");
  }
  // Exercise repair and a fresh service resolving the durable activation record.
  const repaired = yield* installation.startRelease(asset);
  const repairedState = yield* installation.changes.pipe(
    Stream.filter(
      (state) =>
        state.operationId === repaired.operationId &&
        ["succeeded", "failed", "cancelled"].includes(state.phase),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
  if (repairedState.phase !== "succeeded")
    return yield* fail(repairedState.message ?? "ACP repair did not succeed.");
  const reopened = yield* makeAntigravityInstallation({ baseDir, releaseAsset: asset });
  const restored = yield* reopened.resolve();
  if (
    restored.executablePath !== executable.executablePath ||
    restored.registryVersion !== asset.registryVersion
  ) {
    return yield* fail("ACP activation did not survive a service restart.");
  }
  yield* reopened.remove();
  if (yield* fs.exists(installation.managedDirectory))
    return yield* fail("ACP qualification runtime was not removed.");
  yield* Effect.sync(() =>
    process.stdout.write(
      `Antigravity ACP ${asset.registryVersion} (${asset.version}) passed native ${platform}-${arch} install, initialize, repair, activation recovery and removal.\n`,
    ),
  );
});

await Effect.runPromise(
  main.pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
);
