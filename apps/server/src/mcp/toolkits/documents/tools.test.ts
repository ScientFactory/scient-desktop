import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { ScientPdfBuildTool } from "./tools.ts";

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
