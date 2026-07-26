import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { LiveHtmlPreviewPrepareResult } from "./liveHtmlPreviewTransport";

describe("live HTML preview RPC transport", () => {
  it("preserves watched paths through the versioned success codec", () => {
    const decoded = Schema.decodeUnknownSync(LiveHtmlPreviewPrepareResult)({
      mode: "static-document",
      warnings: [],
      previewUrl: "http://g-preview.preview.localhost:5000/report.html",
      watchedPaths: ["/workspace/report.html", "/workspace/theme.css"],
    });
    const encoded = Schema.encodeSync(LiveHtmlPreviewPrepareResult)(decoded);
    const roundTripped = Schema.decodeUnknownSync(LiveHtmlPreviewPrepareResult)(encoded);

    expect(decoded.watchedPaths).toEqual(["/workspace/report.html", "/workspace/theme.css"]);
    expect(encoded.watchedPaths).toEqual(["/workspace/report.html", "/workspace/theme.css"]);
    expect(roundTripped.watchedPaths).toEqual(["/workspace/report.html", "/workspace/theme.css"]);
  });
});
