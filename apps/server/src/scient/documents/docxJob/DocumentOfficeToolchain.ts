import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import {
  OFFICE_TOOLCHAIN,
  isPinnedOfficeVersion,
  officePlatformArch,
} from "./officeToolchainManifest.ts";
import {
  OfficeRenderError,
  OfficeRenderer,
  makeOfficeRenderer,
  probeOfficeVersion,
} from "./OfficeRenderer.ts";

const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  engine: Schema.Literal("LibreOffice"),
  engineVersion: Schema.String,
  buildId: Schema.String,
  platformArch: Schema.String,
  provisioning: Schema.Literals(["pinned-archive", "host-install"]),
  archiveSha256: Schema.NullOr(Schema.String),
  sofficePath: Schema.String,
});

export const OfficeToolchainStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    engine: Schema.Literal("LibreOffice"),
    version: Schema.String,
    buildId: Schema.String,
    platformArch: Schema.String,
    /** `host-install` passed the exact version check but its bytes were not digest-verified. */
    provisioning: Schema.Literals(["pinned-archive", "host-install"]),
    sofficePath: Schema.String,
    inputPolicy: Schema.Literal("trusted-fixtures"),
    isolation: Schema.Literal("process-boundary"),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "preview-disabled",
      "unsupported-platform",
      "setup-incomplete",
      "unpinned-engine",
    ]),
  }),
]);
export type OfficeToolchainStatus = typeof OfficeToolchainStatus.Type;

export class DocumentOfficeToolchain extends Context.Service<
  DocumentOfficeToolchain,
  { readonly status: Effect.Effect<OfficeToolchainStatus> }
>()("t3/scient/documents/docxJob/DocumentOfficeToolchain") {}

const unavailable = (reason: Extract<OfficeToolchainStatus, { status: "unavailable" }>["reason"]) =>
  ({ status: "unavailable", reason }) as const;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const hostEnvironment = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
  const officeRoot = path.join(config.baseDir, "document-lab", "office");

  const resolve = Effect.fn("DocumentOfficeToolchain.status")(function* () {
    // Opt-in development preview only: qualified isolation for untrusted files does not exist yet.
    if (config.mode !== "desktop" || config.devUrl === undefined)
      return unavailable("preview-disabled");
    const platformArch = officePlatformArch(platform, architecture);
    if (platformArch === undefined) return unavailable("unsupported-platform");
    const receipt = yield* fileSystem
      .readFileString(path.join(officeRoot, "active.json"))
      .pipe(Effect.flatMap(decodeReceipt), Effect.option);
    if (receipt._tag === "None" || receipt.value.platformArch !== platformArch)
      return unavailable("setup-incomplete");
    const { sofficePath, provisioning } = receipt.value;
    const relative = path.relative(officeRoot, sofficePath);
    if (
      !path.isAbsolute(sofficePath) ||
      (provisioning === "pinned-archive" &&
        (relative.startsWith("..") || path.isAbsolute(relative) || relative === "")) ||
      (provisioning === "pinned-archive" &&
        receipt.value.archiveSha256 !== OFFICE_TOOLCHAIN.assets[platformArch].sha256)
    )
      return unavailable("setup-incomplete");
    const info = yield* fileSystem.stat(sofficePath).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") return unavailable("setup-incomplete");
    if (
      receipt.value.engineVersion !== OFFICE_TOOLCHAIN.version ||
      receipt.value.buildId !== OFFICE_TOOLCHAIN.buildId
    )
      return unavailable("unpinned-engine");
    const printed = yield* probeOfficeVersion({
      soffice: sofficePath,
      stagingRoot: path.join(config.baseDir, "document-lab", "jobs"),
      platform,
      hostEnvironment,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.option,
    );
    if (printed._tag === "None" || !isPinnedOfficeVersion(printed.value))
      return unavailable("unpinned-engine");
    return {
      status: "ready",
      engine: "LibreOffice",
      version: OFFICE_TOOLCHAIN.version,
      buildId: OFFICE_TOOLCHAIN.buildId,
      platformArch,
      provisioning,
      sofficePath,
      inputPolicy: "trusted-fixtures",
      isolation: "process-boundary",
    } as const;
  });
  // The setup runs before the candidate starts; one probe per server keeps startup cheap.
  const status = yield* Effect.cached(resolve());
  return DocumentOfficeToolchain.of({ status });
});

export const layer = Layer.effect(DocumentOfficeToolchain, make);

/** The worker bound to the qualified engine; without one every render is refused. */
export const rendererLayer = Layer.effect(
  OfficeRenderer,
  Effect.gen(function* () {
    const status = yield* (yield* DocumentOfficeToolchain).status;
    if (status.status !== "ready") {
      return OfficeRenderer.of({
        render: Effect.fn("OfficeRenderer.unavailable")(function* () {
          return yield* new OfficeRenderError({ reason: "unavailable", exitCode: null });
        }),
      });
    }
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeOfficeRenderer({
      soffice: status.sofficePath,
      stagingRoot: path.join(config.baseDir, "document-lab", "jobs"),
      platform: yield* HostProcess.Platform,
      hostEnvironment: yield* HostProcess.Environment,
    });
  }),
);
