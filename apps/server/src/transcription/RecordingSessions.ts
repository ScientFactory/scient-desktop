// @effect-diagnostics nodeBuiltinImport:off - The session ledger uses the transcription service filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  RecordingSession,
  RecordingSessionSnapshot,
  type RecordingSessionCommand,
  type RecordingSessionPart,
  type RecordingSessionResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { atomicWrite, type Segment } from "./ledger.ts";

const TrashJournal = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)),
  direction: Schema.Literals(["trash", "restore"]),
  entries: Schema.Array(Schema.String),
});
const SessionIndex = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessions: Schema.Array(RecordingSession),
  pending: Schema.optionalKey(TrashJournal),
});
const decodeIndex = Schema.decodeUnknownSync(SessionIndex);
const decodeSnapshot = Schema.decodeUnknownSync(RecordingSessionSnapshot);
const decodeTrashEntries = Schema.decodeUnknownSync(Schema.Array(Schema.String));

export class InvalidSessionOperation extends Schema.TaggedError<InvalidSessionOperation>()(
  "InvalidSessionOperation",
  { message: Schema.String },
) {}
const invalidSession = (message: string) => new InvalidSessionOperation({ message });

interface SessionRecording {
  readonly source: string;
  readonly recordingId: string;
  readonly title: string;
  readonly created: number;
  readonly duration: number;
  readonly transcriptOnly?: boolean;
  readonly type?: RecordingSession["type"];
  readonly markers?: readonly number[];
  readonly contentHash?: string;
  readonly revision?: string;
}

interface SessionProject {
  readonly project: string;
  readonly root: string;
  readonly trashFiles: (
    parts: readonly RecordingSessionPart[],
    id: string,
  ) => Promise<readonly string[]>;
  readonly recording: (source: string) => Promise<SessionRecording>;
  readonly revision: (source: string, revision: string) => Promise<string>;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function sessionsDirectory(root: string, create: boolean) {
  const directory = NodePath.join(root, "sessions");
  if (create) {
    await NodeFSP.mkdir(root, { recursive: true });
    await NodeFSP.mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const stat = await NodeFSP.lstat(directory).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (stat && !stat.isDirectory()) throw invalidSession("Invalid sessions directory.");
  return directory;
}

function isWithin(root: string, target: string) {
  const relative = NodePath.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + NodePath.sep) &&
    !NodePath.isAbsolute(relative)
  );
}

export async function recordingContentHash(file: string) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function settleTrash(
  context: SessionProject,
  directory: string,
  journal: typeof TrashJournal.Type,
) {
  const bundle = NodePath.join(directory, `trash-${journal.id}`);
  const fromProject = (entry: string) => {
    const path = NodePath.resolve(context.project, entry);
    const ownedNotes = NodePath.join(directory, `notes-${journal.id}`);
    if (
      !isWithin(context.project, path) ||
      (isWithin(directory, path) && path !== ownedNotes) ||
      path === directory
    )
      throw invalidSession("Invalid session trash entry.");
    return path;
  };
  await NodeFSP.mkdir(bundle, { recursive: true });
  if (!(await NodeFSP.lstat(bundle)).isDirectory())
    throw invalidSession("Invalid session trash directory.");
  const manifest = NodePath.join(bundle, "files.json");
  if (journal.direction === "trash") await atomicWrite(manifest, JSON.stringify(journal.entries));

  for (const [index, entry] of journal.entries.entries()) {
    const original = fromProject(entry);
    const stashed = NodePath.join(bundle, String(index));
    const [from, to] = journal.direction === "trash" ? [original, stashed] : [stashed, original];
    const exists = (path: string) =>
      NodeFSP.lstat(path).then(
        () => true,
        (error: unknown) => {
          if (missing(error)) return false;
          throw error;
        },
      );
    if (!(await exists(from))) {
      if (await exists(to)) continue;
      throw invalidSession("A session file is missing. Check the project to recover it.");
    }
    if (await exists(to))
      throw invalidSession("A file already occupies the destination. Move it and try again.");
    const [fromParent, toParent] = await Promise.all([
      NodeFSP.realpath(NodePath.dirname(from)),
      NodeFSP.realpath(NodePath.dirname(to)),
    ]);
    if (fromParent !== NodePath.dirname(from) || toParent !== NodePath.dirname(to))
      throw invalidSession("A session file destination changed.");
    if ((await NodeFSP.lstat(from)).isSymbolicLink())
      throw invalidSession("A session file is a symbolic link.");
    await NodeFSP.rename(from, to);
  }
}

function newSession(recording: SessionRecording): RecordingSession {
  return {
    id: recording.recordingId,
    version: 1,
    timelineRevision: 1,
    title: recording.title,
    type: recording.type ?? "lecture",
    created: recording.created,
    parts: [
      {
        id: NodeCrypto.randomUUID(),
        recordingId: recording.recordingId,
        source: recording.source,
        duration: recording.duration,
        ...(recording.contentHash ? { contentHash: recording.contentHash } : {}),
        ...(recording.transcriptOnly ? { transcriptOnly: true } : {}),
        ...(recording.revision ? { revision: recording.revision } : {}),
      },
    ],
    material: [],
    markers: (recording.markers ?? []).map((time) => ({
      id: NodeCrypto.randomUUID(),
      recordingId: recording.recordingId,
      time: Math.min(time, recording.duration),
    })),
  };
}

function compareSession(sessions: RecordingSession[], id: string, version: number) {
  const session = sessions.find((entry) => entry.id === id);
  if (!session || session.archived) throw invalidSession("This session is no longer available.");
  if (session.version !== version)
    throw invalidSession("This session changed. Refresh and try again.");
  return session;
}

export function makeRecordingSessions() {
  const tails = new Map<string, Promise<unknown>>();

  async function execute(
    context: SessionProject,
    command: RecordingSessionCommand,
  ): Promise<RecordingSessionResult> {
    const directory = await sessionsDirectory(
      context.root,
      command.kind !== "list" &&
        command.kind !== "read-snapshot" &&
        command.kind !== "snapshot-part",
    );
    const index = NodePath.join(directory, "index.json");
    const stored = await NodeFSP.readFile(index, "utf8").then(
      (text) => decodeIndex(JSON.parse(text)),
      (error: unknown) => {
        if (missing(error)) return undefined;
        throw error;
      },
    );
    const sessions = [...(stored?.sessions ?? [])];
    if (command.kind === "read-snapshot" || command.kind === "snapshot-part") {
      const snapshotFile = NodePath.join(directory, command.contextRevision, "context.json");
      if (
        !(await NodeFSP.lstat(NodePath.dirname(snapshotFile))).isDirectory() ||
        !(await NodeFSP.lstat(snapshotFile)).isFile()
      )
        throw invalidSession("This session snapshot is unavailable.");
      const snapshot = decodeSnapshot(JSON.parse(await NodeFSP.readFile(snapshotFile, "utf8")));
      if (snapshot.contextRevision !== command.contextRevision)
        throw invalidSession("Invalid session snapshot.");
      if (command.kind === "snapshot-part") {
        if (!snapshot.parts.some(({ id }) => id === command.partId))
          throw invalidSession("This recording is not in the snapshot.");
        const transcript = NodePath.join(NodePath.dirname(snapshotFile), `${command.partId}.json`);
        if (!(await NodeFSP.lstat(transcript)).isFile())
          throw invalidSession("This transcript is unavailable.");
        const { segments } = JSON.parse(await NodeFSP.readFile(transcript, "utf8")) as {
          segments: Segment[];
        };
        return {
          sessions,
          segments: segments.map(({ id, start, end, text }) => ({ id, start, end, text })),
        };
      }
      return {
        sessions,
        snapshot: {
          ...snapshot,
          parts: snapshot.parts.map((part) => {
            const source = NodePath.resolve(context.project, part.source);
            const relocated = sessions
              .filter(({ archived }) => !archived)
              .flatMap(({ parts }) => parts)
              .find(({ recordingId }) => recordingId === part.recordingId)?.mediaSource;
            const mediaSource =
              relocated ??
              (part.mediaSource ? NodePath.resolve(context.project, part.mediaSource) : undefined);
            if (
              !isWithin(context.project, source) ||
              (mediaSource && !isWithin(context.project, mediaSource))
            )
              throw invalidSession("Invalid session recording path.");
            return { ...part, source, ...(mediaSource ? { mediaSource } : {}) };
          }),
          path: `Transcripts/sessions/${command.contextRevision}/context.json`,
        },
      };
    }
    const flush = (pending?: typeof TrashJournal.Type) =>
      atomicWrite(index, JSON.stringify({ schemaVersion: 1, sessions, pending }));
    if (command.kind === "list" && !stored?.pending) return { sessions };
    if (stored?.pending) {
      await settleTrash(context, directory, stored.pending);
      await flush();
    }
    if (command.kind === "list") return { sessions };
    function save(session: RecordingSession) {
      const position = sessions.findIndex(({ id }) => id === session.id);
      if (position === -1) sessions.push(session);
      else sessions[position] = session;
      return session;
    }
    const findOwner = (source: string) =>
      sessions.find(
        (session) =>
          !session.archived &&
          session.parts.some((part) => part.source === source || part.mediaSource === source),
      );
    async function ensure(source: string) {
      const owner = findOwner(source);
      if (owner) {
        if (owner.trashed) throw invalidSession("Restore the session first.");
        return owner;
      }
      const recording = await context.recording(source);
      const canonicalOwner = findOwner(recording.source);
      if (canonicalOwner?.trashed) throw invalidSession("Restore the session first.");
      return canonicalOwner ?? save(newSession(recording));
    }
    if (command.kind === "ensure") {
      const session = await ensure(command.source);
      await flush();
      return { sessions, session };
    }

    if (command.kind === "combine") {
      const selected: RecordingSession[] = [];
      for (const entry of command.selection) {
        const session =
          "source" in entry
            ? await ensure(entry.source)
            : compareSession(sessions, entry.id, entry.version);
        if (session.trashed || selected.some(({ id }) => id === session.id))
          throw invalidSession("Select different sessions in this project.");
        selected.push(session);
      }
      selected.sort((left, right) => left.created - right.created);
      const first = selected[0]!;
      const parts: RecordingSessionPart[] = [];
      for (const session of selected) {
        for (const part of session.parts) {
          const recording = part.mediaSource ? undefined : await context.recording(part.source);
          const duration = recording?.duration ?? part.duration;
          if ((recording?.transcriptOnly ?? part.transcriptOnly) || duration <= 0)
            throw invalidSession("Each recording needs a known duration to combine.");
          if (parts.some(({ recordingId }) => recordingId === part.recordingId))
            throw invalidSession("A recording can only appear once in a session.");
          parts.push({
            ...part,
            duration,
            ...(part.revision || !recording?.revision ? {} : { revision: recording.revision }),
            previousSessionId: session.id,
          });
        }
      }
      for (const session of selected)
        save({ ...session, archived: true, version: session.version + 1 });
      const session = save({
        id: NodeCrypto.randomUUID(),
        version: 1,
        timelineRevision: 1,
        title: first.title,
        type: first.type,
        created: first.created,
        parts,
        material: [
          ...new Map(
            selected.flatMap(({ material }) => material).map((item) => [item.id, item]),
          ).values(),
        ],
        markers: selected.flatMap(({ markers }) => markers),
      });
      await flush();
      return { sessions, session };
    }

    const current = compareSession(sessions, command.id, command.version);
    if (current.trashed && command.kind !== "restore")
      throw invalidSession("Restore the session first.");
    if (command.kind === "snapshot") {
      const contextRevision = NodeCrypto.randomUUID();
      const relative = `Transcripts/sessions/${contextRevision}`;
      const snapshotDirectory = NodePath.join(directory, contextRevision);
      await NodeFSP.mkdir(snapshotDirectory);
      try {
        const parts: RecordingSessionPart[] = [];
        const evidence: object[] = [];
        for (const part of current.parts) {
          const recording = part.revision ? undefined : await context.recording(part.source);
          const revision = part.revision ?? recording?.revision;
          if (!revision)
            throw invalidSession("Transcribe each part before asking about the session.");
          const filename = `${part.id}.json`;
          const source = await context.revision(part.source, revision);
          await NodeFSP.copyFile(source, NodePath.join(snapshotDirectory, filename));
          parts.push({ ...part, revision });
          evidence.push({
            recordingId: part.recordingId,
            revision,
            path: `${relative}/${filename}`,
          });
        }
        const notes: string[] = [];
        const notesDirectory = NodePath.join(directory, `notes-${current.id}`);
        const originalNotes = await NodeFSP.lstat(notesDirectory).catch((error: unknown) => {
          if (!missing(error)) throw error;
        });
        if (originalNotes?.isDirectory()) {
          const latest = (await NodeFSP.readdir(notesDirectory, { withFileTypes: true })).filter(
            (entry) => entry.isFile() && /^notes-[a-f0-9-]{36}\.md$/.test(entry.name),
          );
          const candidates = await Promise.all(
            latest.map(async ({ name }) => ({
              name,
              time: (await NodeFSP.lstat(NodePath.join(notesDirectory, name))).mtimeMs,
            })),
          );
          candidates.sort((a, b) => b.time - a.time);
          if (candidates[0]) {
            const source = NodePath.join(notesDirectory, candidates[0].name);
            if ((await NodeFSP.lstat(source)).isFile()) {
              await NodeFSP.copyFile(source, NodePath.join(snapshotDirectory, "notes.md"));
              notes.push(`${relative}/notes.md`);
            }
          }
        }
        const snapshot = {
          sessionId: current.id,
          contextRevision,
          timelineRevision: current.timelineRevision,
          title: current.title,
          type: current.type,
          parts,
          material: current.material.filter(({ included }) => included),
          markers: current.markers,
          path: `${relative}/context.json`,
        };
        await atomicWrite(
          NodePath.join(snapshotDirectory, "context.json"),
          JSON.stringify({
            ...snapshot,
            parts: parts.map(({ source, mediaSource, contentHash: _hash, ...part }) => ({
              ...part,
              source: NodePath.relative(context.project, source).split(NodePath.sep).join("/"),
              ...(mediaSource
                ? {
                    mediaSource: NodePath.relative(context.project, mediaSource)
                      .split(NodePath.sep)
                      .join("/"),
                  }
                : {}),
            })),
            evidence,
            notes,
          }),
        );
        return { sessions, session: current, snapshot };
      } catch (error) {
        await NodeFSP.rm(snapshotDirectory, { recursive: true, force: true });
        throw error;
      }
    }

    if (command.kind === "trash" || command.kind === "restore") {
      if (command.kind === "restore" && !current.trashed)
        throw invalidSession("This session is already in the project.");
      const bundle = NodePath.join(directory, `trash-${current.id}`);
      const entries =
        command.kind === "trash"
          ? (await context.trashFiles(current.parts, current.id)).map((source) =>
              NodePath.relative(context.project, source),
            )
          : decodeTrashEntries(
              JSON.parse(await NodeFSP.readFile(NodePath.join(bundle, "files.json"), "utf8")),
            );
      if (command.kind === "restore") {
        for (const entry of entries) {
          try {
            await NodeFSP.lstat(NodePath.resolve(context.project, entry));
            throw invalidSession("A file already occupies the destination.");
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
      }
      const session = save({
        ...current,
        trashed: command.kind === "trash",
        version: current.version + 1,
      });
      const pending = { id: current.id, direction: command.kind, entries };
      await flush(pending);
      await settleTrash(context, directory, pending);
      await flush();
      return { sessions, session };
    }

    let next: RecordingSession = { ...current, version: current.version + 1 };
    switch (command.kind) {
      case "edit":
        next = {
          ...next,
          title: command.title?.trim() || current.title,
          type: command.type ?? current.type,
        };
        break;
      case "reorder": {
        const parts = [...current.parts];
        const position = parts.findIndex(({ id }) => id === command.partId);
        const target = position + (command.direction === "earlier" ? -1 : 1);
        if (position < 0 || target < 0 || target >= parts.length)
          throw invalidSession("This part cannot move there.");
        [parts[position], parts[target]] = [parts[target]!, parts[position]!];
        next = { ...next, parts, timelineRevision: current.timelineRevision + 1 };
        break;
      }
      case "locate": {
        const part = current.parts.find(({ id }) => id === command.partId);
        if (!part || !part.contentHash)
          throw invalidSession("This recording has no saved file identity.");
        const path = await NodeFSP.realpath(NodePath.resolve(context.project, command.source));
        if (!isWithin(context.project, path) || !(await NodeFSP.stat(path)).isFile())
          throw invalidSession("Select a file in this project.");
        const owner = findOwner(path);
        if (
          owner &&
          (owner.id !== current.id ||
            owner.parts.some(
              (other) =>
                other.id !== part.id && (other.source === path || other.mediaSource === path),
            ))
        )
          throw invalidSession("This file is already in a session.");
        if ((await recordingContentHash(path)) !== part.contentHash)
          throw invalidSession("The selected file does not match this recording.");
        next = {
          ...next,
          parts: current.parts.map((entry) =>
            entry.id === part.id ? { ...entry, mediaSource: path } : entry,
          ),
        };
        break;
      }
      case "select-revision": {
        const part = current.parts.find(({ id }) => id === command.partId);
        if (!part) throw invalidSession("The recording is no longer in this session.");
        await context.revision(part.source, command.revision);
        next = {
          ...next,
          parts: current.parts.map((entry) =>
            entry.id === part.id ? { ...entry, revision: command.revision } : entry,
          ),
        };
        break;
      }
      case "mark": {
        const part = current.parts.find(({ recordingId }) => recordingId === command.recordingId);
        if (!part || command.time > part.duration)
          throw invalidSession("The marker must be inside this recording.");
        next = {
          ...next,
          markers: [
            ...current.markers,
            { id: NodeCrypto.randomUUID(), recordingId: part.recordingId, time: command.time },
          ],
        };
        break;
      }
      case "set-material": {
        const previous = new Map(current.material.map((item) => [item.id, item]));
        const ids = new Set<string>();
        for (const item of command.material) {
          if (ids.has(item.id) || !item.name.trim())
            throw invalidSession("Material links need distinct IDs and names.");
          ids.add(item.id);
          if (item.moment) {
            const part = current.parts.find(
              ({ recordingId }) => recordingId === item.moment?.recordingId,
            );
            if (!part || item.moment.time > part.duration)
              throw invalidSession("The link must point to a moment in this session.");
          }
          if (item.source !== "project") continue;
          const target = NodePath.resolve(context.project, item.reference);
          if (NodePath.isAbsolute(item.reference) || !isWithin(context.project, target))
            throw invalidSession("Material must live inside this project.");
          const existing = previous.get(item.id);
          if (existing?.reference === item.reference && existing.source === item.source) continue;
          const file = await NodeFSP.realpath(target);
          if (!isWithin(context.project, file) || !(await NodeFSP.stat(file)).isFile())
            throw invalidSession("Select a project file.");
        }
        next = { ...next, material: command.material };
        break;
      }
      case "split":
      case "remove-part": {
        if (current.parts.length < 2) throw invalidSession("This session has only one recording.");
        const detached =
          command.kind === "split"
            ? current.parts
            : current.parts.filter(({ id }) => id === command.partId);
        if (detached.length === 0)
          throw invalidSession("The recording is no longer in this session.");
        const restored = new Set<string>();
        for (const part of detached) {
          const previous = sessions.find(({ id }) => id === part.previousSessionId);
          if (
            previous?.archived &&
            !restored.has(previous.id) &&
            previous.parts.every((entry) =>
              detached.some(({ recordingId }) => recordingId === entry.recordingId),
            )
          ) {
            const previousParts = previous.parts.map((entry) => {
              const latest = detached.find(({ recordingId }) => recordingId === entry.recordingId);
              return latest?.mediaSource ? { ...entry, mediaSource: latest.mediaSource } : entry;
            });
            const markers = current.markers.filter(({ recordingId }) =>
              previousParts.some((entry) => entry.recordingId === recordingId),
            );
            save({
              ...previous,
              parts: previousParts,
              markers,
              archived: false,
              version: previous.version + 1,
            });
            restored.add(previous.id);
          } else if (!previous || !restored.has(previous.id)) {
            const original = sessions.find(({ id }) => id === part.recordingId);
            const { previousSessionId: _previousSessionId, ...rest } = part;
            save({
              id: part.recordingId,
              version: (original?.version ?? 0) + 1,
              timelineRevision: (original?.timelineRevision ?? 0) + 1,
              title: original?.title ?? NodePath.basename(part.source),
              type: original?.type ?? current.type,
              created: original?.created ?? current.created,
              parts: [rest],
              material: original?.material ?? [],
              markers: current.markers.filter(
                ({ recordingId }) => recordingId === part.recordingId,
              ),
            });
          }
        }
        if (command.kind === "split") next = { ...next, archived: true };
        else {
          const parts = current.parts.filter(({ id }) => id !== command.partId);
          const contains = (recordingId: string) =>
            parts.some((part) => part.recordingId === recordingId);
          next = {
            ...next,
            parts,
            material: current.material.filter(
              ({ moment }) => !moment || contains(moment.recordingId),
            ),
            markers: current.markers.filter(({ recordingId }) => contains(recordingId)),
            timelineRevision: current.timelineRevision + 1,
          };
        }
        break;
      }
    }
    save(next);
    await flush();
    return { sessions, session: next };
  }

  return (context: SessionProject, command: RecordingSessionCommand) => {
    const previous = tails.get(context.root) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => execute(context, command));
    tails.set(context.root, task);
    const clear = () => {
      if (tails.get(context.root) === task) tails.delete(context.root);
    };
    void task.then(clear, clear);
    return task;
  };
}
