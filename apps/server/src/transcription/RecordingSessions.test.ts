// @effect-diagnostics nodeBuiltinImport:off - Exercise the production ledger against a disposable project.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import type { RecordingSessionPart } from "@t3tools/contracts";
import { makeRecordingSessions, recordingContentHash } from "./RecordingSessions.ts";

it("combines recordings atomically and keeps the cited transcript through reorder, split and Trash", async () => {
  const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sessions-"));
  try {
    const project = await NodeFSP.realpath(temporary);
    const root = NodePath.join(project, "Transcripts");
    await NodeFSP.mkdir(root);
    const sources = ["Monday.webm", "Tuesday.webm"].map((name) => NodePath.join(project, name));
    const ids = sources.map(() => NodeCrypto.randomUUID());
    const revision = "2026-11-27-Lesson-abcdef01";
    const transcript = NodePath.join(root, "fixture.json");
    const published = (text: string) =>
      JSON.stringify({ segments: [{ id: "a", start: 1, end: 4, text }] });
    await NodeFSP.writeFile(transcript, published("x = −2"));
    await Promise.all(sources.map((source) => NodeFSP.writeFile(source, "audio")));
    const context = {
      project,
      root,
      trashFiles: async (parts: readonly RecordingSessionPart[]) =>
        parts.map(({ source, mediaSource }) => mediaSource ?? source),
      recording: async (source: string) => {
        const index = sources.indexOf(source);
        if (index < 0) throw new Error("Unknown recording.");
        return {
          source,
          recordingId: ids[index]!,
          title: NodePath.basename(source),
          created: index,
          duration: 10,
          revision,
          contentHash: await recordingContentHash(source),
        };
      },
      revision: async () => transcript,
    };
    const execute = makeRecordingSessions();
    const { session: original } = await execute(context, { kind: "ensure", source: sources[0]! });
    const { session: renamed } = await execute(context, {
      kind: "edit",
      id: original!.id,
      version: original!.version,
      title: "The substitution",
    });
    const { session: combined } = await execute(context, {
      kind: "combine",
      selection: [{ source: sources[1]! }, { id: renamed!.id, version: renamed!.version }],
    });
    expect(combined?.parts.map(({ source }) => source)).toEqual(sources);
    const { snapshot } = await execute(context, {
      kind: "snapshot",
      id: combined!.id,
      version: combined!.version,
    });
    const { session: reordered } = await execute(context, {
      kind: "reorder",
      id: combined!.id,
      version: combined!.version,
      partId: combined!.parts[1]!.id,
      direction: "earlier",
    });
    await expect(
      execute(context, { kind: "split", id: combined!.id, version: combined!.version }),
    ).rejects.toThrow("This session changed");
    const { sessions } = await execute(context, {
      kind: "split",
      id: combined!.id,
      version: reordered!.version,
    });
    const singleton = sessions.find(({ id }) => id === original!.id)!;
    expect(singleton).toMatchObject({ title: "The substitution", archived: false });
    expect(sessions.filter(({ archived }) => !archived)).toHaveLength(2);

    await NodeFSP.writeFile(transcript, published("x = 2"));
    const readAfterRestart = makeRecordingSessions();
    const cited = await readAfterRestart(context, {
      kind: "read-snapshot",
      contextRevision: snapshot!.contextRevision,
    });
    expect(cited.snapshot?.parts.map(({ source }) => source)).toEqual(sources);
    expect(
      (
        await readAfterRestart(context, {
          kind: "snapshot-part",
          contextRevision: snapshot!.contextRevision,
          partId: snapshot!.parts[0]!.id,
        })
      ).segments,
    ).toEqual([{ id: "a", start: 1, end: 4, text: "x = −2" }]);

    const { session: trashed } = await execute(context, {
      kind: "trash",
      id: singleton.id,
      version: singleton.version,
    });
    await expect(NodeFSP.access(sources[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    await NodeFSP.writeFile(sources[0]!, "replacement");
    await expect(
      execute(context, { kind: "restore", id: singleton.id, version: trashed!.version }),
    ).rejects.toThrow("already occupies");
    await NodeFSP.unlink(sources[0]!);
    await execute(context, { kind: "restore", id: singleton.id, version: trashed!.version });
    expect(await NodeFSP.readFile(sources[0]!, "utf8")).toBe("audio");
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
});
