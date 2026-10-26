// @effect-diagnostics nodeBuiltinImport:off -- Synthetic absolute paths.
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { platformFileIdentity } from "../workspace/PlatformFileIdentity.ts";
import { WindowsNativeFileError } from "../workspace/WindowsNativeFile.ts";
import {
  assertOverleafApplyPaths,
  overleafHostPathProblem,
  overleafDirectoryIdentity,
} from "./overleafHostPaths.ts";

describe("Overleaf host path budgets", () => {
  it("counts UTF-8 bytes and the terminating NUL on macOS and Linux", () => {
    const path = "/" + "a/".repeat(510) + "ab";
    expect(overleafHostPathProblem(path, "darwin")).toBeNull();
    expect(overleafHostPathProblem(path + "c", "darwin")).toBe("path-too-long");
    expect(overleafHostPathProblem("/" + "a/".repeat(2047) + "a", "linux")).toBe("path-too-long");
    expect(overleafHostPathProblem("/" + "é".repeat(128), "linux")).toBe("component-too-long");
  });

  it("counts Windows UTF-16 units with room for the extended UNC prefix", () => {
    const path = "C:\\" + "a\\".repeat(16376) + "abc";
    expect(overleafHostPathProblem(path, "win32")).toBeNull();
    expect(overleafHostPathProblem(path + "d", "win32")).toBe("path-too-long");
  });

  it("reserves generated journal and sibling staging paths before an apply", () => {
    expect(() => assertOverleafApplyPaths("/paper", "/vault", ["main.tex"])).not.toThrow();
    const cwd = "/" + "a/".repeat(450);
    if (HostProcess.Platform.defaultValue() === "darwin") {
      expect(overleafHostPathProblem(NodePath.join(cwd, "main.tex"))).toBeNull();
      expect(() => assertOverleafApplyPaths(cwd, "/vault", ["main.tex"])).toThrow();
      expect(() => assertOverleafApplyPaths("/paper", cwd, ["main.tex"])).toThrow();
    }
  });
});

it.effect(
  "returns native disk admission failures through the shared filesystem error channel",
  () =>
    Effect.gen(function* () {
      using _identity = vi
        .spyOn(platformFileIdentity, "directory")
        .mockRejectedValue(new WindowsNativeFileError("network-filesystem"));
      const error = yield* Effect.flip(overleafDirectoryIdentity("network"));
      expect(error).toMatchObject({
        _tag: "OverleafFilesystemError",
        reason: "network-filesystem",
        path: "network",
      });
    }),
);
