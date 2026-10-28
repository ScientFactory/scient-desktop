import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import { ScientSkillReadResourceTool } from "../skills/tools.ts";
import { ScientSourcesToolkit } from "../sources/tools.ts";
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
  expect(Object.keys(input.properties ?? {})).toEqual([
    "sourcePath",
    "rootSourcePath",
    "outputPath",
  ]);
  expect(input.required).toEqual(["sourcePath", "outputPath"]);
  expect(output).toContain("in-progress");
  expect(output).toContain("retryAfterMs");
  expect(output).toContain("rootSourcePath");
  expect(output).toContain("visualReviewPerformed");
  expect(output).not.toContain("bytesBase64");
  expect(failure).toContain("toolchain-unavailable");
  expect(failure).toContain("partial-publication");
  expect(failure).toContain("publishedSource");
  expect(ScientLatexBuildTool.description).toContain("retryAfterMs");
});

it("advertises Scient tool inputs without the trimmed-string regex but still rejects blank or untrimmed values", () => {
  const advertised = JSON.stringify([
    advertisedJsonSchema(ScientPdfBuildTool),
    advertisedJsonSchema(ScientLatexBuildTool),
    advertisedJsonSchema(ScientSourcesToolkit.tools.scient_sources_get),
    advertisedJsonSchema(ScientSourcesToolkit.tools.scient_sources_update),
    advertisedJsonSchema(ScientSkillReadResourceTool),
  ]);
  expect(advertised).not.toContain(String.raw`^\\S[\\s\\S]*\\S$`);
  expect(advertised).toContain('"minLength":1');

  const decodePdf = Schema.decodeUnknownExit(ScientPdfBuildTool.parametersSchema);
  expect(Exit.isSuccess(decodePdf({ sourcePath: "doc.html", outputPath: "doc.pdf" }))).toBe(true);
  const untrimmed = decodePdf({ sourcePath: " doc.html", outputPath: "doc.pdf" });
  expect(Exit.isFailure(untrimmed) && String(untrimmed.cause)).toContain(
    "a string with no leading or trailing whitespace",
  );
  expect(Exit.isFailure(decodePdf({ sourcePath: "", outputPath: "doc.pdf" }))).toBe(true);

  const decodeSource = Schema.decodeUnknownExit(
    ScientSourcesToolkit.tools.scient_sources_get.parametersSchema,
  );
  expect(Exit.isFailure(decodeSource({ sourceId: "" }))).toBe(true);
  expect(Exit.isFailure(decodeSource({ sourceId: "  " }))).toBe(true);
  expect(Exit.isFailure(decodeSource({ sourceId: "source-1 " }))).toBe(true);
  const decodeResource = Schema.decodeUnknownExit(ScientSkillReadResourceTool.parametersSchema);
  expect(Exit.isFailure(decodeResource({ name: "skill", path: " notes.md" }))).toBe(true);
  expect(Exit.isFailure(decodeResource({ name: " skill", path: "notes.md" }))).toBe(true);
});
