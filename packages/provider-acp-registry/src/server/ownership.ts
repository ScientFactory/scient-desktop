/**
 * Filesystem ownership proofs for ACP Registry managed installations: every
 * install root must sit inside the configured private tools directory, binary
 * installs carry a receipt, and removal validates every proof before it
 * deletes any bytes.
 */
import type { ProviderRegistryInstallation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import type {
  AcpRegistryAgent,
  AcpRegistryError,
  AcpRegistryIndex,
  AcpRegistryPackageInstallReceipt,
  AcpRegistryPlatformTarget,
} from "./AcpRegistrySupport.ts";

type AcpRegistryBinaryTarget = NonNullable<AcpRegistryAgent["distribution"]["binary"]>[string];

/** Catalog state and helpers the ownership proofs read; supplied by the catalog. */
export interface AcpRegistryOwnershipInput {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly platformTarget: AcpRegistryPlatformTarget | undefined;
  readonly installsDirectory: string;
  readonly packageReceiptsDirectory: string;
  readonly AcpRegistryError: typeof AcpRegistryError;
  readonly isAcpRegistryError: (input: unknown) => input is AcpRegistryError;
  readonly NpxPackage: Schema.Codec<string>;
  readonly UvxPackage: Schema.Codec<string>;
  readonly binaryReceiptName: string;
  readonly decodeBinaryReceipt: (input: string) => Effect.Effect<
    {
      readonly agentId: string;
      readonly agentVersion: string;
      readonly archive: string;
      readonly installRoot: string;
      readonly executablePath: string;
    },
    Schema.SchemaError
  >;
  readonly decodePackageInstallReceipt: (
    input: string,
  ) => Option.Option<AcpRegistryPackageInstallReceipt>;
  readonly packageReceiptPath: (
    agentId: string,
    distribution: "npx" | "uvx",
    managerPath: string,
  ) => Effect.Effect<string>;
  readonly readPackageReceipt: (
    agent: AcpRegistryAgent,
    distribution: "npx" | "uvx",
    packageSpec: string,
    managerPath: string,
  ) => Effect.Effect<
    Option.Option<AcpRegistryPackageInstallReceipt>,
    AcpRegistryError | PlatformError.PlatformError
  >;
  readonly loadCachedRegistry: () => Effect.Effect<AcpRegistryIndex, AcpRegistryError>;
  readonly binaryPaths: (
    agent: AcpRegistryAgent,
    target: AcpRegistryBinaryTarget,
  ) => { readonly installRoot: string; readonly executablePath: string } | undefined;
}

export function makeAcpRegistryOwnership(catalog: AcpRegistryOwnershipInput) {
  const {
    fileSystem,
    path,
    platform,
    platformTarget,
    installsDirectory,
    packageReceiptsDirectory,
    AcpRegistryError,
    isAcpRegistryError,
    NpxPackage,
    UvxPackage,
    binaryReceiptName,
    decodeBinaryReceipt,
    decodePackageInstallReceipt,
    packageReceiptPath,
    readPackageReceipt,
    loadCachedRegistry,
    binaryPaths,
  } = catalog;

  const assertOwnedInstallRoot = Effect.fn("AcpRegistryCatalog.assertOwnedInstallRoot")(function* (
    root: string,
  ) {
    const relative = path.relative(installsDirectory, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new AcpRegistryError({
        reason: "install_failed",
        detail: "ACP Registry installation is outside Scient's owned tools directory.",
      });
    }
    const toolsRealPath = yield* fileSystem.realPath(installsDirectory);
    const rootRealPath = yield* fileSystem.realPath(root);
    if (rootRealPath !== path.resolve(toolsRealPath, relative)) {
      return yield* new AcpRegistryError({
        reason: "install_failed",
        detail: "ACP Registry installation traverses a foreign or symbolic-link directory.",
      });
    }
  });

  const binaryInstallationFacts = Effect.fn("AcpRegistryCatalog.binaryInstallationFacts")(
    function* (
      agent: AcpRegistryAgent,
      paths: { readonly installRoot: string; readonly executablePath: string },
    ) {
      const facts: ProviderRegistryInstallation = {
        agentId: agent.id,
        distribution: "binary",
        version: agent.version,
        installRoot: paths.installRoot,
        executablePath: paths.executablePath,
      };
      const receiptPath = path.join(paths.installRoot, binaryReceiptName);
      if (!(yield* fileSystem.exists(receiptPath))) return facts;
      yield* assertOwnedInstallRoot(receiptPath);
      const receipt = yield* fileSystem.readFileString(receiptPath).pipe(
        Effect.flatMap(decodeBinaryReceipt),
        Effect.mapError(
          (cause) =>
            new AcpRegistryError({
              reason: "install_failed",
              detail: "The ACP Registry binary installation receipt is invalid.",
              cause,
            }),
        ),
      );
      if (
        receipt.agentId !== agent.id ||
        receipt.agentVersion !== agent.version ||
        receipt.installRoot !== paths.installRoot ||
        receipt.executablePath !== paths.executablePath
      )
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail: "The ACP Registry binary installation receipt has a different owner.",
        });
      return { ...facts, installer: receipt.archive } satisfies ProviderRegistryInstallation;
    },
  );

  const readOwnedPackageReceipts = Effect.fn("AcpRegistryCatalog.readOwnedPackageReceipts")(
    function* (agentId: string) {
      const receipts: Array<{
        readonly receiptPath: string;
        readonly receipt: AcpRegistryPackageInstallReceipt;
        readonly installRoot: string;
      }> = [];
      if (!(yield* fileSystem.exists(packageReceiptsDirectory))) return receipts;
      for (const name of yield* fileSystem.readDirectory(packageReceiptsDirectory)) {
        const receiptPath = path.join(packageReceiptsDirectory, name);
        const decoded = decodePackageInstallReceipt(yield* fileSystem.readFileString(receiptPath));
        if (Option.isNone(decoded) || decoded.value.agentId !== agentId) continue;
        const receipt = decoded.value;
        if (
          !Schema.is(receipt.distribution === "npx" ? NpxPackage : UvxPackage)(receipt.packageSpec)
        )
          continue;
        const owner = { id: receipt.agentId, version: receipt.agentVersion };
        const installRoot = path.join(
          installsDirectory,
          owner.id,
          encodeURIComponent(owner.version),
          receipt.distribution === "npx" ? "npm" : "python",
        );
        const expectedBin =
          receipt.distribution === "npx" && platform === "win32"
            ? installRoot
            : path.join(installRoot, "bin");
        if (
          receiptPath !==
            (yield* packageReceiptPath(
              receipt.agentId,
              receipt.distribution,
              receipt.managerPath,
            )) ||
          receipt.binDirectory !== expectedBin ||
          path.dirname(receipt.executablePath) !== expectedBin
        )
          continue;
        if (
          receipt.packageRoot !== undefined &&
          (path.relative(installRoot, receipt.packageRoot).startsWith("..") ||
            path.isAbsolute(path.relative(installRoot, receipt.packageRoot)))
        )
          continue;
        if (yield* fileSystem.exists(installRoot)) yield* assertOwnedInstallRoot(installRoot);
        receipts.push({ receiptPath, receipt, installRoot });
      }
      return receipts;
    },
  );

  const installedPackage = Effect.fn("AcpRegistryCatalog.installedPackage")(function* (
    agent: AcpRegistryAgent,
    distribution: "npx" | "uvx",
    packageSpec: string,
  ) {
    for (const owned of yield* readOwnedPackageReceipts(agent.id)) {
      if (
        owned.receipt.agentVersion !== agent.version ||
        owned.receipt.distribution !== distribution ||
        owned.receipt.packageSpec !== packageSpec
      )
        continue;
      const validated = yield* readPackageReceipt(
        agent,
        distribution,
        packageSpec,
        owned.receipt.managerPath,
      );
      if (Option.isNone(validated)) continue;
      const executableReal = yield* fileSystem.realPath(validated.value.executablePath);
      const relative = path.relative(yield* fileSystem.realPath(owned.installRoot), executableReal);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail: "ACP Registry package command resolves outside its owned installation.",
        });
      return Option.some({
        agentId: agent.id,
        distribution,
        version: agent.version,
        installer: validated.value.managerPath,
        installRoot: owned.installRoot,
        executablePath: validated.value.executablePath,
        packageSpec,
        ...(validated.value.packageVersion === undefined
          ? {}
          : { packageVersion: validated.value.packageVersion }),
      } satisfies ProviderRegistryInstallation);
    }
    return Option.none<ProviderRegistryInstallation>();
  });

  /** Validates every ownership proof, then removes the agent's app-owned installations. */
  const removeOwnedInstallations = (
    safeAgentId: string,
    agentRoot: string,
    existed: boolean,
    input: { readonly expectedInstallation?: ProviderRegistryInstallation },
  ) =>
    Effect.gen(function* () {
      const packages = yield* readOwnedPackageReceipts(safeAgentId);
      if (!existed) {
        if (input.expectedInstallation)
          return yield* new AcpRegistryError({
            reason: "install_failed",
            detail:
              "The ACP Registry installation changed before removal. Review the action again.",
          });
        for (const owned of packages) yield* fileSystem.remove(owned.receiptPath, { force: true });
        return { agentId: safeAgentId, removed: false };
      }
      const binaryRoots: string[] = [];
      for (const version of yield* fileSystem.readDirectory(agentRoot)) {
        const versionRoot = path.join(agentRoot, version);
        if ((yield* fileSystem.stat(versionRoot)).type !== "Directory") continue;
        yield* assertOwnedInstallRoot(versionRoot);
        for (const entry of yield* fileSystem.readDirectory(versionRoot)) {
          if (!/^(?:darwin|linux|windows)-(?:aarch64|x86_64)$/u.test(entry)) continue;
          const root = path.join(versionRoot, entry);
          yield* assertOwnedInstallRoot(root);
          binaryRoots.push(root);
        }
      }
      if (input.expectedInstallation) {
        const expected = input.expectedInstallation;
        const registry = yield* loadCachedRegistry();
        const agent = registry.agents.find(
          (candidate) => candidate.id === safeAgentId && candidate.version === expected.version,
        );
        const target =
          platformTarget === undefined ? undefined : agent?.distribution.binary?.[platformTarget];
        const currentBinary = agent && target ? binaryPaths(agent, target) : undefined;
        const binaryFacts =
          expected.distribution === "binary" &&
          agent &&
          currentBinary &&
          binaryRoots.includes(currentBinary.installRoot)
            ? yield* binaryInstallationFacts(agent, currentBinary)
            : undefined;
        const matching =
          expected.agentId === safeAgentId &&
          (yield* fileSystem.exists(expected.executablePath)) &&
          (expected.distribution === "binary"
            ? binaryRoots.includes(expected.installRoot) &&
              currentBinary?.installRoot === expected.installRoot &&
              currentBinary.executablePath === expected.executablePath &&
              binaryFacts?.installer === expected.installer
            : packages.some(
                ({ receipt, installRoot }) =>
                  installRoot === expected.installRoot &&
                  receipt.agentVersion === expected.version &&
                  receipt.distribution === expected.distribution &&
                  receipt.managerPath === expected.installer &&
                  receipt.executablePath === expected.executablePath &&
                  receipt.packageSpec === expected.packageSpec &&
                  receipt.packageVersion === expected.packageVersion,
              ));
        if (!matching)
          return yield* new AcpRegistryError({
            reason: "install_failed",
            detail:
              "The ACP Registry installation changed before removal. Review the action again.",
          });
      }
      // Validate every ownership proof before removing any bytes. Package-manager
      // executables and credentials outside these private roots are never touched.
      let removed = false;
      for (const root of new Set([...binaryRoots, ...packages.map((owned) => owned.installRoot)])) {
        if (!(yield* fileSystem.exists(root))) continue;
        yield* fileSystem.remove(root, { recursive: true });
        removed = true;
      }
      for (const owned of packages) yield* fileSystem.remove(owned.receiptPath, { force: true });
      for (const version of yield* fileSystem.readDirectory(agentRoot)) {
        const versionRoot = path.join(agentRoot, version);
        if ((yield* fileSystem.stat(versionRoot)).type !== "Directory") continue;
        if ((yield* fileSystem.readDirectory(versionRoot)).length === 0)
          yield* fileSystem.remove(versionRoot, { recursive: true });
      }
      if ((yield* fileSystem.readDirectory(agentRoot)).length === 0)
        yield* fileSystem.remove(agentRoot, { recursive: true });
      return { agentId: safeAgentId, removed };
    });

  /** Keeps registry errors and wraps any other failure as an install failure. */
  const asOwnedInstallationError = (action: "prepare" | "inspect" | "resolve" | "remove") =>
    Effect.mapError((cause: unknown) =>
      isAcpRegistryError(cause)
        ? cause
        : new AcpRegistryError({
            reason: "install_failed",
            detail: `Could not ${action} the app-owned ACP Registry installation.`,
            cause,
          }),
    );

  return {
    assertOwnedInstallRoot,
    binaryInstallationFacts,
    installedPackage,
    removeOwnedInstallations,
    asOwnedInstallationError,
  };
}
