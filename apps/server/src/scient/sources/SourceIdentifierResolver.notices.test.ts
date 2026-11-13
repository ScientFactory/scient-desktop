import { describe, expect, it } from "@effect/vitest";

import type { MetadataRequest } from "./metadataHttp.ts";
import { resolveSourceIdentifier } from "./SourceIdentifierResolver.ts";

const respond =
  (body: unknown): MetadataRequest =>
  async (url) => ({ status: 200, body: JSON.stringify(body), url: new URL(url) });

describe("resolveSourceIdentifier registry links", () => {
  it("carries retraction notices and preprint relations from doi.org CSL-JSON", async () => {
    const resolution = await resolveSourceIdentifier([{ scheme: "doi", value: "10.1000/x" }], {
      request: respond({
        title: "RETRACTED: A study",
        "updated-by": [
          {
            DOI: "10.1000/notice",
            type: "retraction",
            source: "retraction-watch",
            updated: { "date-time": "2010-02-06T00:00:00Z" },
          },
          { type: "" },
          "garbage",
        ],
        relation: {
          "is-preprint-of": [{ id: "10.1000/published", "id-type": "DOI" }],
          "has-review": { id: "10.1000/review", "id-type": "doi" },
          broken: [{}],
        },
      }),
    });
    expect(resolution?.status === "found" && resolution.metadata).toMatchObject({
      updates: [
        {
          type: "retraction",
          doi: "10.1000/notice",
          date: "2010-02-06",
          source: "retraction-watch",
        },
      ],
      relations: [
        { type: "is-preprint-of", idType: "doi", id: "10.1000/published" },
        { type: "has-review", idType: "doi", id: "10.1000/review" },
      ],
    });
  });

  it("still finds a work whose registry links have an unexpected shape", async () => {
    const resolution = await resolveSourceIdentifier([{ scheme: "doi", value: "10.1000/y" }], {
      request: respond({ title: "Plain", "updated-by": { type: "retraction" }, relation: "x" }),
    });
    expect(resolution?.status).toBe("found");
    expect(resolution?.status === "found" && resolution.metadata.updates).toBeUndefined();
  });
});
