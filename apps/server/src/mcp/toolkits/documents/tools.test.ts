import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { ScientLatexBuildTool, ScientPdfBuildTool } from "./tools.ts";

it("keeps the public PDF build contract narrow and evidence-bearing", () => {
  const input = Tool.getJsonSchema(ScientPdfBuildTool) as {
    readonly type?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  const output = Tool.getJsonSchemaFromSchema(ScientPdfBuildTool.successSchema) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const failure = JSON.stringify(Tool.getJsonSchemaFromSchema(ScientPdfBuildTool.failureSchema));

  expect(input.type).toBe("object");
  expect(Object.keys(input.properties ?? {})).toEqual(["sourcePath", "outputPath"]);
  expect(input.required).toEqual(["sourcePath", "outputPath"]);
  expect(output.properties).toMatchObject({
    sourcePath: expect.any(Object),
    outputPath: expect.any(Object),
    source: expect.any(Object),
    validation: expect.any(Object),
    visualReviewPerformed: expect.any(Object),
  });
  expect(output.properties).not.toHaveProperty("bytesBase64");
  expect(output.properties).not.toHaveProperty("sourceUrl");
  expect(failure).toContain("partial-publication");
  expect(failure).toContain("publishedSource");
  expect(failure).toContain("outputPath");
  expect(ScientPdfBuildTool.description).toContain("isolated Chromium renderer");
  expect(ScientPdfBuildTool.description).toContain("does not visually review");
});

it("keeps the public LaTeX build contract narrow, paced, and evidence-bearing", () => {
  const input = Tool.getJsonSchema(ScientLatexBuildTool) as {
    readonly type?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  const output = JSON.stringify(Tool.getJsonSchemaFromSchema(ScientLatexBuildTool.successSchema));
  const failure = JSON.stringify(Tool.getJsonSchemaFromSchema(ScientLatexBuildTool.failureSchema));

  expect(input.type).toBe("object");
  expect(Object.keys(input.properties ?? {})).toEqual(["sourcePath", "outputPath"]);
  expect(input.required).toEqual(["sourcePath", "outputPath"]);
  expect(output).toContain("in-progress");
  expect(output).toContain("retryAfterMs");
  expect(output).toContain("rootSourcePath");
  expect(output).toContain("visualReviewPerformed");
  expect(output).not.toContain("bytesBase64");
  expect(failure).toContain("toolchain-unavailable");
  expect(failure).toContain("partial-publication");
  expect(failure).toContain("publishedSource");
  expect(ScientLatexBuildTool.description).toContain("available qualified toolchain");
  expect(ScientLatexBuildTool.description).toContain(
    "LaTeX Source/Split/PDF surface in Split mode",
  );
  expect(ScientLatexBuildTool.description).toContain("Long builds return a paced in-progress");
  expect(ScientLatexBuildTool.description).toContain("does not visually review");
});
