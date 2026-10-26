import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { platformFileIdentity } from "../workspace/PlatformFileIdentity.ts";
import { WindowsNativeFileError } from "../workspace/WindowsNativeFile.ts";
import { overleafHostPathProblem, overleafDirectoryIdentity } from "./overleafHostPaths.ts";

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
});

it("returns native disk admission failures through the shared filesystem error channel", async () => {
  using _identity = vi
    .spyOn(platformFileIdentity, "directory")
    .mockRejectedValue(new WindowsNativeFileError("network-filesystem"));
  const error = await Effect.runPromise(Effect.flip(overleafDirectoryIdentity("network")));
  expect(error).toMatchObject({
    _tag: "OverleafFilesystemError",
    reason: "network-filesystem",
    path: "network",
  });
});
