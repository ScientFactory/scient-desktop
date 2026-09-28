import type { ScientWordDiagramCapture, ScientWordDiagramPlan } from "@t3tools/contracts";

import { mermaidSvgToPngBlob } from "../diagrams/mermaidExport";
import { planMermaidRecovery } from "../diagrams/mermaidRecovery";
import { mermaidConfigFetchRisk, mermaidStyleFetchRisk } from "./diagramSafety";
import { openIsolatedMermaid, type IsolatedMermaid } from "./isolatedMermaid";

const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_PNG_BYTES = 8 * 1024 * 1024;

type DiagramResult = ScientWordDiagramCapture["diagrams"][number]["result"];
const RENDER_FAILED: DiagramResult = { _tag: "render-failed" };

/**
 * The source to draw: the diagram as written, or the repaired copy chat
 * falls back to after a syntax error. Null when neither parses, or when its
 * styles or settings refer to an outside resource.
 */
async function drawableSource(mermaid: IsolatedMermaid, source: string): Promise<string | null> {
  for (const candidate of [source, planMermaidRecovery(source)?.source]) {
    if (candidate === undefined) continue;
    const parsed = await mermaid.parse(candidate);
    if (parsed === null) continue;
    return mermaidStyleFetchRisk(candidate) === null &&
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
 * Renders only the server-selected fences, in a frame that cannot fetch
 * (`isolatedMermaid.ts`); source identity is rechecked on export. A diagram
 * that is refused, needed an outside resource, fails to render, or exceeds
 * the PNG budget is reported as `render-failed`, which the Word file shows
 * as its labelled Mermaid source with a note; one diagram never stops the
 * export.
 */
export async function captureWordDiagrams(
  plan: ScientWordDiagramPlan,
): Promise<ScientWordDiagramCapture> {
  const failed = (): ScientWordDiagramCapture => ({
    sourceDigest: plan.sourceDigest,
    diagrams: plan.diagrams.map(({ id }) => ({ id, result: RENDER_FAILED })),
  });
  if (plan.diagrams.length === 0) return failed();
  const mermaid = await openIsolatedMermaid().catch(() => null);
  if (mermaid === null) return failed();

  let total = 0;
  const diagrams: ScientWordDiagramCapture["diagrams"][number][] = [];
  try {
    for (const { id, source } of plan.diagrams) {
      const result = await (async (): Promise<DiagramResult> => {
        const drawable = await drawableSource(mermaid, source);
        if (drawable === null) return RENDER_FAILED;
        const { svg, refused } = await mermaid.render(drawable);
        if (refused > 0) return RENDER_FAILED;
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
  } finally {
    mermaid.close();
  }
  return { sourceDigest: plan.sourceDigest, diagrams };
}
