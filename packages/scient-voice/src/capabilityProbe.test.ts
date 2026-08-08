import { describe, expect, it } from "vite-plus/test";

import {
  detectAvx2,
  probeStaticCapabilities,
  scoreBenchmark,
  scoreCapability,
  type VoiceBenchmarkResult,
  type VoiceCapabilityProbe,
} from "./capabilityProbe.ts";

const GIB = 1024 ** 3;

function probe(overrides: Partial<VoiceCapabilityProbe>): VoiceCapabilityProbe {
  return {
    arch: "x64",
    cpuCount: 8,
    totalMemBytes: 16 * GIB,
    hasAvx2: true,
    ...overrides,
  };
}

function benchmark(rtf: number): VoiceBenchmarkResult {
  return { modelId: "m", rtf, loadMs: 10, sampleDurationMs: 1_000 };
}

describe("detectAvx2", () => {
  const noReaders = { readLinuxCpuinfo: () => "", readDarwinCpuFeatures: () => "" };

  it("is always false on non-x86 architectures", () => {
    expect(
      detectAvx2({
        platform: "darwin",
        arch: "arm64",
        ...noReaders,
        readDarwinCpuFeatures: () => "AVX2",
      }),
    ).toBe(false);
  });

  it("reads /proc/cpuinfo on linux x64", () => {
    expect(
      detectAvx2({
        platform: "linux",
        arch: "x64",
        readDarwinCpuFeatures: () => "",
        readLinuxCpuinfo: () => "flags: sse4_2 avx2 fma",
      }),
    ).toBe(true);
    expect(
      detectAvx2({
        platform: "linux",
        arch: "x64",
        readDarwinCpuFeatures: () => "",
        readLinuxCpuinfo: () => "flags: sse4_2",
      }),
    ).toBe(false);
  });

  it("reads machdep cpu features on darwin x64 (case-insensitive)", () => {
    expect(
      detectAvx2({
        platform: "darwin",
        arch: "x64",
        readLinuxCpuinfo: () => "",
        readDarwinCpuFeatures: () => "FPU VME ... AVX2 BMI2",
      }),
    ).toBe(true);
  });

  it("returns false on platforms with no reader (e.g. win32) here", () => {
    expect(detectAvx2({ platform: "win32", arch: "x64", ...noReaders })).toBe(false);
  });
});

describe("scoreCapability", () => {
  it("scores arm64 by cores and memory", () => {
    expect(scoreCapability(probe({ arch: "arm64", cpuCount: 10, totalMemBytes: 16 * GIB }))).toBe(
      "fast",
    );
    expect(scoreCapability(probe({ arch: "arm64", cpuCount: 4, totalMemBytes: 8 * GIB }))).toBe(
      "ok",
    );
    expect(scoreCapability(probe({ arch: "arm64", cpuCount: 2, totalMemBytes: 8 * GIB }))).toBe(
      "slow",
    );
  });

  it("treats x86 without AVX2 as slow regardless of cores", () => {
    expect(
      scoreCapability(
        probe({ arch: "x64", hasAvx2: false, cpuCount: 32, totalMemBytes: 64 * GIB }),
      ),
    ).toBe("slow");
  });

  it("scores x86 with AVX2 by cores and memory", () => {
    expect(
      scoreCapability(probe({ arch: "x64", hasAvx2: true, cpuCount: 8, totalMemBytes: 16 * GIB })),
    ).toBe("fast");
    expect(
      scoreCapability(probe({ arch: "x64", hasAvx2: true, cpuCount: 4, totalMemBytes: 8 * GIB })),
    ).toBe("ok");
    expect(
      scoreCapability(probe({ arch: "x64", hasAvx2: true, cpuCount: 2, totalMemBytes: 8 * GIB })),
    ).toBe("slow");
  });

  it("treats unknown architectures as slow", () => {
    expect(scoreCapability(probe({ arch: "riscv64" }))).toBe("slow");
  });
});

describe("scoreBenchmark", () => {
  it("maps real-time factor to a tier (lower is faster)", () => {
    expect(scoreBenchmark(benchmark(0.3))).toBe("fast");
    expect(scoreBenchmark(benchmark(0.5))).toBe("fast");
    expect(scoreBenchmark(benchmark(0.8))).toBe("ok");
    expect(scoreBenchmark(benchmark(1))).toBe("ok");
    expect(scoreBenchmark(benchmark(1.5))).toBe("slow");
  });

  it("treats degenerate measurements as slow", () => {
    expect(scoreBenchmark(benchmark(0))).toBe("slow");
    expect(scoreBenchmark(benchmark(-1))).toBe("slow");
    expect(scoreBenchmark(benchmark(Number.NaN))).toBe("slow");
    expect(scoreBenchmark(benchmark(Number.POSITIVE_INFINITY))).toBe("slow");
  });
});

describe("probeStaticCapabilities", () => {
  it("honors overrides deterministically", () => {
    const result = probeStaticCapabilities({
      platform: "linux",
      arch: "x64",
      cpuCount: 8,
      totalMemBytes: 16 * GIB,
      readLinuxCpuinfo: () => "flags: avx2",
      readDarwinCpuFeatures: () => "",
    });
    expect(result).toStrictEqual({
      arch: "x64",
      cpuCount: 8,
      totalMemBytes: 16 * GIB,
      hasAvx2: true,
    });
  });

  it("returns a well-formed probe from the real host without throwing", () => {
    const result = probeStaticCapabilities();
    expect(typeof result.arch).toBe("string");
    expect(result.arch.length).toBeGreaterThan(0);
    expect(result.cpuCount).toBeGreaterThanOrEqual(1);
    expect(result.totalMemBytes).toBeGreaterThanOrEqual(0);
    expect(typeof result.hasAvx2).toBe("boolean");
  });
});
