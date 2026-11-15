// @effect-diagnostics nodeBuiltinImport:off -- A measurement script over a real library folder.
// @effect-diagnostics globalDate:off globalTimers:off globalConsole:off -- It times with the wall clock.
/**
 * Times a whole Zotero library moving in: the import in its parts, Recent changes, and a
 * refresh of everything. Zotero is a recorded library answered from memory (no network, no
 * PDFs), so the numbers are Scient's own work and the count of requests it would send.
 *   node scripts/measureZoteroImport.ts <recorded items.json> [--work <folder>]
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import { listScientSourceImports } from "@scientfactory/scient-sources/store";

import {
  advanceSourceImport,
  beginZoteroScopedImport,
  continueZoteroImportRun,
} from "../src/scient/sources/ScientSourcesCoordinator.ts";
import { fakeZoteroAccess, fakeZoteroTransport } from "../src/scient/sources/Zotero.testkit.ts";
import { decodeZoteroRawItems, type ZoteroRawItem } from "../src/scient/sources/ZoteroItems.ts";
import { refreshZoteroSources } from "../src/scient/sources/ZoteroSync.ts";

const [recorded, ...flags] = NodeProcess.argv.slice(2);
if (!recorded) throw new Error("Pass the recorded items file.");
const workFlag = flags.indexOf("--work");
const work =
  workFlag >= 0 && flags[workFlag + 1]
    ? NodePath.resolve(flags[workFlag + 1] ?? "")
    : await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-zotero-measure-"));

// The recording is of a public group; here it stands for the person's own library.
const all = decodeZoteroRawItems(JSON.parse(await NodeFSP.readFile(recorded, "utf8"))).map(
  (item): ZoteroRawItem => ({ ...item, library: { type: "user", id: 0 } }),
);
const children = new Map<string, ZoteroRawItem[]>();
for (const item of all) {
  const parent = item.data.parentItem;
  if (typeof parent !== "string") continue;
  const siblings = children.get(parent) ?? [];
  siblings.push(item);
  children.set(parent, siblings);
}
const items = new Map(
  all
    .filter((item) => typeof item.data.parentItem !== "string")
    .map((item) => [item.key, { item, children: children.get(item.key) ?? [] }]),
);
const transport = fakeZoteroTransport({ items });
const zotero = fakeZoteroAccess(transport);

const libraryRoot = scientLibraryRootFor(NodePath.join(work, "state"));
await ensureScientLibrary(libraryRoot);
const root = scientLibraryLocation(libraryRoot);

const seconds = (from: number) => ((performance.now() - from) / 1000).toFixed(1);
const requestsSince = (mark: number) => {
  const sent = transport.requests.slice(mark);
  const listings = sent.filter((path) => path.includes("format=keys")).length;
  return `${sent.length} (${listings} listings)`;
};
const operationBytes = async (operationId: string) => {
  for (const entry of await NodeFSP.readdir(libraryRoot, { recursive: true })) {
    if (NodePath.basename(entry) === `${operationId}.json` && entry.includes("operations")) {
      return (await NodeFSP.stat(NodePath.join(libraryRoot, entry))).size;
    }
  }
  return 0;
};

console.log(
  `| Part | References | Imported | Skipped | Failed | Seconds | Requests | Operation file |`,
);
console.log(`|---|---|---|---|---|---|---|---|`);
const began = performance.now();
let operation = await beginZoteroScopedImport({
  root,
  operationId: "measure",
  scope: { kind: "library" },
  zotero,
});
let totals = { imported: 0, skipped: 0, failed: 0 };
for (let mark = 0, started = began; ;) {
  while (operation.state === "running") {
    operation = await advanceSourceImport({ root, operationId: operation.operationId, zotero });
  }
  const count = (state: string) => operation.items.filter((item) => item.state === state).length;
  totals = {
    imported: totals.imported + count("imported"),
    skipped: totals.skipped + count("skipped"),
    failed: totals.failed + count("failed"),
  };
  const kilobytes = Math.round((await operationBytes(operation.operationId)) / 1024);
  console.log(
    `| ${operation.run?.part ?? 1} | ${operation.items.length} | ${count("imported")} | ${count("skipped")} | ${count("failed")} | ${seconds(started)} | ${requestsSince(mark)} | ${kilobytes} KB |`,
  );
  if (!operation.run || operation.run.remaining === 0) break;
  mark = transport.requests.length;
  started = performance.now();
  operation = await continueZoteroImportRun({ root, runId: "measure", zotero });
}
console.log(
  `\nImport: ${items.size} top-level items in Zotero; ${totals.imported} imported, ${totals.skipped} skipped, ${totals.failed} failed, in ${seconds(began)} s, ${transport.requests.length} requests.`,
);

const listed = performance.now();
const imports = await listScientSourceImports(root, 50);
console.log(
  `Recent changes: ${imports.length} import (${imports[0]?.importedSourceIds.length ?? 0} sources, ${imports[0]?.notBrought ?? 0} kinds not brought) read in ${seconds(listed)} s.`,
);

const refreshed = performance.now();
const before = transport.requests.length;
let checked = 0;
let batches = 0;
for (let after: string | null | undefined = null; after !== undefined; batches += 1) {
  const batch = await refreshZoteroSources({ root, actor: "user", zotero, after });
  checked += batch.items.length;
  after = batch.next;
}
console.log(
  `Refresh: ${checked} sources in ${batches} batches, ${seconds(refreshed)} s, ${transport.requests.length - before} requests.`,
);
console.log(`Work folder: ${work}`);
