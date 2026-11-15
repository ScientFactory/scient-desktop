// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The test keeps a real Library in a temporary folder and sets the check's clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readScientLibraryNoticeWatch } from "@scientfactory/scient-sources/library-notice-watch";
import {
  ensureScientLibrary,
  scientLibraryLocation,
} from "@scientfactory/scient-sources/library-root";
import { importScientSource, readScientSourceRecord } from "@scientfactory/scient-sources/store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { runLibraryNoticeWatch } from "./LibraryNoticeWatch.ts";

// The header and one row of https://gitlab.com/crossref/retraction-watch-data (2026-11-13).
const FILE = `Record ID,Title,Subject,Institution,Journal,Publisher,Country,Author,URLS,ArticleType,RetractionDate,RetractionDOI,RetractionPubMedID,OriginalPaperDate,OriginalPaperDOI,OriginalPaperPubMedID,RetractionNature,Reason,Paywalled,Notes,
2,Regulation of Wnt/beta-catenin pathway by cPLA2alpha and PPARdelta,(BLS) Biology - Cancer;(BLS) Biology - Cellular;(BLS) Biology - Molecular;,"Department of Pathology, University of Pittsburgh School of Medicine, Pittsburgh, Pennsylvania 15213, USA",Journal of Cellular Biochemistry,Wiley,United States,Chang Han;Kyu Lim;Lihong Xu;Guiying Li;Tong Wu,http://retractionwatch.com/2015/02/09/figure-dupe-sinks-cell-bio-paper/,Research Article;,1/29/2015 0:00,10.1002/jcb.25020,25767853,7/17/2008 0:00,10.1002/jcb.21852,18636547,Retraction,Duplication of/in Image;Falsification/Fabrication of Image;Investigation by Company/Institution;,No,,
`;
const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function setup(identifier: { readonly scheme: string; readonly value: string }) {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-notice-watch-")),
  );
  fixtures.push(base);
  const root = NodePath.join(base, "scient", "library");
  await ensureScientLibrary(root);
  const library = scientLibraryLocation(root);
  const imported = await importScientSource({
    root: library,
    operationId: NodeCrypto.randomUUID(),
    candidate: {
      sourceKey: "held",
      type: "article",
      customType: null,
      title: "Regulation of Wnt/beta-catenin pathway by cPLA2alpha and PPARdelta",
      creators: [],
      issuedRaw: "2008",
      issuedYear: 2008,
      identifiers: [identifier],
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
  });
  const sourceId = imported.record?.sourceId;
  if (!sourceId) throw new Error("Expected an imported record.");
  const asked: Array<Readonly<Record<string, string>>> = [];
  let clock = Date.parse("2026-11-15T10:00:00.000Z");
  return {
    library,
    asked,
    later: (ms: number) => (clock += ms),
    state: async () => (await readScientSourceRecord(library, sourceId))?.editorialStatus?.state,
    run: (answer: () => Response | Promise<Response>) =>
      runLibraryNoticeWatch({
        library,
        now: () => new Date(clock),
        fetch: async (_url, init) => {
          asked.push(init.headers);
          return answer();
        },
      }),
  };
}

const theFile = () => new Response(FILE, { status: 200, headers: { etag: '"v1"' } });

describe("the weekly notice check", () => {
  it("asks once a week, and a week without a new file costs one conditional request", async () => {
    const { asked, later, state, run } = await setup({ scheme: "doi", value: "10.1002/jcb.21852" });

    expect(await run(theFile)).toBe("checked");
    expect(await state()).toBe("retracted");

    // The next pass, six hours later, and a restart in between: the Library remembers.
    later(6 * HOUR);
    expect(await run(theFile)).toBe("not-due");
    expect(asked).toHaveLength(1);

    later(WEEK);
    expect(await run(() => new Response(null, { status: 304 }))).toBe("unchanged");
    expect(asked[1]).toMatchObject({ "If-None-Match": '"v1"' });
    later(6 * HOUR);
    expect(await run(theFile)).toBe("not-due");
    expect(asked).toHaveLength(2);
  });

  it.each([
    ["no connection", () => Promise.reject(new TypeError("fetch failed"))],
    ["an error from the server", () => new Response("Service unavailable", { status: 503 })],
    ["a file cut short", () => new Response(FILE.slice(0, -4), { status: 200 })],
  ])("changes nothing after %s and tries again at the next pass", async (_name, answer) => {
    const { library, state, run } = await setup({ scheme: "doi", value: "10.1002/jcb.21852" });

    await expect(run(answer)).rejects.toThrow();
    expect(await state()).toBeUndefined();
    expect(await readScientLibraryNoticeWatch(library)).toBeNull();

    expect(await run(theFile)).toBe("checked");
    expect(await state()).toBe("retracted");
  });

  it("asks for nothing while no source has a DOI or PMID", async () => {
    const { library, asked, run } = await setup({ scheme: "isbn", value: "9780306406157" });

    expect(await run(theFile)).toBe("nothing-to-check");
    expect(asked).toHaveLength(0);
    expect(await readScientLibraryNoticeWatch(library)).toBeNull();
  });
});
