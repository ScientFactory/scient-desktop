import { describe, expect, it } from "@effect/vitest";
import { overleafHostPathProblem } from "./overleafHostPaths.ts";

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
