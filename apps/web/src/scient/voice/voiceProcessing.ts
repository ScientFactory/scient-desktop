// Window-level owner for voice dictation after the user commits a stop.
//
// Recording belongs to the visible control and ends with it. Once Insert or
// Send is pressed, the clip, transcription and correction belong to a job held
// here, outside React, so leaving the thread does not discard the dictation.
// Every job carries an owner key fixed at the stop click. Controls display the
// job for their owner key; the job's own `deliver` decides where text lands.

import { useSyncExternalStore } from "react";
import type {
  EnvironmentId,
  VoiceTranscribeRequest,
  VoiceTranscriptionLanguage,
} from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils.ts";
import type { ScientAnalyticsUiEvent } from "@t3tools/contracts";
import type { VoiceTranscriptionClient } from "./voiceClient.ts";
import { describeVoiceError } from "./voiceErrorPresentation.ts";
import {
  correctVoiceTranscript,
  type VoiceTranscriptCorrectionClient,
} from "./voiceTranscriptCorrectionClient.ts";
import type { VoiceWavClip } from "./voiceWavEncoder.ts";

export const EMPTY_TRANSCRIPT_MESSAGE = "No speech detected";

export type VoiceJobPhase = "transcribing" | "correcting";

export interface VoiceJobInput {
  /** Fixed at the stop click; the control showing this key displays the job. */
  readonly ownerKey: string;
  /** The recorder's final flush, already started. */
  readonly clip: Promise<VoiceWavClip | null>;
  readonly send: boolean;
  readonly voiceBridge: VoiceTranscriptionClient;
  readonly correction: {
    readonly corrector: VoiceTranscriptCorrectionClient;
    readonly environmentId: EnvironmentId;
  } | null;
  readonly language: VoiceTranscriptionLanguage | undefined;
  readonly recordAnalytics: (event: ScientAnalyticsUiEvent) => void;
  /** Called at most once, after the job has left the store. */
  readonly deliver: (text: string, send: boolean) => void;
  /** Called at most once, after the job has left the store. */
  readonly fail: (message: string) => void;
}

interface VoiceJob {
  readonly id: string;
  readonly input: VoiceJobInput;
  phase: VoiceJobPhase;
  active: boolean;
  requestId: string | null;
  correction: {
    readonly transcript: string;
    readonly abortController: AbortController;
    readonly startedAt: number;
    readonly audioDurationMs: number;
  } | null;
}

export interface VoiceJobView {
  readonly id: string;
  readonly phase: VoiceJobPhase;
}

interface VoiceProcessingSnapshot {
  readonly jobs: ReadonlyMap<string, VoiceJobView>;
  readonly errors: ReadonlyMap<string, string>;
}

const jobsById = new Map<string, VoiceJob>();
let snapshot: VoiceProcessingSnapshot = { jobs: new Map(), errors: new Map() };
const listeners = new Set<() => void>();

function publish(next: Partial<VoiceProcessingSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function publishJobs(): void {
  const jobs = new Map<string, VoiceJobView>();
  for (const job of jobsById.values()) {
    if (job.active) jobs.set(job.input.ownerKey, { id: job.id, phase: job.phase });
  }
  publish({ jobs });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): VoiceProcessingSnapshot {
  return snapshot;
}

/** The committed job, if any, that a control with this owner key displays. */
export function useVoiceJob(ownerKey: string | null): VoiceJobView | null {
  const read = () => (ownerKey === null ? null : (getSnapshot().jobs.get(ownerKey) ?? null));
  return useSyncExternalStore(subscribe, read, read);
}

/** The last committed-job failure for this owner key, until cleared. */
export function useVoiceJobError(ownerKey: string | null): string | null {
  const read = () => (ownerKey === null ? null : (getSnapshot().errors.get(ownerKey) ?? null));
  return useSyncExternalStore(subscribe, read, read);
}

export function setVoiceJobError(ownerKey: string, message: string): void {
  const errors = new Map(snapshot.errors);
  errors.set(ownerKey, message);
  publish({ errors });
}

export function clearVoiceJobError(ownerKey: string | null): void {
  if (ownerKey === null || !snapshot.errors.has(ownerKey)) return;
  const errors = new Map(snapshot.errors);
  errors.delete(ownerKey);
  publish({ errors });
}

/** Ends the job exactly once; later results, cancels and fallbacks become no-ops. */
function settle(job: VoiceJob): boolean {
  if (!job.active) return false;
  job.active = false;
  jobsById.delete(job.id);
  publishJobs();
  return true;
}

function complete(job: VoiceJob, text: string, startedAt: number, audioDurationMs: number): void {
  if (!settle(job)) return;
  job.input.deliver(text, job.input.send);
  job.input.recordAnalytics({
    name: "voice.transcription.completed",
    properties: {
      engineClass: "local-whisper",
      durationMs: performance.now() - startedAt,
      audioDurationMs,
    },
  });
}

async function run(job: VoiceJob): Promise<void> {
  const { input } = job;
  const clip = await input.clip.catch(() => null);
  if (!job.active) return;
  if (!clip) {
    if (settle(job)) input.fail(EMPTY_TRANSCRIPT_MESSAGE);
    return;
  }
  const startedAt = performance.now();
  input.recordAnalytics({
    name: "voice.transcription.started",
    properties: {
      engineClass: "local-whisper",
      languageMode: input.language ? "explicit" : "automatic",
    },
  });
  const requestId = randomUUID();
  job.requestId = requestId;
  try {
    const request: VoiceTranscribeRequest = {
      requestId,
      audioBase64: clip.base64,
      mimeType: "audio/wav",
      sampleRateHz: clip.sampleRateHz,
      durationMs: clip.durationMs,
      ...(input.language ? { language: input.language } : {}),
    };
    const transcript = await input.voiceBridge.transcribe(request);
    job.requestId = null;
    if (!job.active) return;
    const text = transcript.text.trim();
    if (!text) {
      if (settle(job)) input.fail(EMPTY_TRANSCRIPT_MESSAGE);
      input.recordAnalytics({
        name: "voice.transcription.failed",
        properties: { engineClass: "local-whisper", failureClass: "audio" },
      });
      return;
    }
    if (!input.correction) {
      complete(job, text, startedAt, clip.durationMs);
      return;
    }

    const abortController = new AbortController();
    job.correction = {
      transcript: text,
      abortController,
      startedAt,
      audioDurationMs: clip.durationMs,
    };
    job.phase = "correcting";
    publishJobs();
    const corrected = await correctVoiceTranscript({
      enabled: true,
      correctionClient: input.correction.corrector,
      environmentId: input.correction.environmentId,
      transcript: text,
      ...(input.language ? { language: input.language } : {}),
      signal: abortController.signal,
    });
    complete(job, corrected.text, startedAt, clip.durationMs);
  } catch (error) {
    job.requestId = null;
    if (!settle(job)) return;
    input.fail(describeVoiceError(error));
    input.recordAnalytics({
      name: "voice.transcription.failed",
      properties: { engineClass: "local-whisper", failureClass: "engine" },
    });
  }
}

/**
 * Takes ownership of a committed stop. The job is registered synchronously so
 * a navigation in the same task already finds it; `done` settles when it ends.
 */
export function startVoiceJob(input: VoiceJobInput): {
  readonly id: string;
  readonly done: Promise<void>;
} {
  const job: VoiceJob = {
    id: randomUUID(),
    input,
    phase: "transcribing",
    active: true,
    requestId: null,
    correction: null,
  };
  jobsById.set(job.id, job);
  clearVoiceJobError(input.ownerKey);
  publishJobs();
  return { id: job.id, done: run(job) };
}

/** Cancels one job's own host request and correction; never a global cancel. */
export async function cancelVoiceJob(id: string): Promise<void> {
  const job = jobsById.get(id);
  if (!job) return;
  const phase = job.phase;
  const requestId = job.requestId;
  job.correction?.abortController.abort();
  if (!settle(job)) return;
  if (phase === "transcribing") {
    job.input.recordAnalytics({
      name: "voice.transcription.cancelled",
      properties: { stage: "transcribing" },
    });
  }
  if (requestId) {
    await job.input.voiceBridge.cancelTranscriptionRequest?.({ requestId }).catch(() => undefined);
  }
}

export function cancelVoiceJobsForOwner(ownerKey: string): void {
  for (const job of jobsById.values()) {
    if (job.input.ownerKey === ownerKey) void cancelVoiceJob(job.id);
  }
}

/** Completes a correcting job with its local transcript; a late correction is ignored. */
export function finishVoiceJobWithOriginal(id: string): void {
  const job = jobsById.get(id);
  const correction = job?.correction;
  if (!job || !correction || job.phase !== "correcting") return;
  correction.abortController.abort();
  complete(job, correction.transcript, correction.startedAt, correction.audioDurationMs);
}

/** @internal Test isolation for the window-level store. */
export function resetVoiceProcessingForTests(): void {
  jobsById.clear();
  snapshot = { jobs: new Map(), errors: new Map() };
  for (const listener of listeners) listener();
}
