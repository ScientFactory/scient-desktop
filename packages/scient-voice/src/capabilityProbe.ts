// @effect-diagnostics nodeBuiltinImport:off - pure Node core, no Effect runtime.
// Static machine-capability probing plus the pure scoring/threshold logic used
// to pick a coarse capability tier.
//
// This module is NEW (no old-app equivalent). The impure probe reads `node:os`
// and does a best-effort AVX2 check; it NEVER throws. The actual runtime
// micro-benchmark (which spawns whisper) lives in the host layer — only its
// shape and the pure scoring live here so both are deterministically testable.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

export type VoiceCapabilityTier = "fast" | "ok" | "slow";

export interface VoiceCapabilityProbe {
  readonly arch: string;
  readonly cpuCount: number;
  readonly totalMemBytes: number;
  readonly hasAvx2: boolean;
}

/**
 * Result of a runtime micro-benchmark. `rtf` is the whisper.cpp "real time
 * factor": processing time / audio duration — lower is faster, and below 1
 * means faster than real time. The benchmark runs in the host layer; this is
 * only its shape.
 */
export interface VoiceBenchmarkResult {
  readonly modelId: string;
  readonly rtf: number;
  readonly loadMs: number;
  readonly sampleDurationMs: number;
}

const GIB = 1024 ** 3;

export interface Avx2DetectionInput {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Returns `/proc/cpuinfo` contents on Linux (or "" on failure). */
  readonly readLinuxCpuinfo: () => string;
  /** Returns space-joined darwin CPU feature strings (or "" on failure). */
  readonly readDarwinCpuFeatures: () => string;
}

/**
 * Best-effort AVX2 detection. Only meaningful on x86; every other arch (and any
 * read failure) resolves to `false`. Pure given its injected readers.
 */
export function detectAvx2(input: Avx2DetectionInput): boolean {
  if (input.arch !== "x64" && input.arch !== "ia32") {
    return false;
  }
  const haystack = (
    input.platform === "linux"
      ? input.readLinuxCpuinfo()
      : input.platform === "darwin"
        ? input.readDarwinCpuFeatures()
        : ""
  ).toLowerCase();
  return /\bavx2\b/u.test(haystack);
}

export interface StaticCapabilityOverrides {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly cpuCount?: number;
  readonly totalMemBytes?: number;
  readonly readLinuxCpuinfo?: () => string;
  readonly readDarwinCpuFeatures?: () => string;
}

/**
 * Gather static capabilities from `node:os`, with a best-effort AVX2 probe.
 * Never throws — every optional dependency has a safe fallback and can be
 * overridden for tests.
 */
export function probeStaticCapabilities(
  overrides: StaticCapabilityOverrides = {},
): VoiceCapabilityProbe {
  // Standalone capability probe with no Effect runtime; the host platform/arch
  // are read from node:os (never the global `process`) with test-injectable overrides.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- non-Effect probe; overrides make it testable.
  const platform = overrides.platform ?? NodeOS.platform();
  // oxlint-disable-next-line t3code/no-global-process-runtime -- non-Effect probe; overrides make it testable.
  const arch = overrides.arch ?? NodeOS.arch();
  const cpuCount = overrides.cpuCount ?? safeCpuCount();
  const totalMemBytes = overrides.totalMemBytes ?? safeTotalMem();
  const hasAvx2 = detectAvx2({
    platform,
    arch,
    readLinuxCpuinfo: overrides.readLinuxCpuinfo ?? readLinuxCpuinfo,
    readDarwinCpuFeatures: overrides.readDarwinCpuFeatures ?? readDarwinCpuFeatures,
  });
  return { arch, cpuCount, totalMemBytes, hasAvx2 };
}

/**
 * Map static capabilities to a coarse tier hint. Pure and deterministic.
 *
 * x86 without AVX2 is always `slow` (whisper.cpp is markedly slower there).
 * Apple Silicon / arm64 leans on its strong NEON/AMX path and is scored by
 * core count and memory instead.
 */
export function scoreCapability(probe: VoiceCapabilityProbe): VoiceCapabilityTier {
  const gib = probe.totalMemBytes / GIB;

  if (probe.arch === "arm64") {
    if (probe.cpuCount >= 8 && gib >= 8) return "fast";
    if (probe.cpuCount >= 4 && gib >= 4) return "ok";
    return "slow";
  }

  if (probe.arch === "x64" || probe.arch === "ia32") {
    if (!probe.hasAvx2) return "slow";
    if (probe.cpuCount >= 8 && gib >= 8) return "fast";
    if (probe.cpuCount >= 4 && gib >= 4) return "ok";
    return "slow";
  }

  return "slow";
}

/**
 * Map a measured benchmark to a tier. Pure and deterministic. Non-finite or
 * non-positive `rtf` (a failed/degenerate run) is treated as `slow`.
 */
export function scoreBenchmark(result: VoiceBenchmarkResult): VoiceCapabilityTier {
  const { rtf } = result;
  if (!Number.isFinite(rtf) || rtf <= 0) return "slow";
  if (rtf <= 0.5) return "fast";
  if (rtf <= 1) return "ok";
  return "slow";
}

function safeCpuCount(): number {
  try {
    return Math.max(1, NodeOS.cpus().length);
  } catch {
    return 1;
  }
}

function safeTotalMem(): number {
  try {
    return Math.max(0, NodeOS.totalmem());
  } catch {
    return 0;
  }
}

function readLinuxCpuinfo(): string {
  try {
    return NodeFS.readFileSync("/proc/cpuinfo", "utf8");
  } catch {
    return "";
  }
}

function readDarwinCpuFeatures(): string {
  try {
    return NodeChildProcess.execFileSync(
      "sysctl",
      ["-n", "machdep.cpu.features", "machdep.cpu.leaf7_features"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return "";
  }
}
