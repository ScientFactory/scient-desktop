import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";

const RuntimeReceipt = Schema.Struct({
  version: Schema.Literal(1),
  generation: Schema.String.check(Schema.isPattern(/^runtime-[a-zA-Z0-9]{6}$/u)),
  nativeBinDirs: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});

export const DocumentLabRuntimeStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    inputPolicy: Schema.Literal("trusted-fixtures"),
    toolsPath: Schema.String,
    pythonPath: Schema.String,
    nativePathPrefix: Schema.String,
    nodeModulesPath: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["preview-disabled", "setup-incomplete"]),
  }),
]);

export class DocumentLabRuntime extends Context.Service<
  DocumentLabRuntime,
  { readonly status: Effect.Effect<typeof DocumentLabRuntimeStatus.Type> }
>()("t3/scient/documents/DocumentLabRuntime") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeReceipt));
  const status = Effect.fn("DocumentLabRuntime.status")(function* () {
    if (config.mode !== "desktop" || config.devUrl === undefined || platform !== "darwin") {
      return { status: "unavailable", reason: "preview-disabled" } as const;
    }

    const root = path.join(config.baseDir, "document-lab");
    const receipt = yield* fs
      .readFileString(path.join(root, "active.json"))
      .pipe(Effect.flatMap(decodeReceipt), Effect.option);
    if (
      receipt._tag === "None" ||
      receipt.value.nativeBinDirs.some(
        (directory) => !path.isAbsolute(directory) || directory.includes(":"),
      )
    ) {
      return { status: "unavailable", reason: "setup-incomplete" } as const;
    }

    const generationRoot = path.join(root, receipt.value.generation);
    const toolsPath = path.join(generationRoot, "tools");
    const pythonPath = path.join(generationRoot, "python", "bin", "python");
    const nodeModulesPath = path.join(toolsPath, "node", "node_modules");
    const available = yield* Effect.forEach(
      [
        pythonPath,
        path.join(toolsPath, "doc.py"),
        path.join(toolsPath, "gw.py"),
        path.join(nodeModulesPath, "pptxgenjs", "package.json"),
      ],
      (file) =>
        fs.stat(file).pipe(
          Effect.map((info) => info.type === "File"),
          Effect.orElseSucceed(() => false),
        ),
    );
    if (!available.every(Boolean)) {
      return { status: "unavailable", reason: "setup-incomplete" } as const;
    }

    return {
      status: "ready",
      inputPolicy: "trusted-fixtures",
      toolsPath,
      pythonPath,
      nativePathPrefix: receipt.value.nativeBinDirs.join(":"),
      nodeModulesPath,
    } as const;
  });
  return DocumentLabRuntime.of({ status: status() });
});

export const layer = Layer.effect(DocumentLabRuntime, make);
