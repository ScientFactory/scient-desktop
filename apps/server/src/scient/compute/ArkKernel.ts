// @effect-diagnostics nodeBuiltinImport:off -- installs one checked binary into Scient's own folder.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  downloadManagedRuntime,
  materializeManagedRuntimeArtifact,
  verifyManagedRuntimeChecksum,
} from "@scientfactory/provider-runtime";

/**
 * Ark is a standalone R kernel: one program, with nothing to add to anyone's R library, so it cannot
 * conflict with a project's packages. It also answers Jupyter's interrupt message on every computer.
 */
export const ARK_VERSION = "0.1.252";

const ARK_ARTIFACTS: Readonly<
  Record<string, { readonly asset: string; readonly size: number; readonly sha256: string }>
> = {
  "darwin-arm64": {
    asset: "darwin-arm64",
    size: 8456517,
    sha256: "aa1186f6e1ad271abaf246fd76e0aa9039cdeeff2cb52147e8887060afd5fb07",
  },
  "darwin-x64": {
    asset: "darwin-x64",
    size: 8746138,
    sha256: "a8df8b55d951732b73fd05e8857b9c4b185b8dc9d6bc307f2ae5dcb84d4cc913",
  },
  "linux-arm64": {
    asset: "linux-arm64",
    size: 7327045,
    sha256: "aed35067f053c495d1e379649620df56142870f011695e1d88580ce32bcedefe",
  },
  "linux-x64": {
    asset: "linux-x64",
    size: 7806220,
    sha256: "7dda5d05b6c4d67e7ae74e70b6bec5fd3bc526b19e222fa78306e14972cf4495",
  },
  "win32-arm64": {
    asset: "windows-arm64",
    size: 7561155,
    sha256: "358372f5c2a8cf03307d575f11160d71adc18780cd6b1a8d9b4584d9805a21c2",
  },
  "win32-x64": {
    asset: "windows-x64",
    size: 8188981,
    sha256: "a6c2c6ae931d0dd5e1f771243bf3df4f86968462bbd8e08ceeba7f2e53567e58",
  },
};

export const arkProgram = (directory: string, platform: NodeJS.Platform) =>
  NodePath.join(directory, "ark", platform === "win32" ? "ark.exe" : "ark");

/** Downloads Ark into `directory`, checked against the digest pinned here. */
export async function installArk(input: {
  readonly directory: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly signal: AbortSignal;
}): Promise<void> {
  const artifact = ARK_ARTIFACTS[`${input.platform}-${input.arch}`];
  if (artifact === undefined)
    throw new Error(`Ark has no build for ${input.platform} ${input.arch}.`);
  const archivePath = NodePath.join(input.directory, "ark.zip");
  await downloadManagedRuntime({
    url: `https://github.com/posit-dev/ark/releases/download/${ARK_VERSION}/ark-${ARK_VERSION}-${artifact.asset}.zip`,
    destination: archivePath,
    allowedHosts: [
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ],
    expectedSize: artifact.size,
    signal: input.signal,
  });
  await verifyManagedRuntimeChecksum(archivePath, { algorithm: "sha256", digest: artifact.sha256 });
  await materializeManagedRuntimeArtifact({
    archivePath,
    archiveFormat: "zip",
    destination: NodePath.join(input.directory, "ark"),
    executablePath: input.platform === "win32" ? "ark.exe" : "ark",
    auxiliaryExecutablePaths: [],
    platform: input.platform,
    extractionLimits: { maxEntries: 16, maxExpandedBytes: 256 * 1024 * 1024 },
    signal: input.signal,
  });
  await NodeFSP.rm(archivePath, { force: true });
}
