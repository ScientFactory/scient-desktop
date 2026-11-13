// @effect-diagnostics nodeBuiltinImport:off -- Note tests use real project folders and a second process.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { initializeScientProject } from "@scientfactory/project-init";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { ScientLibraryBusyError } from "./libraryLock.ts";
import { ensureScientLibrary, scientLibraryLocation, scientLibraryRootFor } from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import { SCIENT_PROJECT_NOTE_CHECKPOINTS } from "./projectNoteHistory.ts";
import {
  changeScientProjectPins,
  pinScientLibrarySource,
  readScientProjectPinNoteHistory,
  readScientProjectPins,
  setScientProjectPinNote,
  unpinScientLibrarySource,
  withScientProjectPinsLock,
} from "./projectPins.ts";
import { importScientSource } from "./store.ts";

const fixtures: string[] = [];
const children: NodeChildProcess.ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-notes-")),
  );
  fixtures.push(base);
  const libraryRoot = scientLibraryRootFor(NodePath.join(base, "state"));
  await ensureScientLibrary(libraryRoot);
  const library = scientLibraryLocation(libraryRoot);
  const projectRoot = NodePath.join(base, "project");
  await NodeFSP.mkdir(projectRoot);
  await initializeScientProject({ root: projectRoot });
  const add = async (sourceKey: string) => {
    const candidate: ScientSourceCandidate = {
      sourceKey,
      type: "article",
      customType: null,
      title: `Study ${sourceKey}`,
      creators: [
        { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
      ],
      issuedRaw: "2020",
      issuedYear: 2020,
      identifiers: [],
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
    };
    const imported = await importScientSource({
      root: library,
      operationId: NodeCrypto.randomUUID(),
      candidate,
      allowPossibleMetadataMatch: true,
    });
    return imported.record!;
  };
  return { base, library, projectRoot, add };
}

const notes = (versions: ReadonlyArray<{ readonly note: string | null }> | null) =>
  versions?.map((version) => version.note);

describe("project notes", () => {
  it("refuses a stale note, keeps every accepted text and restores one as a checked write", async () => {
    const { library, projectRoot, add } = await setup();
    const record = await add("A");
    const pinned = await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: record.sourceId,
      actor: "user",
      note: "Original",
    });
    const key = pinned.outcome === "pinned" ? pinned.pin.citationKey : "";

    // Two editors saw "Original"; the second one's save must not erase the first one's.
    expect(
      await setScientProjectPinNote({
        projectRoot,
        citationKey: key,
        note: "From the panel",
        base: "Original",
        actor: "user",
      }),
    ).toMatchObject({ outcome: "updated" });
    expect(
      await setScientProjectPinNote({
        projectRoot,
        citationKey: key,
        note: "From the agent",
        base: "Original",
        actor: "agent",
      }),
    ).toMatchObject({ outcome: "stale", pin: { note: "From the panel" } });
    // No base is "I saw no note": it cannot replace one either.
    expect(
      await setScientProjectPinNote({
        projectRoot,
        citationKey: key,
        note: "Blind",
        actor: "agent",
      }),
    ).toMatchObject({ outcome: "stale" });
    expect(
      await changeScientProjectPins({
        projectRoot,
        library,
        actor: "agent",
        changes: [{ action: "pin", sourceId: record.sourceId, note: "Blind batch" }],
      }),
    ).toMatchObject([{ outcome: "stale", pin: { note: "From the panel" } }]);
    expect((await readScientProjectPins(projectRoot))[0]?.note).toBe("From the panel");

    expect(
      await changeScientProjectPins({
        projectRoot,
        library,
        actor: "agent",
        changes: [
          {
            action: "pin",
            sourceId: record.sourceId,
            note: "Reconciled",
            noteBase: "From the panel",
          },
        ],
      }),
    ).toMatchObject([{ outcome: "existing", pin: { note: "Reconciled" } }]);
    const history = await readScientProjectPinNoteHistory({ projectRoot, citationKey: key });
    expect(history?.map(({ note, kind, by }) => [note, kind, by])).toEqual([
      ["Original", "edit", "user"],
      ["From the panel", "edit", "user"],
      ["Reconciled", "edit", "agent"],
    ]);

    expect(
      await setScientProjectPinNote({
        projectRoot,
        citationKey: key,
        note: history![0]!.note,
        base: "Reconciled",
        actor: "user",
      }),
    ).toMatchObject({ outcome: "updated", pin: { note: "Original" } });
    expect(notes(await readScientProjectPinNoteHistory({ projectRoot, citationKey: key }))).toEqual(
      ["Original", "From the panel", "Reconciled", "Original"],
    );
  });

  it("keeps the first note and the latest checkpoints, groups a session and records outside edits", async () => {
    const { library, projectRoot, add } = await setup();
    const record = await add("A");
    await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: record.sourceId,
      actor: "user",
    });
    const key = (await readScientProjectPins(projectRoot))[0]!.citationKey;
    // A pins.json from the move: the note was there before any history.
    const pinsPath = NodePath.join(projectRoot, ".scient", "library", "pins.json");
    const file = JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"));
    file.pins[0].note = "Moved in";
    await NodeFSP.writeFile(pinsPath, `${JSON.stringify(file, null, 2)}\n`);

    let base: string | null = "Moved in";
    for (const step of ["T", "Ty", "Typed"]) {
      await setScientProjectPinNote({
        projectRoot,
        citationKey: key,
        note: step,
        base,
        actor: "user",
        session: "editor-1",
      });
      base = step;
    }
    expect(notes(await readScientProjectPinNoteHistory({ projectRoot, citationKey: key }))).toEqual(
      ["Moved in", "Typed"],
    );

    for (let index = 0; index < SCIENT_PROJECT_NOTE_CHECKPOINTS + 5; index += 1) {
      const next = `Version ${index}`;
      await setScientProjectPinNote({
        projectRoot,
        citationKey: key,
        note: next,
        base,
        actor: "agent",
      });
      base = next;
    }
    // Edited by hand or by an older Scient: kept before the next write replaces it.
    const edited = JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"));
    edited.pins[0].note = "Edited in the file";
    await NodeFSP.writeFile(pinsPath, `${JSON.stringify(edited, null, 2)}\n`);
    await unpinScientLibrarySource({ projectRoot, citationKey: key, actor: "user" });
    await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: record.sourceId,
      actor: "user",
    });

    const history = await readScientProjectPinNoteHistory({ projectRoot, citationKey: key });
    expect(history?.[0]).toMatchObject({ note: "Moved in", kind: "original" });
    expect(history).toHaveLength(SCIENT_PROJECT_NOTE_CHECKPOINTS + 2);
    expect(history?.at(-2)).toMatchObject({ note: "Edited in the file", kind: "found" });
    // The new pin has no note; the history ends with that, so the old text stays restorable.
    expect(history?.at(-1)).toMatchObject({ note: null, kind: "found" });
  });

  it("waits for another process holding the project's pins lock, then sees its note", async () => {
    const { library, projectRoot, add } = await setup();
    const record = await add("A");
    const pinned = await pinScientLibrarySource({
      projectRoot,
      library,
      sourceId: record.sourceId,
      actor: "user",
      note: "Before",
    });
    const key = pinned.outcome === "pinned" ? pinned.pin.citationKey : "";
    const pinsModule = NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "projectPins.ts"));
    // Another server, with another Library, editing the same project folder.
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import * as NodeFSP from "node:fs/promises";
         import { withScientProjectPinsLock } from ${JSON.stringify(pinsModule.href)};
         const pinsPath = ${JSON.stringify(NodePath.join(projectRoot, ".scient", "library", "pins.json"))};
         await withScientProjectPinsLock(${JSON.stringify(projectRoot)}, async () => {
           process.stdout.write("held\\n");
           const file = JSON.parse(await NodeFSP.readFile(pinsPath, "utf8"));
           await new Promise((resolve) => process.stdin.once("data", resolve));
           file.pins[0].note = "From the other server";
           await NodeFSP.writeFile(pinsPath, JSON.stringify(file, null, 2) + "\\n");
         });`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    children.push(child);
    const said = (word: string) =>
      new Promise<void>((resolve, reject) => {
        child.once("exit", (code) => reject(new Error(`The other process exited (${code}).`)));
        child.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes(word)) resolve();
        });
      });
    await said("held");
    await expect(
      withScientProjectPinsLock(projectRoot, async () => "mine", { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(ScientLibraryBusyError);

    const mine = setScientProjectPinNote({
      projectRoot,
      citationKey: key,
      note: "From this server",
      base: "Before",
      actor: "user",
    });
    child.stdin?.write("go\n");
    expect(await mine).toMatchObject({ outcome: "stale", pin: { note: "From the other server" } });
    expect((await readScientProjectPins(projectRoot))[0]?.note).toBe("From the other server");
  });
});
