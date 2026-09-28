import type { ScientWordDiagramCapture, ScientWordDiagramPlan } from "@t3tools/contracts";

import { mermaidSvgToPngBlob } from "../diagrams/mermaidExport";
import { MermaidRenderError, renderMermaidDiagram } from "../diagrams/mermaidRuntime";
import { isMermaidSyntaxError } from "../diagrams/mermaidRecovery";

const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_PNG_BYTES = 8 * 1024 * 1024;

/** Renders only the server-selected fences; source identity is rechecked on export. */
export async function captureWordDiagrams(
  plan: ScientWordDiagramPlan,
): Promise<ScientWordDiagramCapture> {
  let total = 0;
  const diagrams: ScientWordDiagramCapture["diagrams"][number][] = [];
  for (const { id, source } of plan.diagrams) {
    // Mermaid can create DOM while rendering, before the SVG rasterizer gets
    // a chance to inspect it. Refuse sources that could load a resource there.
    if (
      /(?:https?:|(?:^|[\s"'(])\/\/|url\s*\(|@import|<\s*(?:img|image|link|iframe|script)\b|\b(?:img|image)\s*:|%%\s*\{|\\[0-9a-f]{1,6}(?:\s|$)?)/iu.test(
        source,
      )
    ) {
      throw new Error(
        "The Mermaid diagram contains an external resource and cannot be exported to Word.",
      );
    }
    let svg: string;
    try {
      svg = (await renderMermaidDiagram(source, "light")).svg;
    } catch (cause) {
      if (
        (cause instanceof MermaidRenderError && isMermaidSyntaxError(cause.cause)) ||
        source.trim() === "" ||
        source.length > 50_000
      ) {
        diagrams.push({ id, result: { _tag: "render-failed" } });
        continue;
      }
      throw cause;
    }
    const blob = await mermaidSvgToPngBlob(svg, "light");
    if (
      blob.type !== "image/png" ||
      blob.size > MAX_PNG_BYTES ||
      total + blob.size > MAX_TOTAL_PNG_BYTES
    ) {
      throw new Error("The Mermaid diagrams exceed the Word export PNG limit.");
    }
    total += blob.size;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 16_384) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 16_384));
    }
    diagrams.push({ id, result: { _tag: "png", base64: btoa(binary) } });
  }
  return { sourceDigest: plan.sourceDigest, diagrams };
}
