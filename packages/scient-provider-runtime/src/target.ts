export type ManagedRuntimePlatform = "darwin" | "linux" | "win32";
export type ManagedRuntimeArch = "arm64" | "x64";

export interface ManagedRuntimeTarget {
  readonly platform: ManagedRuntimePlatform;
  readonly arch: ManagedRuntimeArch;
  readonly libc?: "glibc" | "musl" | undefined;
}

export class UnsupportedManagedRuntimeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedManagedRuntimeTargetError";
  }
}

function normalizePlatform(platform: NodeJS.Platform): ManagedRuntimePlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  throw new UnsupportedManagedRuntimeTargetError(
    `Scient managed provider runtimes do not support ${platform}.`,
  );
}

function normalizeArch(arch: string): ManagedRuntimeArch {
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  if (arch === "x64" || arch === "x86_64" || arch === "amd64") return "x64";
  throw new UnsupportedManagedRuntimeTargetError(
    `Scient managed provider runtimes do not support the ${arch} architecture.`,
  );
}

function detectLinuxLibc(): "glibc" | "musl" {
  const report = process.report?.getReport() as { header?: unknown } | undefined;
  const header = report?.header as { glibcVersionRuntime?: unknown } | undefined;
  return typeof header?.glibcVersionRuntime === "string" ? "glibc" : "musl";
}

export function detectManagedRuntimeTarget(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): ManagedRuntimeTarget {
  const platform = normalizePlatform(input.platform);
  const arch = normalizeArch(input.arch);
  return {
    platform,
    arch,
    ...(platform === "linux" ? { libc: detectLinuxLibc() } : {}),
  };
}

export function managedRuntimeTargetKey(target: ManagedRuntimeTarget): string {
  return `${target.platform}-${target.arch}${target.libc ? `-${target.libc}` : ""}`;
}
