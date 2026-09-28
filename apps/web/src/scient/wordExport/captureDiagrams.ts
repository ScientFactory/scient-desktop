import type { ScientWordDiagramCapture, ScientWordDiagramPlan } from "@t3tools/contracts";

import { mermaidSvgToPngBlob } from "../diagrams/mermaidExport";
import { planMermaidRecovery } from "../diagrams/mermaidRecovery";
import { getMermaidRuntimePromise, renderMermaidDiagram } from "../diagrams/mermaidRuntime";
import { mermaidConfigFetchRisk, mermaidSourceFetchRisk } from "./diagramSafety";

const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_PNG_BYTES = 8 * 1024 * 1024;

type DiagramResult = ScientWordDiagramCapture["diagrams"][number]["result"];
const RENDER_FAILED: DiagramResult = { _tag: "render-failed" };

/**
 * The source Mermaid will draw, when drawing it cannot fetch anything: the
 * diagram as written, or the repaired copy the renderer falls back to after
 * a syntax error. Its configuration is checked as Mermaid parsed it.
 */
async function renderableSource(source: string): Promise<string | null> {
  const { default: mermaid } = await getMermaidRuntimePromise();
  for (const candidate of [source, planMermaidRecovery(source)?.source]) {
    if (candidate === undefined) continue;
    const parsed = await mermaid.parse(candidate, { suppressErrors: true });
    if (parsed === false) continue;
    return mermaidSourceFetchRisk(candidate) === null &&
      mermaidConfigFetchRisk(parsed.config) === null
      ? candidate
      : null;
  }
  return null;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 16_384));
  }
  return btoa(binary);
}

/**
 * Renders only the server-selected fences; source identity is rechecked on
 * export. A diagram that cannot be rendered safely, or at all, is reported
 * as `render-failed`, which the Word file shows as its labelled Mermaid
 * source with a note; one diagram never stops the export.
 */
export async function captureWordDiagrams(
  plan: ScientWordDiagramPlan,
): Promise<ScientWordDiagramCapture> {
  let total = 0;
  const diagrams: ScientWordDiagramCapture["diagrams"][number][] = [];
  for (const { id, source } of plan.diagrams) {
    const result = await (async (): Promise<DiagramResult> => {
      if ((await renderableSource(source)) === null) return RENDER_FAILED;
      const { svg } = await renderMermaidDiagram(source, "light");
      // Refuses an SVG that still refers outside itself before drawing it.
      const blob = await mermaidSvgToPngBlob(svg, "light");
      if (
        blob.type !== "image/png" ||
        blob.size > MAX_PNG_BYTES ||
        total + blob.size > MAX_TOTAL_PNG_BYTES
      ) {
        return RENDER_FAILED;
      }
      total += blob.size;
      return { _tag: "png", base64: base64(new Uint8Array(await blob.arrayBuffer())) };
    })().catch(() => RENDER_FAILED);
    diagrams.push({ id, result });
  }
  return { sourceDigest: plan.sourceDigest, diagrams };
}
