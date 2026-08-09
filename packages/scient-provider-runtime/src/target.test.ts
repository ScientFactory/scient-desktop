import { describe, expect, it } from "vite-plus/test";

import {
  detectManagedRuntimeTarget,
  managedRuntimeTargetKey,
  UnsupportedManagedRuntimeTargetError,
} from "./target.ts";

describe("managed runtime target detection", () => {
  it("normalizes the supported macOS and Windows architectures", () => {
    expect(
      managedRuntimeTargetKey(detectManagedRuntimeTarget({ platform: "darwin", arch: "aarch64" })),
    ).toBe("darwin-arm64");
    expect(
      managedRuntimeTargetKey(detectManagedRuntimeTarget({ platform: "win32", arch: "amd64" })),
    ).toBe("win32-x64");
  });

  it("keeps Linux libc in the target identity", () => {
    expect(
      managedRuntimeTargetKey(detectManagedRuntimeTarget({ platform: "linux", arch: "x64" })),
    ).toMatch(/^linux-x64-(glibc|musl)$/u);
  });

  it("rejects unreviewed operating systems and architectures", () => {
    expect(() => detectManagedRuntimeTarget({ platform: "freebsd", arch: "x64" })).toThrow(
      UnsupportedManagedRuntimeTargetError,
    );
    expect(() => detectManagedRuntimeTarget({ platform: "darwin", arch: "ia32" })).toThrow(
      UnsupportedManagedRuntimeTargetError,
    );
  });
});
