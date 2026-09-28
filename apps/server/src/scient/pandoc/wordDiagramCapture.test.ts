import { describe, expect, it } from "@effect/vitest";

import { makeBundle, PNG_BYTES } from "./pandocTestSupport.ts";
import { capturedWordDiagramAssets, planWordDiagrams } from "./wordDiagramCapture.ts";

const digest = `sha256:${"a".repeat(64)}` as const;
const source = "flowchart LR\n  A --> B";
const markdown = ["```mermaid", source, "```", "", "```mermaid", source, "```", ""].join("\n");

describe("Word diagram capture", () => {
  it("deduplicates repeated fences and produces a PNG asset for both references", () => {
    const plan = planWordDiagrams(markdown, digest);
    expect(plan.diagrams).toHaveLength(1);
    const assets = capturedWordDiagramAssets(makeBundle({ markdown }), digest, {
      sourceDigest: digest,
      diagrams: [
        {
          id: plan.diagrams[0]!.id,
          result: { _tag: "png", base64: Buffer.from(PNG_BYTES).toString("base64") },
        },
      ],
    });
    expect(assets).toHaveLength(1);
    expect(assets[0]?.role).toBe("rendered-diagram");
    expect(assets[0]?.content._tag).toBe("bytes");
  });

  it("retains source fallback for callers without a capture and for actual render failures", () => {
    const plan = planWordDiagrams(markdown, digest);
    expect(capturedWordDiagramAssets(makeBundle({ markdown }), digest, undefined)).toEqual([]);
    expect(
      capturedWordDiagramAssets(makeBundle({ markdown }), digest, {
        sourceDigest: digest,
        diagrams: [{ id: plan.diagrams[0]!.id, result: { _tag: "render-failed" } }],
      }),
    ).toEqual([]);
  });

  it("rejects stale, extra, missing, and non-PNG captures", () => {
    const plan = planWordDiagrams(markdown, digest);
    const bundle = makeBundle({ markdown });
    const entry = {
      id: plan.diagrams[0]!.id,
      result: { _tag: "png" as const, base64: Buffer.from(PNG_BYTES).toString("base64") },
    };
    expect(() =>
      capturedWordDiagramAssets(bundle, `sha256:${"b".repeat(64)}`, {
        sourceDigest: digest,
        diagrams: [entry],
      }),
    ).toThrow(/does not match/);
    expect(() =>
      capturedWordDiagramAssets(bundle, digest, { sourceDigest: digest, diagrams: [] }),
    ).toThrow(/does not match/);
    expect(() =>
      capturedWordDiagramAssets(bundle, digest, {
        sourceDigest: digest,
        diagrams: [entry, { ...entry, id: "mermaid-0000000000000000" }],
      }),
    ).toThrow(/does not match/);
    expect(() =>
      capturedWordDiagramAssets(bundle, digest, {
        sourceDigest: digest,
        diagrams: [
          {
            ...entry,
            result: { _tag: "png", base64: Buffer.from("not a PNG").toString("base64") },
          },
        ],
      }),
    ).toThrow(/PNG/);
  });
});
