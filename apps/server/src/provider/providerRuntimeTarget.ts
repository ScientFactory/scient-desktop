import FS from "node:fs/promises";
import OS from "node:os";

import type {
  ProviderRuntimeArch,
  ProviderRuntimeCpu,
  ProviderRuntimePlatform,
  ProviderRuntimeTarget,
} from "./providerRuntimeTypes";

export class UnsupportedProviderRuntimeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedProviderRuntimeTargetError";
  }
}

function normalizePlatform(platform: NodeJS.Platform): ProviderRuntimePlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new UnsupportedProviderRuntimeTargetError(
    `Scient does not support managed runtimes on ${platform}.`,
  );
}

function normalizeArch(arch: string): ProviderRuntimeArch {
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  if (arch === "x64" || arch === "x86_64" || arch === "amd64") return "x64";
  throw new UnsupportedProviderRuntimeTargetError(
    `Scient does not support managed runtimes on the ${arch} architecture.`,
  );
}

async function readLinuxCpuFlags(): Promise<ReadonlySet<string>> {
  try {
    const cpuInfo = await FS.readFile("/proc/cpuinfo", "utf8");
    const flags = cpuInfo
      .split(/\r?\n/u)
      .filter((line) => /^flags\s*:/iu.test(line))
      .flatMap((line) => line.split(":", 2)[1]?.trim().split(/\s+/u) ?? []);
    return new Set(flags.map((flag) => flag.toLowerCase()));
  } catch {
    return new Set();
  }
}

async function detectCpuVariant(input: {
  readonly platform: ProviderRuntimePlatform;
  readonly arch: ProviderRuntimeArch;
}): Promise<ProviderRuntimeCpu> {
  if (input.arch !== "x64") return "standard";
  if (input.platform !== "linux") return "baseline";
  const flags = await readLinuxCpuFlags();
  return flags.has("avx2") ? "standard" : "baseline";
}

function detectLinuxLibc(): "glibc" | "musl" {
  const report = process.report?.getReport() as { header?: unknown } | undefined;
  if (!report?.header) {
    throw new UnsupportedProviderRuntimeTargetError(
      "Scient could not safely identify the Linux C library for managed runtimes.",
    );
  }
  const header = report?.header as { glibcVersionRuntime?: unknown } | undefined;
  return typeof header?.glibcVersionRuntime === "string" ? "glibc" : "musl";
}

export async function detectProviderRuntimeTarget(input?: {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): Promise<ProviderRuntimeTarget> {
  const platform = normalizePlatform(input?.platform ?? process.platform);
  const arch = normalizeArch(input?.arch ?? OS.arch());
  const cpu = await detectCpuVariant({ platform, arch });
  return {
    platform,
    arch,
    cpu,
    ...(platform === "linux" ? { libc: detectLinuxLibc() } : {}),
  };
}
