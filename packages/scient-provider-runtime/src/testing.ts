import type { ManagedRuntimeTarget } from "./target.ts";

/** The targets Muse ships for, stated independently of the manifest that resolves them. */
export const MUSE_SUPPORTED_TARGETS: ReadonlyArray<ManagedRuntimeTarget> = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "arm64", libc: "glibc" },
  { platform: "linux", arch: "x64", libc: "glibc" },
  { platform: "win32", arch: "arm64" },
  { platform: "win32", arch: "x64" },
];
