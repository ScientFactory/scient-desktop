// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as ServerConfig from "./config.ts";
import { DEFAULT_SPEECH_MODEL_ID, getSpeechModel } from "./speech/model.ts";
import { loadNativeSpeechModel } from "./speech/native.ts";
import * as SpeechModelStore from "./speech/SpeechModelStore.ts";

const cache = process.argv[2];
const model = getSpeechModel(DEFAULT_SPEECH_MODEL_ID);
NodeAssert.ok(model);
const cachedModel = cache && NodePath.join(cache, model.filename);
const install = Effect.gen(function* () {
  const store = yield* SpeechModelStore.SpeechModelStore;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  if (cachedModel && (yield* fs.exists(cachedModel))) {
    const directory = NodePath.join(stateDir, "speech", "models");
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.copyFile(cachedModel, NodePath.join(directory, model.filename));
    const verified = yield* store.installedPath(model);
    if (verified) return { path: verified, cacheHit: true };
  }
  const path = yield* store.download(model);
  NodeAssert.equal(yield* store.installedPath(model), path);
  if (cachedModel) yield* fs.copyFile(path, cachedModel);
  return { path, cacheHit: false };
});

const fixtureSha = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e";
const fixtureUrl =
  "https://raw.githubusercontent.com/ggml-org/whisper.cpp/f049fff95a089aa9969deb009cdd4892b3e74916/samples/jfk.wav";
const cachedWav = cache && NodePath.join(cache, "jfk.wav");
const validWav = (wav: Buffer) =>
  NodeCrypto.createHash("sha256").update(wav).digest("hex") === fixtureSha;

async function loadFixture(): Promise<Buffer> {
  if (cachedWav) {
    const bytes = await NodeFSP.readFile(cachedWav).catch(() => null);
    if (bytes && validWav(bytes)) {
      console.log("Reused the verified speech fixture from cache.");
      return bytes;
    }
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(fixtureUrl, { signal: AbortSignal.timeout(30_000) });
      NodeAssert.ok(response.ok, `Audio fixture download failed: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      NodeAssert.ok(validWav(bytes), "Audio fixture checksum mismatch");
      if (cachedWav) await NodeFSP.writeFile(cachedWav, bytes);
      return bytes;
    } catch (error) {
      if (attempt === 3) throw error;
      await NodeTimersPromises.setTimeout(500 * attempt);
    }
  }
}

const wav = await loadFixture();
const { path, cacheHit } = await Effect.runPromise(
  install.pipe(
    Effect.provide(
      SpeechModelStore.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer, FetchHttpClient.layer),
        ),
      ),
    ),
  ),
);

if (cacheHit) console.log("Reused the verified speech model from cache.");

// From this point any network request from the host-side inference code fails.
globalThis.fetch = async () => {
  throw new Error("Network disabled during inference");
};

let pcm: Float32Array | undefined;
for (let offset = 12; offset + 8 <= wav.length;) {
  const size = wav.readUInt32LE(offset + 4);
  if (wav.toString("ascii", offset, offset + 4) === "data") {
    pcm = Float32Array.from(
      { length: size / 2 },
      (_, index) => wav.readInt16LE(offset + 8 + index * 2) / 32768,
    );
    break;
  }
  offset += 8 + size + (size % 2);
}
NodeAssert.ok(pcm && pcm.length > 0, "Missing speech samples");

const controller = new AbortController();
const direct = await loadNativeSpeechModel(path, controller.signal, undefined, "cpu");
await direct.dispose();

const packagePath = NodeModule.findPackageJSON("transcribe-cpp", import.meta.url);
NodeAssert.ok(packagePath);
const fallbackFixture = `data:text/javascript,${encodeURIComponent(`
  import { createRequire } from "node:module";
  const speech = createRequire(${JSON.stringify(packagePath)})(
    ${JSON.stringify(NodePath.join(NodePath.dirname(packagePath), "dist/index.js"))}
  );
  export const artifactDir = speech.artifactDir;
  export const TranscribeModel = {
    load(path, options) {
      if (options.backend !== "cpu") throw new Error("Simulated accelerator initialization failure");
      return speech.TranscribeModel.load(path, options);
    },
  };
`)}`;
const worker = await loadNativeSpeechModel(path, controller.signal, fallbackFixture);
try {
  const options = { language: "en", timestamps: "none" } as const;
  const transcript = await worker.transcribe(pcm, options, false);
  NodeAssert.match(
    transcript.text.replace(/[.,]/g, ""),
    /ask not what your country can do for you/i,
  );
  NodeAssert.match(worker.backend, /cpu/i);
  const pending = worker.transcribe(pcm, options, false);
  controller.abort();
  await NodeAssert.rejects(pending);
  NodeAssert.ok(worker.isStopped());
} finally {
  await worker.dispose();
}
console.log("Packaged speech model installation, CPU fallback, inference and cancellation passed.");
