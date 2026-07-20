import { describe, expect, it } from "vitest";

import {
  detectProviderRuntimeTarget,
  UnsupportedProviderRuntimeTargetError,
} from "./providerRuntimeTarget";

describe("provider runtime target detection", () => {
  it("normalizes supported Apple Silicon targets", async () => {
    await expect(
      detectProviderRuntimeTarget({ platform: "darwin", arch: "aarch64" }),
    ).resolves.toEqual({ platform: "darwin", arch: "arm64", cpu: "standard" });
  });

  it("selects conservative baseline artifacts for x64 when CPU capability is not proven", async () => {
    await expect(
      detectProviderRuntimeTarget({ platform: "darwin", arch: "x86_64" }),
    ).resolves.toEqual({ platform: "darwin", arch: "x64", cpu: "baseline" });
  });

  it("rejects unsupported platforms and architectures", async () => {
    await expect(
      detectProviderRuntimeTarget({ platform: "freebsd", arch: "x64" }),
    ).rejects.toBeInstanceOf(UnsupportedProviderRuntimeTargetError);
    await expect(
      detectProviderRuntimeTarget({ platform: "darwin", arch: "ia32" }),
    ).rejects.toBeInstanceOf(UnsupportedProviderRuntimeTargetError);
  });
});
