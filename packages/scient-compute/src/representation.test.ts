import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ComputeRepresentationBundle,
  MAXIMUM_COMPUTE_INLINE_REPRESENTATION_BYTES,
  MAXIMUM_COMPUTE_REPRESENTATION_BUNDLE_BYTES,
  computeRepresentationBundleByteLength,
  sameComputeRepresentationBundle,
  selectComputeRepresentation,
} from "./representation.ts";

const decodeBundle = Schema.decodeUnknownSync(ComputeRepresentationBundle);

describe("compute representation bundle", () => {
  it("retains ordered text, JSON, and resource alternatives", () => {
    const bundle = decodeBundle({
      representations: [
        { mediaType: "text/plain", data: { _tag: "text", text: "answer: 42" } },
        {
          mediaType: "application/vnd.plotly.v1+json",
          data: { _tag: "json", json: '{"data":[]}' },
        },
        {
          mediaType: "image/png",
          data: { _tag: "resource", contentHash: "sha256:figure", byteLength: 128 },
        },
      ],
      metadataJson: '{"image/png":{"width":640}}',
    });

    expect(bundle.representations.map(({ mediaType }) => mediaType)).toEqual([
      "text/plain",
      "application/vnd.plotly.v1+json",
      "image/png",
    ]);
    expect(computeRepresentationBundleByteLength(bundle)).toBe(
      new TextEncoder().encode('answer: 42{"data":[]}').byteLength +
        128 +
        new TextEncoder().encode('{"image/png":{"width":640}}').byteLength,
    );
  });

  it("requires canonical MIME keys and one representation for each key", () => {
    expect(() =>
      decodeBundle({
        representations: [
          {
            mediaType: "Image/PNG",
            data: { _tag: "resource", contentHash: "sha256:a", byteLength: 1 },
          },
        ],
        metadataJson: null,
      }),
    ).toThrow();
    expect(() =>
      decodeBundle({
        representations: [
          { mediaType: "text/plain", data: { _tag: "text", text: "one" } },
          { mediaType: "text/plain", data: { _tag: "text", text: "two" } },
        ],
        metadataJson: null,
      }),
    ).toThrow();
    expect(() => decodeBundle({ representations: [], metadataJson: null })).toThrow();
  });

  it("rejects malformed JSON payloads and non-object bundle metadata", () => {
    expect(() =>
      decodeBundle({
        representations: [{ mediaType: "application/json", data: { _tag: "json", json: "{" } }],
        metadataJson: null,
      }),
    ).toThrow();
    expect(() =>
      decodeBundle({
        representations: [{ mediaType: "text/plain", data: { _tag: "text", text: "ok" } }],
        metadataJson: "[]",
      }),
    ).toThrow();
  });

  it("bounds inline and aggregate content by UTF-8 bytes", () => {
    expect(() =>
      decodeBundle({
        representations: [
          {
            mediaType: "text/plain",
            data: {
              _tag: "text",
              text: "é".repeat(Math.floor(MAXIMUM_COMPUTE_INLINE_REPRESENTATION_BYTES / 2) + 1),
            },
          },
        ],
        metadataJson: null,
      }),
    ).toThrow();
    expect(() =>
      decodeBundle({
        representations: [
          {
            mediaType: "image/png",
            data: {
              _tag: "resource",
              contentHash: "sha256:too-large",
              byteLength: MAXIMUM_COMPUTE_REPRESENTATION_BUNDLE_BYTES + 1,
            },
          },
        ],
        metadataJson: null,
      }),
    ).toThrow();
    expect(() =>
      decodeBundle({
        representations: Array.from({ length: 33 }, (_unused, index) => ({
          mediaType: `application/x-scient-${String(index)}`,
          data: { _tag: "text", text: "x" },
        })),
        metadataJson: null,
      }),
    ).toThrow();
  });

  it("selects only through the caller's reviewed priority order", () => {
    const bundle = decodeBundle({
      representations: [
        { mediaType: "text/plain", data: { _tag: "text", text: "fallback" } },
        {
          mediaType: "image/png",
          data: { _tag: "resource", contentHash: "sha256:figure", byteLength: 128 },
        },
      ],
      metadataJson: null,
    });

    expect(selectComputeRepresentation(bundle, ["image/svg+xml", "image/png"])).toMatchObject({
      _tag: "supported",
      representation: { mediaType: "image/png" },
    });
    expect(selectComputeRepresentation(bundle, ["text/html"])).toEqual({
      _tag: "unsupported",
      availableMediaTypes: ["text/plain", "image/png"],
    });
  });

  it("compares the complete ordered bundle rather than only its media keys", () => {
    const left = decodeBundle({
      representations: [{ mediaType: "text/plain", data: { _tag: "text", text: "one" } }],
      metadataJson: "{}",
    });
    const same = decodeBundle({
      representations: [{ mediaType: "text/plain", data: { _tag: "text", text: "one" } }],
      metadataJson: "{}",
    });
    const changed = decodeBundle({
      representations: [{ mediaType: "text/plain", data: { _tag: "text", text: "two" } }],
      metadataJson: "{}",
    });
    const reordered = decodeBundle({
      representations: [
        {
          mediaType: "image/png",
          data: { _tag: "resource", contentHash: "sha256:a", byteLength: 1 },
        },
        { mediaType: "text/plain", data: { _tag: "text", text: "one" } },
      ],
      metadataJson: "{}",
    });
    const sameReordered = decodeBundle({
      representations: [
        { mediaType: "text/plain", data: { _tag: "text", text: "one" } },
        {
          mediaType: "image/png",
          data: { _tag: "resource", contentHash: "sha256:a", byteLength: 1 },
        },
      ],
      metadataJson: "{}",
    });

    expect(sameComputeRepresentationBundle(left, same)).toBe(true);
    expect(sameComputeRepresentationBundle(left, changed)).toBe(false);
    expect(sameComputeRepresentationBundle(reordered, sameReordered)).toBe(true);
  });
});
