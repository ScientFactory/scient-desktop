// @effect-diagnostics globalDate:off -- Fixed Date values make retrieval timestamps deterministic.
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import type { MetadataRequest } from "./metadataHttp.ts";
import {
  applyResolvedSourceMetadata,
  resolveSourceIdentifier,
  resolveSourceIdentifierBatch,
  type RequestPace,
} from "./SourceIdentifierResolver.ts";

const now = () => new Date("2026-11-10T12:00:00.000Z");
const pace: RequestPace = (run) => run();

// Recorded from export.arxiv.org on 2026-11-10 for id_list=1706.03762,2501.99999,hep-th/9901001;
// abstracts and author lists shortened. The unknown 2501.99999 is simply absent.
const FEED = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/jLE6Teib5libldd5av8pvX+ShyY</id>
  <title>arXiv Query: search_query=&amp;id_list=1706.03762,2501.99999,hep-th/9901001&amp;start=0&amp;max_results=10</title>
  <opensearch:totalResults>2</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You
      Need</title>
    <link href="https://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <summary>The dominant sequence transduction models are based on complex recurrent or
      convolutional neural networks.</summary>
    <published>2017-06-12T17:57:34Z</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Aidan N. Gomez</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/hep-th/9901001v3</id>
    <title>String Junctions and Their Duals in Heterotic String Theory</title>
    <summary>  We explicitly give the correspondence between spectra of heterotic string theory.</summary>
    <published>1999-01-01T01:01:10Z</published>
    <arxiv:journal_ref>Prog.Theor.Phys.101:1155-1164,1999</arxiv:journal_ref>
    <author><name>Yosuke Imamura</name></author>
    <arxiv:doi>10.1143/PTP.101.1155</arxiv:doi>
  </entry>
</feed>`;

function respond(status: number, body: string): MetadataRequest {
  return async (url) => ({ status, body, url });
}

describe("arXiv identifiers", () => {
  it("maps an arXiv entry into preprint metadata", async () => {
    const request = vi.fn<MetadataRequest>(respond(200, FEED));
    const resolution = await resolveSourceIdentifier(
      [{ scheme: "arxiv", value: "arXiv:1706.03762v2" }],
      { request, now, pace },
    );

    expect(request.mock.calls[0]?.[0].href).toBe(
      "https://export.arxiv.org/api/query?id_list=1706.03762&max_results=1",
    );
    expect(resolution).toEqual({
      status: "found",
      identifier: { scheme: "arxiv", value: "1706.03762" },
      retrievedAt: "2026-11-10T12:00:00.000Z",
      origin: "arxiv",
      metadata: {
        type: "preprint",
        title: "Attention Is All You Need",
        creators: [
          { creatorType: "author", givenName: "Ashish", familyName: "Vaswani", literalName: null },
          { creatorType: "author", givenName: "Aidan N.", familyName: "Gomez", literalName: null },
        ],
        issuedRaw: "2017-06-12",
        issuedYear: 2017,
        identifiers: [{ scheme: "arxiv", value: "1706.03762" }],
        abstract:
          "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
        abstractSections: [
          {
            title: null,
            paragraphs: [
              "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
            ],
          },
        ],
        containerTitle: null,
        publisher: "arXiv",
        volume: null,
        issue: null,
        pages: null,
        language: null,
        url: "https://arxiv.org/abs/1706.03762",
      },
    });
  });

  it("answers a batch in one request, with absent IDs not found and the published DOI kept", async () => {
    const request = vi.fn<MetadataRequest>(respond(200, FEED));
    const resolutions = await resolveSourceIdentifierBatch(
      [
        { scheme: "arxiv", value: "1706.03762" },
        { scheme: "arxiv", value: "2501.99999" },
        { scheme: "arxiv", value: "hep-th/9901001" },
        { scheme: "arxiv", value: "not-an-id" },
      ],
      { request, now, pace },
    );

    expect(request).toHaveBeenCalledOnce();
    expect(new URL(request.mock.calls[0]![0]).searchParams.get("id_list")).toBe(
      "1706.03762,2501.99999,hep-th/9901001",
    );
    expect(resolutions.map((resolution) => resolution.status)).toEqual([
      "found",
      "not-found",
      "found",
      "not-found",
    ]);
    const published = resolutions[2];
    expect(published?.status === "found" && published.metadata.identifiers).toEqual([
      { scheme: "arxiv", value: "hep-th/9901001" },
      { scheme: "doi", value: "10.1143/PTP.101.1155" },
    ]);
  });

  it("finds an old-style ID written with its subject class", async () => {
    // Recorded from export.arxiv.org on 2026-11-11 for id_list=math/0211159; abstract shortened.
    // The same request with math.DG/0211159 returns an empty feed.
    const feed = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/math/0211159v1</id>
    <title>The entropy formula for the Ricci flow and its geometric applications</title>
    <summary>  We present a monotonic expression for the Ricci flow, valid in all dimensions.</summary>
    <category term="math.DG" scheme="http://arxiv.org/schemas/atom"/>
    <published>2002-11-11T16:11:49Z</published>
    <author>
      <name>Grisha Perelman</name>
    </author>
  </entry>
</feed>`;
    const request = vi.fn<MetadataRequest>(respond(200, feed));
    const resolution = await resolveSourceIdentifier(
      [{ scheme: "arxiv", value: "arXiv:math.DG/0211159" }],
      { request, pace },
    );
    expect(new URL(request.mock.calls[0]![0]).searchParams.get("id_list")).toBe("math/0211159");
    expect(resolution?.status === "found" && resolution.metadata.title).toBe(
      "The entropy formula for the Ricci flow and its geometric applications",
    );
  });

  it.each([
    { name: "arXiv answers 503", request: respond(503, "") },
    { name: "the body is not a feed", request: respond(200, "<html></html>") },
    {
      name: "the request fails",
      request: (() => Promise.reject(new Error("offline"))) satisfies MetadataRequest,
    },
  ])("is unavailable when $name", async ({ request }) => {
    await expect(
      resolveSourceIdentifier([{ scheme: "arxiv", value: "1706.03762" }], { request, pace }),
    ).resolves.toEqual({
      status: "unavailable",
      identifier: { scheme: "arxiv", value: "1706.03762" },
    });
  });

  it("records arXiv as the provenance of the fields it supplied", async () => {
    const resolution = await resolveSourceIdentifier([{ scheme: "arxiv", value: "1706.03762" }], {
      request: respond(200, FEED),
      now,
      pace,
    });
    if (resolution?.status !== "found") throw new Error("expected a found resolution");
    const applied = applyResolvedSourceMetadata(
      {
        sourceKey: "agent_1",
        type: "other",
        customType: null,
        title: null,
        creators: [],
        issuedRaw: null,
        issuedYear: null,
        identifiers: [{ scheme: "arxiv", value: "1706.03762" }],
        abstract: null,
        containerTitle: null,
        publisher: null,
        volume: null,
        issue: null,
        pages: null,
        language: null,
        url: null,
        tags: [],
        externalReferences: [],
        fieldProvenance: [],
        pdfAvailable: false,
        pdfFileName: null,
        pdfAttachmentCount: 0,
      },
      resolution,
    );
    expect(applied.fieldProvenance.find((entry) => entry.field === "abstract")).toEqual({
      field: "abstract",
      origin: "arxiv",
      sourceField: "summary",
      sourceIdentifier: { scheme: "arxiv", value: "1706.03762" },
      retrievedAt: "2026-11-10T12:00:00.000Z",
    });
    expect(applied.type).toBe("preprint");
  });
});
