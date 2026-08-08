import { describe, expect, it } from "vite-plus/test";

import type { VoiceBenchmarkResult, VoiceCapabilityProbe } from "./capabilityProbe.ts";
import {
  LIVE_PREVIEW_MAX_LOAD_MS,
  LIVE_PREVIEW_MAX_RTF,
  shouldEnableLivePreview,
} from "./livePreviewGate.ts";

function benchmark(overrides: Partial<VoiceBenchmarkResult> = {}): VoiceBenchmarkResult {
  return { modelId: "m", rtf: 0.3, loadMs: 800, sampleDurationMs: 2_500, ...overrides };
}

const PROBE: VoiceCapabilityProbe = {
  arch: "arm64",
  cpuCount: 8,
  totalMemBytes: 16 * 1024 ** 3,
  hasAvx2: false,
};

describe("shouldEnableLivePreview", () => {
  const cases: ReadonlyArray<{
    name: string;
    input: Parameters<typeof shouldEnableLivePreview>[0];
    expected: boolean;
  }> = [
    {
      name: "fast machine (low rtf, fast load) enables",
      input: { benchmark: benchmark({ rtf: 0.3, loadMs: 500 }) },
      expected: true,
    },
    {
      name: "rtf exactly at the cap enables",
      input: { benchmark: benchmark({ rtf: LIVE_PREVIEW_MAX_RTF }) },
      expected: true,
    },
    {
      name: "loadMs exactly at the cap enables",
      input: { benchmark: benchmark({ loadMs: LIVE_PREVIEW_MAX_LOAD_MS }) },
      expected: true,
    },
    {
      name: "rtf just over the cap fails",
      input: { benchmark: benchmark({ rtf: LIVE_PREVIEW_MAX_RTF + 0.01 }) },
      expected: false,
    },
    {
      name: "slow rtf (>1, slower than real time) fails",
      input: { benchmark: benchmark({ rtf: 1.5 }) },
      expected: false,
    },
    {
      name: "zero rtf (degenerate) fails",
      input: { benchmark: benchmark({ rtf: 0 }) },
      expected: false,
    },
    {
      name: "negative rtf (degenerate) fails",
      input: { benchmark: benchmark({ rtf: -1 }) },
      expected: false,
    },
    {
      name: "NaN rtf fails",
      input: { benchmark: benchmark({ rtf: Number.NaN }) },
      expected: false,
    },
    {
      name: "huge loadMs fails even with fast rtf",
      input: { benchmark: benchmark({ rtf: 0.2, loadMs: 5_000 }) },
      expected: false,
    },
    {
      name: "NaN loadMs fails",
      input: { benchmark: benchmark({ loadMs: Number.NaN }) },
      expected: false,
    },
    { name: "null benchmark (unknown) fails", input: { benchmark: null }, expected: false },
    {
      name: "null benchmark fails even with a strong probe",
      input: { benchmark: null, probe: PROBE },
      expected: false,
    },
    {
      name: "fast benchmark still enables when a probe is supplied",
      input: { benchmark: benchmark({ rtf: 0.4, loadMs: 1_000 }), probe: PROBE },
      expected: true,
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(shouldEnableLivePreview(input)).toBe(expected);
    });
  }
});
