// @effect-diagnostics nodeBuiltinImport:off -- Raster processes have private execution identities.
import * as NodeCrypto from "node:crypto";
import { ExecutionRunId } from "@scientfactory/execution";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";

/** The native page probe runs before allocating pixels, including rotated pages. */
export function artworkRasterSize(text: string, ratio: number) {
  const size = /^Page(?:\s+1)?\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts\b/mu.exec(text);
  const rotation = /^Page(?:\s+1)?\s+rot:\s+(\d+)\s*$/mu.exec(text);
  if (!size || !rotation || ![0, 90, 180, 270].includes(Number(rotation[1]))) return null;
  let widthPoints = Number(size[1]);
  let heightPoints = Number(size[2]);
  if ([90, 270].includes(Number(rotation[1])))
    [widthPoints, heightPoints] = [heightPoints, widthPoints];
  if (![widthPoints, heightPoints, ratio].every(Number.isFinite) || ratio < 2 || ratio > 3)
    return null;
  const width = Math.ceil((widthPoints * 96 * ratio) / 72);
  const height = Math.ceil((heightPoints * 96 * ratio) / 72);
  if (width <= 0 || height <= 0 || width * height > 16_777_216) return null;
  return { widthPoints, heightPoints, width, height };
}

/** Optional isolated paint; unavailable tools and bounded failures retain the PDF path. */
export const makeLatexArtworkRaster = Effect.gen(function* () {
  const processes = yield* LocalExecutionProcess.ExecutionProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const run = Effect.fn("LatexArtworkRaster.process")(function* (
    executable: string,
    args: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    timeout: "2 seconds" | "5 seconds",
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* Effect.acquireRelease(
          processes.start({
            runId: ExecutionRunId.make(NodeCrypto.randomUUID()),
            executable,
            args: [...args],
            cwd,
            environment,
          }),
          (handle) => handle.cancel.pipe(Effect.ignoreCause()),
        );
        const transcript = yield* Ref.make("");
        const output = yield* handle.output.pipe(
          Stream.runForEach((chunk) =>
            Ref.update(transcript, (text) => (text + chunk.text).slice(-8_000)),
          ),
          Effect.forkScoped,
        );
        const exit = yield* handle.exitCode;
        yield* Fiber.join(output);
        return exit === 0 ? yield* Ref.get(transcript) : null;
      }),
    ).pipe(Effect.timeoutOption(timeout), Effect.map(Option.getOrNull));
  });
  return Effect.fn("LatexArtworkRaster.render")(
    function* (input: {
      pdfPath: string;
      pngPrefix: string;
      cwd: string;
      environment: Readonly<Record<string, string>>;
      ratio: number;
    }) {
      const inherited = { ...hostEnvironment, ...input.environment };
      const info = resolveExecutable("pdfinfo", platform, inherited);
      const paint = resolveExecutable("pdftoppm", platform, inherited);
      if (!info || !paint) return null;
      const text = yield* run(
        info,
        ["-f", "1", "-l", "1", input.pdfPath],
        input.cwd,
        input.environment,
        "2 seconds",
      );
      const size = text === null ? null : artworkRasterSize(text, input.ratio);
      if (!size) return null;
      const pngPath = `${input.pngPrefix}.png`;
      yield* fileSystem.remove(pngPath, { force: true });
      const painted = yield* run(
        paint,
        [
          "-f",
          "1",
          "-l",
          "1",
          "-singlefile",
          "-cropbox",
          "-png",
          "-r",
          String(96 * input.ratio),
          input.pdfPath,
          input.pngPrefix,
        ],
        input.cwd,
        input.environment,
        "5 seconds",
      );
      if (painted === null || (yield* fileSystem.stat(pngPath)).size > 6_000_000n) return null;
      const bytes = yield* fileSystem.readFile(pngPath);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (
        bytes.length < 33 ||
        !signature.every((value, index) => bytes[index] === value) ||
        view.getUint32(8) !== 13 ||
        ![73, 72, 68, 82].every((value, index) => bytes[12 + index] === value)
      )
        return null;
      const width = view.getUint32(16),
        height = view.getUint32(20);
      if (
        !width ||
        !height ||
        width * height > 16_777_216 ||
        Math.abs(width - size.width) > 2 ||
        Math.abs(height - size.height) > 2
      )
        return null;
      return {
        pngBase64: Buffer.from(bytes).toString("base64"),
        widthPoints: size.widthPoints,
        heightPoints: size.heightPoints,
      };
    },
    Effect.catch(() => Effect.succeed(null)),
  );
});
