import type { ScientWordDiagramCapture, ScientWordDiagramPlan } from "@t3tools/contracts";

import { mermaidSvgToPngBlob } from "../diagrams/mermaidExport";
import { MAX_MERMAID_SOURCE_LENGTH, renderMermaidDiagram } from "../diagrams/mermaidRuntime";
import { mermaidSourceConfigFetchRisk, mermaidStyleFetchRisk } from "./diagramSafety";

const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_PNG_BYTES = 8 * 1024 * 1024;

type DiagramResult = ScientWordDiagramCapture["diagrams"][number]["result"];
const RENDER_FAILED: DiagramResult = { _tag: "render-failed" };

const captureSafe = (source: string) =>
  source.trim().length > 0 &&
  source.length <= MAX_MERMAID_SOURCE_LENGTH &&
  mermaidStyleFetchRisk(source) === null &&
  mermaidSourceConfigFetchRisk(source) === null;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 16_384));
  }
  return btoa(binary);
}

/**
 * Only server-selected fences are captured; publication rechecks their source identity.
 * Chat's renderer owns original-first recovery. Unsupported resources, draw/PNG failures,
 * and byte budgets fall back independently to the original labelled source in Word.
 */
export async function captureWordDiagrams(
  plan: ScientWordDiagramPlan,
): Promise<ScientWordDiagramCapture> {
  let total = 0;
  const diagrams: ScientWordDiagramCapture["diagrams"][number][] = [];
  for (const { id, source } of plan.diagrams) {
    const result = await (async (): Promise<DiagramResult> => {
      if (!captureSafe(source)) return RENDER_FAILED;
      const rendered = await renderMermaidDiagram(source, "light");
      if (
        rendered.diagramType === "error" ||
        (rendered.blocked?.length ?? 0) > 0 ||
        (rendered.recovery && !captureSafe(rendered.recovery.source))
      )
        return RENDER_FAILED;
      const blob = await mermaidSvgToPngBlob(rendered.svg, "light");
      if (
        blob.type !== "image/png" ||
        blob.size > MAX_PNG_BYTES ||
        total + blob.size > MAX_TOTAL_PNG_BYTES
      )
        return RENDER_FAILED;
      const encoded = base64(new Uint8Array(await blob.arrayBuffer()));
      total += blob.size;
      return { _tag: "png", base64: encoded };
    })().catch(() => RENDER_FAILED);
    diagrams.push({ id, result });
  }
  return { sourceDigest: plan.sourceDigest, diagrams };
}
