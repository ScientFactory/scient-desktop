import { describe, expect, it } from "vite-plus/test";

import { classifyMatlabSource } from "./matlabSource.js";

describe("MATLAB saved-file capability", () => {
  it("runs scripts, including scripts with local functions", () => {
    expect(
      classifyMatlabSource({
        path: "analysis.m",
        code: "% heading\nx = 1;\nfunction y = twice(x)\n y = 2*x;\nend",
      }),
    ).toEqual({ kind: "script", runnableAsFile: true, reason: null });
  });

  it("recognizes top-level function and class definitions after comments", () => {
    expect(
      classifyMatlabSource({
        path: "normalize.m",
        code: "%{\nlicense\n%}\nfunction y = normalize(x)\ny = x;\nend",
      }).kind,
    ).toBe("function");
    expect(
      classifyMatlabSource({ path: "Measurement.m", code: "% doc\nclassdef Measurement\nend" }),
    ).toMatchObject({ kind: "class", runnableAsFile: false });
  });
  it("does not mistake text inside nested comments for the first statement", () => {
    expect(
      classifyMatlabSource({
        path: "analysis.m",
        code: "%{\n%{\nexample\n%}\nfunction commentedOut\n%}\nx = 1;",
      }),
    ).toMatchObject({ kind: "script", runnableAsFile: true });
    expect(
      classifyMatlabSource({
        path: "twice.m",
        code: "%{\n%{\nexample\n%}\nx = 1;\n%}\nfunction y = twice(x)\ny = 2*x;\nend",
      }),
    ).toMatchObject({ kind: "function", runnableAsFile: false });
  });

  it("treats MATLAB definition folders as non-runnable regardless of file contents", () => {
    expect(classifyMatlabSource({ path: "helpers/+qautils/normalize.m", code: "x = 1" }).kind).toBe(
      "package-member",
    );
    expect(classifyMatlabSource({ path: "helpers/@Thing/display.m", code: "x = 1" }).kind).toBe(
      "class-member",
    );
    expect(classifyMatlabSource({ path: "helpers/private/loadValue.m", code: "x = 1" }).kind).toBe(
      "private-member",
    );
  });
});
