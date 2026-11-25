import { ServerSettings as ServerSettingsSchema } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
// @effect-diagnostics nodeBuiltinImport:off - The test verifies real project directory side effects.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerSettings as Settings,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ProjectStoreV2, type ProjectRow } from "../orchestration-v2/ProjectStore.ts";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as Cloud from "./CloudEngines.ts";
import * as Models from "../speech/SpeechModelStore.ts";
import * as Speech from "../speech/SpeechService.ts";
import * as ChatGpt from "./chatgpt.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as Jobs from "./TranscriptionJobs.ts";
import { runMediaTool } from "./subtitleMedia.ts";

vi.mock("./media.ts", async (load) => ({
  ...(await load<typeof import("./media.ts")>()),
  probeRecordingDuration: vi.fn(async (_ffmpeg: string, source: string) =>
    source.endsWith("legacy-duration.wav") ? 5400 : undefined,
  ),
}));

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettingsSchema);
const isStartRequest = Schema.is(Jobs.StartRequest);

const large = "handy-computer/whisper-large-v3-gguf";
const arabic = "handy-computer/cohere-transcribe-arabic-07-2026-gguf";
const ivrit = "vladkens/ivrit-whisper-large-v3-turbo-gguf";
const fast = "handy-computer/parakeet-tdt-0.6b-v3-gguf";
const projectRow = (workspaceRoot: string) =>
  ({
    projectId: ProjectId.make("registered-project"),
    title: "Registered Project",
    workspaceRoot,
    hasCustomTitle: false,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    trackedFolders: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-11-22T00:00:00Z",
    updatedAt: "2026-11-22T00:00:00Z",
    deletedAt: null,
  }) satisfies ProjectRow;
const layerFor = (
  installed?: ReadonlySet<string>,
  cloudEnabled = false,
  projectSettingsOverrides: unknown = {},
  transcriptionWords: Settings["transcriptionWords"] = [],
  projectRoot?: string,
  readSettings?: () => Settings,
  writeSettings?: ServerSettings.ServerSettingsService["Service"]["updateSettings"],
  cloudBinding?: Cloud.CloudEngines["Service"]["resolve"],
) =>
  Jobs.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(TextGeneration)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({
          ...(writeSettings ? { updateSettings: writeSettings } : {}),
          getSettings: Effect.sync(
            () =>
              readSettings?.() ?? {
                ...DEFAULT_SERVER_SETTINGS,
                transcription: { agentsMayUseCloudEngines: cloudEnabled },
                projectSettingsOverrides: decodeServerSettings({ projectSettingsOverrides })
                  .projectSettingsOverrides,
                transcriptionWords,
              },
          ),
        }),
        Layer.mock(ProjectStoreV2)({
          findActiveByWorkspaceRoot: (workspaceRoot) =>
            Effect.succeedSome(projectRow(workspaceRoot)),
          get: () =>
            projectRoot === undefined
              ? Effect.succeedNone
              : Effect.succeedSome(projectRow(projectRoot)),
        }),
        Layer.succeed(HostProcess.Platform, "freebsd"),
        Layer.mock(Cloud.CloudEngines)({
          execute: () => Effect.succeed([]),
          realtimeKey: () => Effect.undefined,
          resolve:
            cloudBinding ??
            (() =>
              Effect.fail(
                new Cloud.CloudEngineError({
                  code: "consent-required",
                  detail: "Allow audio uploads for this cloud engine first.",
                }),
              )),
        }),
        Layer.mock(Models.SpeechModelStore)({
          isReady: (model) => Effect.succeed(installed?.has(model.id) ?? false),
          installedPath: () => Effect.succeed(import.meta.filename),
        }),
        Layer.mock(Speech.SpeechService)({
          openRecordingVad: (signal) =>
            new Promise((_, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          withRecordingWindow: async () => {
            throw new Error("not used");
          },
          status: Effect.succeed({ supported: installed !== undefined } as never),
        }),
        Layer.mock(ChatGpt.ChatGptEngineServices)({ resolve: () => Effect.undefined }),
      ),
    ),
  );

const layer = layerFor();

it.effect("leaves empty projects untouched and isolates corrupt revisions from valid jobs", () =>
  Effect.gen(function* () {
    const project = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "transcription-service-")).then(
          (directory) => NodeFSP.realpath(directory, "utf8"),
        ),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const jobs = yield* Jobs.TranscriptionJobs;
    const id = "2026-11-22-sample-12345678";
    expect(yield* jobs.execute({ action: "list", project })).toEqual([]);
    const missing = yield* jobs.execute({ action: "cancel", project, id }).pipe(Effect.result);
    expect(missing._tag === "Failure" && missing.failure.code).toBe("not-found");
    expect(yield* Effect.promise(() => NodeFSP.readdir(project))).toEqual([]);

    yield* Effect.promise(async () => {
      const good = NodePath.join(project, "Transcripts", id);
      const bad = NodePath.join(project, "Transcripts", "2026-11-22-corrupt-12345678");
      await NodeFSP.mkdir(good, { recursive: true });
      await NodeFSP.mkdir(bad);
      await NodeFSP.writeFile(NodePath.join(good, "job.json"), JSON.stringify({ id }));
      await NodeFSP.writeFile(NodePath.join(good, "results.jsonl"), '{"windowId":0}\n{"partial"');
      await NodeFSP.writeFile(NodePath.join(bad, "job.json"), "{");
    });
    expect(yield* jobs.execute({ action: "list", project })).toEqual([
      { job: { id }, state: { stage: "interrupted", completed: 1 } },
    ]);
    expect(yield* jobs.execute({ action: "list", project, includeCreated: true })).toEqual([
      { job: { id }, state: { stage: "interrupted", completed: 1 }, created: expect.any(Number) },
    ]);
    const revisionPath = NodePath.join(project, "Transcripts", id);
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(
        NodePath.join(revisionPath, "state.json"),
        JSON.stringify({ stage: "completed", completed: 1 }),
      );
      await NodeFSP.writeFile(
        NodePath.join(revisionPath, "transcript.json"),
        JSON.stringify({ segments: [{ text: "A longer lesson about quantum coherence." }] }),
      );
    });
    expect(
      yield* jobs.execute({ action: "list", project, includeCreated: true, query: "QUANTUM" }),
    ).toMatchObject([{ job: { id }, snippet: "A longer lesson about quantum coherence." }]);
    const recording = NodePath.join(project, "added.wav");
    yield* Effect.promise(() => NodeFSP.writeFile(recording, "media"));
    yield* jobs.execute({ action: "media-register", project, source: recording });
    expect(yield* jobs.execute({ action: "media-list", project })).toEqual({
      media: [{ source: recording, size: 5, created: expect.any(Number), queued: false }],
    });
    const legacy = NodePath.join(project, "legacy-duration.wav");
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(legacy, "synthetic audio");
      await NodeFSP.writeFile(
        NodePath.join(project, "Transcripts", `recording-${"a".repeat(64)}.json`),
        JSON.stringify({ source: legacy, size: 15, created: 42 }),
      );
      await NodeFSP.writeFile(
        NodePath.join(revisionPath, "job.json"),
        JSON.stringify({
          id,
          source: legacy,
          settings: { engine: "local", model: large },
        }),
      );
    });
    expect(yield* jobs.execute({ action: "media-list", project })).toMatchObject({
      media: expect.arrayContaining([
        { source: legacy, size: 15, created: 42, duration: 5400, queued: false },
      ]),
    });
    expect(yield* jobs.execute({ action: "list", project, includeCreated: true })).toMatchObject([
      { duration: 5400, modelName: expect.stringMatching(/Whisper.*Large.*v3/i) },
    ]);
    const other = NodePath.join(project, "other");
    yield* Effect.promise(() => NodeFSP.mkdir(other));
    expect(yield* jobs.execute({ action: "list", project: other }, { scoped: true })).toEqual([]);
    for (const action of ["status", "cancel"] as const) {
      const crossProject = yield* jobs
        .execute({ action, project: other, id }, { scoped: true })
        .pipe(Effect.result);
      expect(crossProject._tag === "Failure" && crossProject.failure.code).toBe("not-found");
    }
    const link = NodePath.join(other, "audio.wav");
    const outside = NodePath.join(project, "outside.wav");
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(outside, "synthetic");
      await NodeFSP.symlink(outside, link);
    });
    const escaped = yield* jobs
      .startScoped(other, { source: "audio.wav", engine: "local", model: large }, 0)
      .pipe(Effect.result);
    expect(escaped._tag === "Failure" && escaped.failure.detail).toBe(
      "The audio file must resolve inside this project.",
    );
    expect(yield* Effect.promise(() => NodeFSP.readdir(other))).toEqual(["audio.wav"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("lists project media that was never added and finds a file's transcripts by path", () =>
  Effect.gen(function* () {
    const project = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "transcription-discovery-")).then(
          (directory) => NodeFSP.realpath(directory, "utf8"),
        ),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const jobs = yield* Jobs.TranscriptionJobs;
    const downloaded = NodePath.join(project, "Downloads", "lecture.mp4");
    const transcribed = NodePath.join(project, "interview.m4a");
    const id = "2026-11-25-interview-12345678";
    yield* Effect.promise(async () => {
      for (const folder of ["Downloads", ".hidden", "node_modules/pkg", `Transcripts/${id}`])
        await NodeFSP.mkdir(NodePath.join(project, folder), { recursive: true });
      await NodeFSP.writeFile(downloaded, "video");
      await NodeFSP.writeFile(transcribed, "audio");
      await NodeFSP.writeFile(NodePath.join(project, "notes.txt"), "text");
      await NodeFSP.writeFile(NodePath.join(project, ".hidden", "skip.mp3"), "audio");
      await NodeFSP.writeFile(NodePath.join(project, "node_modules/pkg", "skip.wav"), "audio");
      await NodeFSP.writeFile(NodePath.join(project, "Transcripts", "skip.webm"), "audio");
      await NodeFSP.writeFile(
        NodePath.join(project, "Transcripts", id, "job.json"),
        JSON.stringify({ id, source: transcribed, settings: { engine: "local", model: large } }),
      );
      await NodeFSP.writeFile(
        NodePath.join(project, "Transcripts", id, "state.json"),
        JSON.stringify({ stage: "completed", completed: 1 }),
      );
    });
    yield* jobs.execute({ action: "media-register", project, source: transcribed });
    const listed = yield* jobs.execute({ action: "media-list", project });
    expect(listed).toEqual({
      media: expect.arrayContaining([
        { source: downloaded, size: 5, created: expect.any(Number), queued: false },
        expect.objectContaining({ source: transcribed }),
      ]),
    });
    expect(listed).toHaveProperty("media.length", 2);
    expect(
      yield* jobs.execute({ action: "list", project, includeCreated: true, source: transcribed }),
    ).toMatchObject([{ job: { id } }]);
    for (const source of [downloaded, NodePath.join(project, "deleted.mp3")])
      expect(yield* jobs.execute({ action: "list", project, source })).toEqual([]);
    const alias = `${project}-alias`;
    yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.symlink(project, alias)),
      () => Effect.promise(() => NodeFSP.rm(alias, { force: true })),
    );
    const placed = (source: string) =>
      jobs.execute({ action: "media-register", project: alias, source, onlyInProject: true });
    expect(yield* placed(NodePath.join(alias, "Downloads", "lecture.mp4"))).toMatchObject({
      media: [{ source: downloaded }],
    });
    expect(yield* placed(NodePath.join(NodePath.dirname(project), "elsewhere.mp4"))).toEqual({
      media: [],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects concurrent starts, completes cancel, and creates a new revision after a source change",
  () => {
    const expireWait = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const project = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "transcription-service-")).then(
            (directory) => NodeFSP.realpath(directory, "utf8"),
          ),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const source = NodePath.join(project, "שָׁלוֹם.wav");
      const model = NodePath.join(project, "synthetic.gguf");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(source, "initial");
        await NodeFSP.writeFile(model, "synthetic model");
      });
      const jobs = yield* Jobs.TranscriptionJobs;
      const input = {
        action: "start",
        project,
        source,
        model,
        engine: "local",
        language: "he",
      } as const;
      const first = yield* jobs.execute(input);
      if (!("job" in first)) throw new Error("Expected one job.");
      expect(first.job.id).toContain("שָׁלוֹם");
      const busy = yield* jobs.execute(input).pipe(Effect.result);
      expect(busy._tag === "Failure" && busy.failure.code).toBe("busy");
      const statusRequest = { action: "status", project, id: first.job.id } as const;
      const immediate = yield* jobs.execute(statusRequest, { waitSeconds: 0 });
      if (!("job" in immediate)) throw new Error("Expected one job.");
      expect(immediate.state.stage).toBe("decoding");
      expect(yield* jobs.execute({ ...statusRequest, action: "revision" })).toEqual({
        segments: [],
      });
      expect(yield* jobs.execute(statusRequest, { waitSeconds: 1 })).toEqual(immediate);
      expect(expireWait).toHaveBeenCalledOnce();
      const waiting = yield* jobs
        .execute(statusRequest, { waitSeconds: 30 })
        .pipe(Effect.forkChild);
      const paused = yield* jobs.execute({ action: "pause", project, id: first.job.id });
      expect(yield* Fiber.join(waiting)).toEqual(paused);
      if (!("job" in paused)) throw new Error("Expected one job.");
      expect(paused.state.stage).toBe("interrupted");
      yield* Effect.promise(() => NodeFSP.writeFile(source, "changed source length"));
      const second = yield* jobs.execute({ ...input, resume: first.job.id });
      if (!("job" in second)) throw new Error("Expected one job.");
      expect(second.job.id).not.toBe(first.job.id);
      expect(second.job.previousRevision).toBe(first.job.id);
      const canceled = yield* jobs.execute({ action: "cancel", project, id: second.job.id });
      expect(canceled).toMatchObject({ state: { stage: "canceled" } });
    }).pipe(
      Effect.provide(layer),
      Effect.updateService(Clock.Clock, (clock) => ({
        ...clock,
        sleep: (duration) =>
          Duration.toMillis(duration) === 1_000 ? expireWait() : clock.sleep(duration),
      })),
    );
  },
);

const trashHome = NodePath.join(NodeOS.tmpdir(), `recordings-trash-${process.pid}`);
it.effect("renames a recording and moves it with its transcripts to the Trash", () =>
  Effect.gen(function* () {
    const project = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "transcription-manage-")).then((directory) =>
          NodeFSP.realpath(directory, "utf8"),
        ),
      ),
      (directory) =>
        Effect.promise(async () => {
          await NodeFSP.rm(directory, { recursive: true, force: true });
          await NodeFSP.rm(trashHome, { recursive: true, force: true });
        }),
    );
    const jobs = yield* Jobs.TranscriptionJobs;
    const recording = NodePath.join(project, "lecture.wav");
    const id = "2026-11-26-lecture-12345678";
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(recording, "audio");
      await NodeFSP.mkdir(NodePath.join(project, "Transcripts", id), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(project, "Transcripts", id, "job.json"),
        JSON.stringify({ id, source: recording }),
      );
    });
    const named = () =>
      jobs
        .execute({ action: "media-list", project })
        .pipe(Effect.map((result) => (result as { media: { title?: string }[] }).media[0]?.title));
    yield* jobs.execute({ action: "media-register", project, source: recording });
    yield* jobs.execute({
      action: "recording-rename",
      project,
      source: recording,
      title: " Week 3 ",
    });
    expect(yield* named()).toBe("Week 3");
    yield* jobs.execute({ action: "media-register", project, source: recording });
    expect(yield* named()).toBe("Week 3");
    yield* jobs.execute({ action: "recording-rename", project, source: recording, title: "" });
    expect(yield* named()).toBeUndefined();

    yield* jobs.execute({ action: "recording-trash", project, source: recording });
    expect(yield* Effect.promise(() => NodeFSP.readdir(project))).toEqual(["Transcripts"]);
    expect(
      yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(project, "Transcripts"))),
    ).toEqual([]);
    expect(
      (yield* Effect.promise(() =>
        NodeFSP.readdir(NodePath.join(trashHome, "Trash", "files")),
      )).sort(),
    ).toEqual([id, "lecture.wav"]);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(Layer.succeed(HostProcess.Environment, { XDG_DATA_HOME: trashHome })),
      ),
    ),
  ),
);

it.effect("engine inventory exposes available engine configurations", () =>
  Effect.gen(function* () {
    expect(yield* (yield* Jobs.TranscriptionJobs).engines("/project", {})).toEqual({
      local: [],
      mediaAvailable: true,
      chatgpt: { enabled: false, signedIn: false, model: "chatgpt" },
      agentsMayUseCloudEngines: false,
      cloud: [],
      recommendations: {},
    });
  }).pipe(Effect.provide(layer)),
);

it("rejects unknown engines at the request boundary", () => {
  expect(
    isStartRequest({
      action: "start",
      project: "/project",
      source: "audio.wav",
      engine: "unknown",
      model: "model",
      language: "en",
    }),
  ).toBe(false);
});

it.effect("creates a new correction revision and preserves the completed parent", () =>
  Effect.gen(function* () {
    const project = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "correction-service-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const id = "2026-11-22-sample-12345678";
    const directory = NodePath.join(project, "Transcripts", id);
    const transcript = JSON.stringify({
      segments: [
        { id: "0-0", start: 0, end: 1, text: "One  two.", textRaw: " One  two.", confidence: 0.4 },
        { id: "0-1", start: 1, end: 2, text: "End.", textRaw: "End." },
      ],
      reviewItems: [
        { segmentId: "0-0", before: "One  two.", after: "One  three.", reason: "Number change" },
        { segmentId: "0-1", before: "End.", after: "End?", reason: "Punctuation change" },
      ],
    });
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(directory, "job.json"),
        JSON.stringify({
          id,
          source: "/sample.wav",
          settings: { engine: "openai", language: "en" },
        }),
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "state.json"),
        JSON.stringify({ stage: "completed", completed: 1 }),
      );
      await NodeFSP.writeFile(NodePath.join(directory, "transcript.json"), transcript);
    });
    const service = yield* Jobs.TranscriptionJobs;
    const stale = yield* service
      .execute({ action: "correct", project, id, mode: "quick", estimateId: "a".repeat(64) })
      .pipe(Effect.result);
    expect(stale._tag === "Failure" && stale.failure.code).toBe("invalid-input");
    const missingEstimate = yield* service
      .execute({ action: "correct", project, id, mode: "thorough" })
      .pipe(Effect.result);
    expect(
      missingEstimate._tag === "Failure" && missingEstimate.failure.detail.includes("estimate ID"),
    ).toBe(true);
    const disabledModel = yield* service
      .execute({
        action: "correction-estimate",
        project,
        id,
        mode: "thorough",
        correctionModel: { instanceId: ProviderInstanceId.make("unconfigured"), model: "unknown" },
      })
      .pipe(Effect.result);
    expect(disabledModel).toMatchObject({ _tag: "Failure", failure: { code: "invalid-input" } });
    const preview = yield* service.execute({
      action: "correction-estimate",
      project,
      id,
      mode: "thorough",
    });
    if (!("estimateId" in preview) || typeof preview.estimateId !== "string")
      throw new Error("Expected an estimate ID.");
    const result = yield* service.execute({
      action: "correct",
      project,
      id,
      mode: "thorough",
      estimateId: preview.estimateId,
    });
    if (Array.isArray(result) || !("job" in result)) throw new Error("Expected a revision.");
    expect(result.job.previousRevision).toBe(id);
    const revisedPath = NodePath.join(project, "Transcripts", result.job.id, "transcript.json");
    yield* Effect.promise(() =>
      expect
        .poll(async () => {
          const text = await NodeFSP.readFile(revisedPath, "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return "{}";
              throw error;
            },
          );
          const state = await NodeFSP.readFile(
            NodePath.join(NodePath.dirname(revisedPath), "state.json"),
            "utf8",
          );
          return { ...JSON.parse(text), stage: JSON.parse(state).stage };
        })
        .toMatchObject({
          stage: "completed",
          segments: [{ text: "One  two.", textRaw: " One  two." }, { text: "End." }],
          correctionOutcome: { status: "skipped", reason: "model-not-configured" },
        }),
    );
    const estimate = yield* service.execute({
      action: "correction-estimate",
      project,
      id,
      mode: "quick",
    });
    expect(estimate).toMatchObject({
      estimate: { basis: "revision", segments: 2, targetedSpans: 1, maxCalls: 0 },
    });
    const [accepted, rejected] = yield* Effect.all(
      [
        service.execute({ action: "review-accept", project, id, item: 0 }),
        service.execute({ action: "review-reject", project, id, item: 1 }),
      ],
      { concurrency: "unbounded" },
    );
    if (!("job" in accepted) || !("job" in rejected)) throw new Error("Expected review revisions.");
    const latest = accepted.job.previousRevision === rejected.job.id ? accepted : rejected;
    const earlier = latest === accepted ? rejected : accepted;
    expect(earlier.job.previousRevision).toBe(result.job.id);
    expect(latest.job.previousRevision).toBe(earlier.job.id);
    const file = NodePath.join(project, "Transcripts", latest.job.id, "transcript.json");
    const contents = yield* Effect.promise(() => NodeFSP.readFile(file, "utf8"));
    expect(JSON.parse(contents)).toMatchObject({
      segments: [
        { text: "One  three.", textRaw: " One  two." },
        { text: "End.", textRaw: "End." },
      ],
      reviewItems: [],
      reviewDecisions: expect.arrayContaining([
        expect.objectContaining({ revision: id, index: 0, decision: "accepted" }),
        expect.objectContaining({ revision: id, index: 1, decision: "rejected" }),
      ]),
    });
    expect(
      yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(directory, "transcript.json"), "utf8"),
      ),
    ).toBe(transcript);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "chooses installed local defaults, resumes the same revision, and publishes settlement",
  () =>
    Effect.gen(function* () {
      const project = yield* Effect.acquireRelease(
        Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "transcription-defaults-")),
          ),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(project, "audio.wav"), "fixture"),
      );
      const jobs = yield* Jobs.TranscriptionJobs;
      const threadId = ThreadId.make("transcription-origin");
      const settled = yield* jobs.subscribeSettled();
      const inventory = yield* jobs.engines(project, {});
      expect(inventory.recommendations).toEqual({
        auto: { id: large, installed: true },
        he: { id: ivrit, installed: true },
        ar: { id: large, installed: true },
        arAlternative: { id: arabic, installed: true },
        en: { id: large, installed: true },
        enFast: { id: fast, installed: true },
      });
      expect(inventory.local.length).toBeLessThan(10);
      expect(inventory.local.every((model) => !("accuracy" in model))).toBe(true);
      const details = yield* jobs.engines(project, { language: "he", details: true });
      expect(details.local.find(({ id }) => id === ivrit)?.accuracy?.he).toEqual({
        grade: "D",
        errorPercent: 20.6,
      });
      for (const [language, model] of [
        ["auto", large],
        ["he", ivrit],
        ["ar", large],
        ["en", large],
      ] as const) {
        const started = yield* jobs.startScoped(
          project,
          { source: "audio.wav", language },
          0,
          threadId,
        );
        if (!("job" in started)) throw Error("Expected one job.");
        expect(started.job.settings.model).toBe(model);
        yield* jobs.execute({ action: "cancel", project, id: started.job.id });
        expect(yield* PubSub.take(settled)).toEqual({
          threadId,
          id: started.job.id,
          stage: "canceled",
        });
        const resumed = yield* jobs.startScoped(
          project,
          { source: "audio.wav", language, resume: started.job.id },
          0,
        );
        if (!("job" in resumed)) throw Error("Expected one job.");
        expect(resumed.job.id).toBe(started.job.id);
        yield* jobs.execute({ action: "cancel", project, id: resumed.job.id });
      }
    }).pipe(Effect.provide(layerFor(new Set([large, arabic, ivrit, fast])))),
);

it.effect(
  "blocks agent cloud engines by default and never chooses a single-language model for auto",
  () =>
    Effect.gen(function* () {
      const jobs = yield* Jobs.TranscriptionJobs;
      for (const engine of ["openai", "xai", "openrouter", "chatgpt"] as const) {
        const result = yield* jobs
          .startScoped("/project", { source: "audio.wav", engine }, 0)
          .pipe(Effect.result);
        expect(result._tag === "Failure" && result.failure.code).toBe("cloud-upload-disabled");
      }
      for (const language of ["auto", "ar", "en"]) {
        const result = yield* jobs
          .startScoped("/project", { source: "audio.wav", language }, 0)
          .pipe(Effect.result);
        expect(result._tag === "Failure" && result.failure.code).toBe("model-unavailable");
      }
      const inventory = yield* jobs.engines("/project", {});
      expect(inventory.recommendations.auto).toEqual({ id: large, installed: false });
    }).pipe(Effect.provide(layerFor(new Set([ivrit, arabic, fast])))),
);

it.effect("allows a cloud start to reach source validation when the owner enables uploads", () =>
  Effect.gen(function* () {
    const jobs = yield* Jobs.TranscriptionJobs;
    const result = yield* jobs
      .startScoped(
        "/missing-project-for-transcription-test",
        {
          source: "audio.wav",
          engine: "openai",
        },
        0,
      )
      .pipe(Effect.result);
    expect(result._tag === "Failure" && result.failure.code).toBe("not-found");
  }).pipe(Effect.provide(layerFor(undefined, true))),
);

it.effect("requires the agent cloud setting and owner upload consent independently", () =>
  Effect.gen(function* () {
    const project = yield* Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "transcription-consent-")),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const jobs = yield* Jobs.TranscriptionJobs;
    const input = {
      action: "start",
      project,
      engine: "cloud",
      cloudEngineId: "synthetic",
      source: NodePath.join(project, "audio.wav"),
      model: "synthetic",
      language: "auto",
    } as const;
    expect((yield* jobs.execute(input, { scoped: true }).pipe(Effect.flip)).code).toBe(
      "agent-cloud-disabled",
    );
    expect((yield* jobs.execute(input).pipe(Effect.flip)).code).toBe("consent-required");
    expect(yield* Effect.promise(() => NodeFSP.readdir(project))).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("admits subtitle import as a cancellable job before VAD completes", () =>
  Effect.gen(function* () {
    const project = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "subtitle-job-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const source = NodePath.join(project, "lecture.mp4");
    yield* Effect.promise(() => NodeFSP.writeFile(source, "synthetic media"));
    const jobs = yield* Jobs.TranscriptionJobs;
    const start = yield* jobs.execute({
      action: "use-subtitles",
      project,
      source,
      subtitles: { stream: 1 },
    });
    if (!("job" in start)) throw new Error("Expected a subtitle job.");
    expect(start.state.stage).toBe("decoding");
    const stopped = yield* jobs.execute({ action: "cancel", project, id: start.job.id });
    if (!("job" in stopped)) throw new Error("Expected a subtitle job.");
    expect(stopped.state.stage).toBe("canceled");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "discovers neighboring subtitles without creating a revision and admits OpenAI Both",
  () =>
    Effect.gen(function* () {
      const project = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "subtitle-actions-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const source = NodePath.join(project, "lecture.wav");
      const file = NodePath.join(project, "lecture.en.vtt");
      yield* Effect.promise(async (signal) => {
        await runMediaTool(
          "ffmpeg",
          ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", source],
          { signal },
        );
        await NodeFSP.writeFile(file, "WEBVTT\n\n00:00.000 --> 00:01.000\nMIT");
      });
      const jobs = yield* Jobs.TranscriptionJobs;
      const discovery = yield* jobs.execute({ action: "discover-subtitles", project, source });
      expect(discovery).toMatchObject({ sidecars: [{ language: "en" }] });
      expect(yield* jobs.execute({ action: "list", project })).toEqual([]);
      const started = yield* jobs.execute({
        action: "start",
        subtitleMode: "both",
        project,
        source,
        subtitles: { file },
        engine: "openai",
        cloudEngineId: "fixture",
        model: "gpt-transcribe",
        language: "en",
      });
      if (!("job" in started)) throw new Error("Expected a subtitle-assisted job.");
      expect(started.job.settings.subtitleMode).toBe("both");
      yield* jobs.execute({ action: "cancel", project, id: started.job.id });
    }).pipe(
      Effect.provide(
        layerFor(undefined, false, undefined, undefined, undefined, undefined, undefined, () =>
          Effect.succeed({
            provider: "openai",
            model: "gpt-transcribe",
            accountName: "Fixture",
            origin: "https://api.openai.com",
            fingerprint: "fixture",
            maxAudioBytes: 1_000_000,
            open: () => ({ recognize: async () => [], close: async () => {} }),
          }),
        ),
      ),
    ),
);

it("finds a phrase crossing consecutive subtitle cues at the first cue's time", () => {
  expect(
    Jobs.findTranscriptMatch(
      [
        { start: 0, text: "Introduction" },
        { start: 3, text: "Creative" },
        { start: 4, text: "Commons\nlicense." },
      ],
      "creative commons license",
    ),
  ).toEqual({
    snippet: "Introduction Creative Commons license.",
    matchTime: 3,
  });
});

it.effect("keeps suggestions out of project Words until accepted", () =>
  Effect.gen(function* () {
    const project = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "words-accept-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const id = "2026-11-22-lecture-abcdef01";
    const word = {
      term: "ירושלים",
      variants: ["ירושליים"],
      language: "he",
      source: "user",
    } as const;
    yield* Effect.promise(async () => {
      const directory = NodePath.join(project, "Transcripts", id);
      await NodeFSP.mkdir(directory, { recursive: true });
      await Promise.all([
        NodeFSP.writeFile(NodePath.join(directory, "job.json"), JSON.stringify({ id })),
        NodeFSP.writeFile(
          NodePath.join(directory, "state.json"),
          JSON.stringify({ stage: "completed", completed: 1 }),
        ),
        NodeFSP.writeFile(
          NodePath.join(directory, "transcript.json"),
          JSON.stringify({ suggestions: [word] }),
        ),
      ]);
    });
    const service = yield* Jobs.TranscriptionJobs;
    const scope = { project, level: "project" } as const;
    expect(yield* service.execute({ action: "suggestions-list", project, id })).toEqual([word]);
    expect(yield* service.execute({ action: "words-list", ...scope })).toEqual([]);
    const accept = {
      action: "words-accept",
      ...scope,
      suggestionRevision: id,
      word,
    } as const;
    const missing = yield* service
      .execute({
        ...accept,
        word: { ...word, term: "Other" },
      })
      .pipe(Effect.flip);
    expect(missing.code).toBe("invalid-input");
    expect(yield* service.execute(accept)).toEqual([{ ...word, source: "suggested-accepted" }]);
    expect(yield* service.execute({ action: "words-list", ...scope })).toEqual([
      { ...word, source: "suggested-accepted" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("merges registered project spellings and preserves the receipt through deletion", () =>
  Effect.gen(function* () {
    const project = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-words-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const root = NodePath.join(project, "Transcripts");
    const word = {
      term: "c#",
      preferred: "C#",
      variants: ["see sharp"],
      language: "und",
      source: "user",
    } as const;
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(root);
      await NodeFSP.writeFile(NodePath.join(root, "words.json"), JSON.stringify([word]));
    });
    const scope = { project, level: "project" } as const;
    const jobs = yield* Jobs.TranscriptionJobs;
    expect(yield* jobs.execute({ action: "words-list", ...scope })).toEqual([
      { ...word, variants: ["see sharp", "C sharp"] },
      { term: "שלום", preferred: "שלום", variants: ["שלם"], language: "und", source: "user" },
    ]);
    expect(yield* jobs.execute({ action: "words-list", project, level: "global" })).toEqual([]);
    yield* jobs.execute({ action: "words-remove", ...scope, word });
    expect(yield* jobs.execute({ action: "words-list", ...scope })).toEqual([
      { term: "שלום", preferred: "שלום", variants: ["שלם"], language: "und", source: "user" },
    ]);
  }).pipe(
    Effect.provide(
      layerFor(undefined, false, {
        [ProjectId.make("registered-project")]: {
          speechProjectCustomWords: [
            { term: "C#", aliases: ["C sharp"] },
            { term: "שלום", aliases: ["שלם"] },
          ],
        },
        [ProjectId.make("other-project")]: {
          speechProjectCustomWords: [{ term: "Other", aliases: [] }],
        },
      }),
    ),
  ),
);

it.effect(
  "reads imported personal Words alongside project Words, with project precedence and bounded hints",
  () =>
    Effect.gen(function* () {
      const project = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dictation-words-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const legacy = [
        { term: "C#", aliases: ["C sharp"] },
        { term: "שלום", aliases: ["שלם"] },
      ];
      const global = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        migrateLegacySpeechWords: { id: "c".repeat(64), words: legacy },
      }).transcriptionWords;
      const projectWords = [
        {
          term: "c#",
          preferred: "Project C#",
          variants: ["see sharp"],
          language: "und",
          source: "user",
        },
        ...Array.from({ length: 18 }, (_, index) => ({
          term: `term${index}`,
          language: "und",
          source: "user",
        })),
      ];
      yield* Effect.promise(async () => {
        const directory = NodePath.join(project, "Transcripts");
        await NodeFSP.mkdir(directory);
        await NodeFSP.writeFile(
          NodePath.join(directory, "words.json"),
          JSON.stringify(projectWords),
        );
      });
      yield* Effect.gen(function* () {
        const jobs = yield* Jobs.TranscriptionJobs;
        const scoped = yield* jobs.readDictationWords({
          projectId: ProjectId.make("registered-project"),
          language: "auto",
        });
        expect(scoped.hints).toHaveLength(16);
        expect(scoped.hints[0]).toBe("Project C#");
        expect(scoped.words).toHaveLength(20);
        expect(scoped.words[0]).toEqual(projectWords[0]);
        expect(scoped.words.at(-1)).toMatchObject({ term: "שלום", variants: ["שלם"] });
        expect((yield* jobs.readDictationWords({ language: "auto" })).hints).toEqual([
          "C#",
          "שלום",
        ]);
      }).pipe(Effect.provide(layerFor(undefined, false, {}, global, project)));
    }),
);

it.effect(
  "replays all legacy project writes after reopening the Words store without reviving a deleted row",
  () =>
    Effect.gen(function* () {
      const project = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-words-transition-")),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const projectId = ProjectId.make("registered-project");
      const initial = [{ term: "Remove", aliases: [] }];
      let settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        projectSettingsOverrides: {
          [projectId]: { speechProjectCustomWords: initial },
        },
      });
      const scope = { projectId, level: "project" } as const;
      const word = { term: "Remove", language: "und", source: "user" } as const;
      const services = () => layerFor(undefined, false, {}, [], project, () => settings);
      yield* Effect.gen(function* () {
        const jobs = yield* Jobs.TranscriptionJobs;
        expect((yield* jobs.manageWords({ action: "words-list", ...scope })).words).toEqual([
          { ...word, preferred: "Remove" },
        ]);
        yield* jobs.manageWords({ action: "words-remove", ...scope, word });
      }).pipe(Effect.provide(services()));

      settings = applyServerSettingsPatch(settings, {
        projectSettingsOverrides: {
          [projectId]: {
            speechProjectCustomWords: [...initial, { term: "First", aliases: ["one"] }],
          },
        },
      });
      settings = applyServerSettingsPatch(settings, {
        projectSettingsOverrides: {
          [projectId]: {
            speechProjectCustomWords: [...initial, { term: "Second", aliases: ["two"] }],
          },
        },
      });
      yield* Effect.gen(function* () {
        const jobs = yield* Jobs.TranscriptionJobs;
        const read = jobs.manageWords({ action: "words-list", ...scope });
        const reads = yield* Effect.all([read, read], { concurrency: 2 });
        const expected = [
          { term: "First", preferred: "First", language: "und", variants: ["one"], source: "user" },
          {
            term: "Second",
            preferred: "Second",
            language: "und",
            variants: ["two"],
            source: "user",
          },
        ];
        expect(reads).toEqual([{ words: expected }, { words: expected }]);
      }).pipe(Effect.provide(services()));
    }),
);

it.effect("accepts into each scope and resolves recording Words through a later revision", () =>
  Effect.gen(function* () {
    const project = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scoped-words-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const recording = "2026-11-22-lecture-abcdef01";
    const rerun = "2026-11-23-lecture-abcdef02";
    const word = { term: "שלום", language: "he", source: "user", variants: ["שלם"] } as const;
    yield* Effect.promise(async () => {
      for (const id of [recording, rerun]) {
        const directory = NodePath.join(project, "Transcripts", id);
        await NodeFSP.mkdir(directory, { recursive: true });
        await Promise.all([
          NodeFSP.writeFile(
            NodePath.join(directory, "job.json"),
            JSON.stringify({ id, recording, source: "lecture.wav" }),
          ),
          NodeFSP.writeFile(
            NodePath.join(directory, "state.json"),
            JSON.stringify({ stage: "completed", completed: 1 }),
          ),
          NodeFSP.writeFile(
            NodePath.join(directory, "transcript.json"),
            JSON.stringify({ suggestions: [word] }),
          ),
        ]);
      }
    });
    let settings = DEFAULT_SERVER_SETTINGS;
    yield* Effect.gen(function* () {
      const jobs = yield* Jobs.TranscriptionJobs;
      const projectId = ProjectId.make("registered-project");
      for (const level of ["global", "project", "recording"] as const) {
        expect(
          (yield* jobs.manageWords({
            action: "words-accept",
            projectId,
            level,
            id: recording,
            suggestionRevision: recording,
            word,
          })).words,
        ).toEqual([{ ...word, source: "suggested-accepted" }]);
      }
      expect(
        (yield* jobs.manageWords({
          action: "words-list",
          projectId,
          level: "recording",
          id: rerun,
        })).words,
      ).toEqual([{ ...word, source: "suggested-accepted" }]);
    }).pipe(
      Effect.provide(
        layerFor(
          undefined,
          false,
          {},
          [],
          project,
          () => settings,
          (patch) => Effect.sync(() => (settings = applyServerSettingsPatch(settings, patch))),
        ),
      ),
    );
  }),
);

it.effect(
  "reports unavailable recording defaults without falling back to installed local models",
  () =>
    Effect.gen(function* () {
      const jobs = yield* Jobs.TranscriptionJobs;
      for (const language of ["auto", "en", "he"]) {
        const result = yield* jobs
          .startScoped("/project", { source: "audio.wav", language }, 0)
          .pipe(Effect.result);
        expect(result._tag === "Failure" && result.failure.code).toBe("model-unavailable");
        expect(result._tag === "Failure" && result.failure.detail).toContain("needs attention");
      }
    }).pipe(
      Effect.provide(
        layerFor(new Set([large]), true, undefined, undefined, undefined, () => ({
          ...DEFAULT_SERVER_SETTINGS,
          transcription: { agentsMayUseCloudEngines: true },
          recordingDefaults: {
            models: {},
            engines: {
              auto: { kind: "cloud", engineId: "missing-binding" },
              en: { kind: "chatgpt", instanceId: ProviderInstanceId.make("unavailable") },
              he: { kind: "local", modelId: ivrit },
            },
            correction: "off",
            notify: true,
          },
        })),
      ),
    ),
);

it.effect("imports a standalone Hebrew transcript as a completed recording without media", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "transcript-only-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const project = yield* Effect.promise(() => NodeFSP.realpath(directory));
    const file = NodePath.join(project, "lecture.he.vtt");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(file, "WEBVTT\n\n00:12.000 --> 00:19.000\nשלום לכולם\n"),
    );
    const jobs = yield* Jobs.TranscriptionJobs;
    const result = yield* jobs.execute({ action: "import-transcript", project, file });
    expect(result).toMatchObject({
      job: { source: file, transcriptOnly: true },
      state: { stage: "completed" },
      subtitles: { source: "import" },
    });
    if (!("job" in result)) throw new Error("Expected an import status.");
    const transcript = yield* jobs.execute({ action: "revision", project, id: result.job.id });
    expect(transcript).toMatchObject({ segments: [{ start: 12, end: 19, text: "שלום לכולם" }] });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "names a lesson's caption engine, keeps its captions and transcribes it as a lesson when it ends",
  () =>
    Effect.gen(function* () {
      const project = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lesson-capture-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const jobs = yield* Jobs.TranscriptionJobs;
      const id = "00000000-0000-4000-8000-000000000001";
      const started = yield* jobs.execute({ action: "capture-start", project, id });
      expect(started).toEqual({
        captured: true,
        language: "auto",
        captions: { kind: "local", modelId: large },
        talk: { openai: false },
      });
      yield* jobs.execute({
        action: "capture-chunk",
        project,
        id,
        format: "webm",
        index: 0,
        bytes: Buffer.from("lesson audio").toString("base64"),
      });
      for (const caption of [
        { window: 1, start: 12, end: 20, text: "Second law." },
        { window: 0, start: 0, end: 12, text: "Entropy always increases." },
        { window: 1, start: 12, end: 20, text: "Second law of thermodynamics." },
      ])
        yield* jobs.execute({ action: "capture-caption", project, id, ...caption });
      const captions = yield* Effect.promise(() =>
        NodeFSP.readFile(
          NodePath.join(project, "Transcripts", `.recording-capture-${id}`, "captions.md"),
          "utf8",
        ),
      );
      expect(captions).toContain("[00:00] Entropy always increases.\n\n[00:12] Second law of");
      expect(captions).not.toContain("Second law.\n");
      expect(
        (yield* jobs
          .execute({ action: "capture-start", project, id }, { scoped: true })
          .pipe(Effect.flip)).code,
      ).toBe("invalid-input");
      const finished = yield* jobs.execute({
        action: "capture-finish",
        project,
        id,
        lesson: { language: "auto" },
      });
      expect(finished).toMatchObject({ captured: true, transcription: "started" });
      expect(
        (yield* jobs.execute({ action: "capture-touch", project, id }).pipe(Effect.flip)).detail,
      ).toBe("This recording was already saved.");
      const source = "source" in finished ? finished.source : undefined;
      const revisions = yield* jobs.execute({ action: "list", project });
      expect(revisions).toEqual([
        expect.objectContaining({
          job: expect.objectContaining({
            lesson: true,
            source,
            // Nobody is there to approve a Thorough estimate, so a lesson corrects quickly.
            correction: expect.objectContaining({ mode: "quick" }),
          }),
        }),
      ]);
    }).pipe(
      Effect.provide(
        layerFor(new Set([large]), false, {}, [], undefined, () => ({
          ...DEFAULT_SERVER_SETTINGS,
          recordingDefaults: { models: {}, correction: "thorough", notify: true },
        })),
      ),
    ),
);
