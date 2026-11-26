// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The run flow exercises the real Library files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { scientLibraryLocation } from "@scientfactory/scient-sources/library-root";
import {
  createLiteratureWatch,
  readLiteratureWatch,
  readLiteratureWatchRun,
} from "@scientfactory/scient-sources/literature-watch-store";
import { afterEach, describe, expect, it } from "@effect/vitest";

import type { MetadataRequest } from "../metadataHttp.ts";
import {
  literatureWatchTitles,
  publishLiteratureWatch,
  startLiteratureWatchRun,
} from "./LiteratureWatchOperations.ts";

const roots: string[] = [];
afterEach(() => Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true }))));

const now = new Date("2026-11-26T09:00:00Z");
const ARXIV_FEED = (ids: ReadonlyArray<string>) => `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>${ids.length}</opensearch:totalResults>
  ${ids
    .map(
      (
        id,
      ) => `<entry><id>http://arxiv.org/abs/${id}v1</id><title>Sparse autoencoder features in paper ${id}</title>
      <summary>About ${id}.</summary><published>2026-11-20T00:00:00Z</published>
      <author><name>A. Author</name></author></entry>`,
    )
    .join("")}
</feed>`;

async function setUp(ids: ReadonlyArray<string>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-watch-"));
  roots.push(root);
  const library = scientLibraryLocation(root);
  const watch = await createLiteratureWatch(
    library,
    { title: "Interp", request: "SAEs", queries: { arxiv: "abs:sae" }, everyDays: 7 },
    "agent",
    now,
  );
  const request: MetadataRequest = async (url) => ({ status: 200, body: ARXIV_FEED(ids), url });
  const options = { request, keys: {}, pace: <A>(run: () => Promise<A>) => run(), now };
  return { library, watchId: watch.watchId, options };
}

describe("literature watch run", () => {
  it("counts only titles handed out in order, and a retried publish changes nothing", async () => {
    const { library, watchId, options } = await setUp(["2611.00001", "2611.00002"]);
    const run = await startLiteratureWatchRun(library, watchId, options);
    expect(run.candidates).toHaveLength(2);
    await expect(literatureWatchTitles(library, run, 1)).rejects.toThrow("offset 0");
    await literatureWatchTitles(library, run, 0);
    const input = {
      watchId,
      runId: run.runId,
      picks: [
        { candidateId: "c2", why: "Core topic.", details: [], evidence: "abstract" as const },
      ],
      now,
    };
    const published = await publishLiteratureWatch(library, input);
    expect(published.covered.arxiv).toBe("2026-11-26");
    expect(await readLiteratureWatchRun(library, watchId)).toBeNull();
    const again = await publishLiteratureWatch(library, input);
    expect(again.briefings).toHaveLength(1);
    expect((await readLiteratureWatch(library, watchId)).seen).toHaveLength(2);
  });

  it("leaves out papers an earlier run judged", async () => {
    const { library, watchId, options } = await setUp(["2611.00001"]);
    const first = await startLiteratureWatchRun(library, watchId, options);
    await literatureWatchTitles(library, first, 0);
    await publishLiteratureWatch(library, { watchId, runId: first.runId, picks: [], now });
    const second = await startLiteratureWatchRun(library, watchId, options);
    expect(second.runId).not.toBe(first.runId);
    expect(second).toMatchObject({ candidates: [], alreadySeen: 1 });
  });
});
