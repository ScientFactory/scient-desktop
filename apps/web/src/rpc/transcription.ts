import type { ModelSelection, ThreadId, TranscriptionWord } from "@t3tools/contracts";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

type Job = {
  id: string;
  source: string;
  recording?: string;
  transcriptOnly?: true;
  correctionOnly?: true;
  input: { size: number };
  settings: {
    language: string;
    engine: string;
    model: string;
    rule?: "meetily" | "fixed" | "short";
    rangeStart?: number;
    rangeEnd?: number;
  };
  correction?: {
    mode: "off" | "quick" | "thorough";
    notes?: string;
    modelSelection?: ModelSelection;
  };
};

export type RecordingStatus = {
  job: Job;
  created?: number;
  reviewCount?: number;
  duration?: number;
  modelName?: string;
  snippet?: string;
  matchTime?: number;
  state: {
    stage:
      | "decoding"
      | "writing"
      | "transcribing"
      | "completed"
      | "canceled"
      | "interrupted"
      | "paused"
      | "failed";
    completed: number;
    total?: number;
    error?: { message: string };
  };
};

type Segment = {
  id: string;
  start: number;
  end: number;
  text: string;
  language: string;
  speaker?: string | null;
};

type Subtitle = { stream: number } | { file: string; format?: "zoom-vtt" | "teams-docx" };

type RecordingSource = {
  source: string;
  size: number;
  created: number;
  queued?: boolean;
  duration?: number;
};
type Commands = {
  inventory: {
    language: string;
    details?: boolean;
    response: {
      mediaAvailable?: boolean;
      local: {
        id: string;
        name: string;
        installed: boolean;
        grade?: string;
        size?: number;
        languages?: readonly string[];
        accuracy?: Readonly<Record<string, { grade: string; errorPercent: number }>>;
        secondsPer30s: { accelerated: number | null; cpu?: number | null };
      }[];
      chatgpt: { enabled: boolean; signedIn: boolean | null };
      cloud: {
        id: string;
        provider: string;
        model: string;
        accountName?: string;
        origin?: string;
        audioHourUsd?: number;
      }[];
      recommendations: Record<string, { id: string; installed: boolean; role?: string }>;
    };
  };
  "sample-language": { source: string; response: { detectedLanguage: string | null } };
  "discover-subtitles": {
    source: string;
    response: {
      duration?: number;
      tracks: { stream: number; supported: boolean; language?: string }[];
      sidecars: { file: string; language?: string }[];
    };
  };
  "assess-subtitles": {
    source: string;
    model: string;
    subtitles: Subtitle;
    response: {
      assessment: {
        correction?: { offset: number; scale: number };
        quality: {
          recommendation: "use-subtitles" | "both" | "transcribe-only";
          audioLanguage?: string | null;
          subtitleLanguage?: string | null;
          coverage?: number | null;
          wordErrorRate?: number | null;
        } | null;
      };
    };
  };
  "correction-estimate": {
    source: string;
    language: string;
    mode: "thorough";
    resume?: string;
    correctionModel?: ModelSelection;
    useWords?: boolean;
    response: {
      estimateId?: string;
      estimate?: { wallSeconds: number; textCostUsd?: number | null };
      unavailable?: string;
    };
  };
  "words-list": {
    level: "global" | "project" | "recording";
    id?: string;
    response: readonly TranscriptionWord[];
  };
  "import-transcript": {
    file: string;
    source?: string;
    format?: "zoom-vtt" | "teams-docx";
    previousId?: string;
    response: RecordingStatus;
  };
  "use-subtitles": { source: string; subtitles: Subtitle; response: RecordingStatus };
  start: {
    source: string;
    engine: "local" | "chatgpt" | "cloud";
    model: string;
    language: string;
    cloudEngineId?: string;
    resume?: string;
    revisionMode?: "resume" | "rerun";
    rule?: "meetily" | "fixed" | "short";
    range?: { start: number; end: number };
    notes?: string;
    subtitles?: Subtitle;
    subtitleMode?: "both";
    mode?: "off" | "quick" | "thorough";
    correctionModel?: ModelSelection;
    estimateId?: string;
    useWords?: boolean;
    response: RecordingStatus;
  };
  "start-batch": {
    source: string;
    sources: readonly string[];
    engine: "local" | "chatgpt" | "cloud";
    model: string;
    language: string;
    cloudEngineId?: string;
    mode?: "off";
    correctionModel?: ModelSelection;
    useWords?: boolean;
    response: { queued: number };
  };
  "capture-chunk": {
    id: string;
    format: "webm" | "m4a";
    index: number;
    bytes: string;
    response: object;
  };
  "capture-recover": { response: object };
  "capture-touch": { id: string; response: object };
  "capture-finish": { id: string; response: { source?: string } };
  "media-register": {
    source: string;
    onlyInProject?: true;
    response: { media: RecordingSource[] };
  };
  "media-list": { response: { media: RecordingSource[] } };
  pause: { id: string; response: RecordingStatus };
  list: { includeCreated: true; query?: string; source?: string; response: RecordingStatus[] };
  status: { id: string; response: RecordingStatus };
  revision: {
    id: string;
    response: {
      segments: Segment[];
      reviewItems?: { segmentId: string; before: string; after: string; reason: string }[];
    };
  };
  "review-accept": { id: string; item: number; response: RecordingStatus };
  "review-reject": { id: string; item: number; response: RecordingStatus };
};

export async function transcriptionCommand<Action extends keyof Commands>(
  action: Action,
  project: string,
  input: Omit<Commands[Action], "response">,
  signal?: AbortSignal,
): Promise<Commands[Action]["response"]> {
  return postTranscription(
    "/api/transcription/jobs",
    action === "assess-subtitles"
      ? {
          ...input,
          action: "start",
          project,
          subtitleMode: action,
          engine: "local",
          language: "auto",
        }
      : { ...input, action, project },
    signal,
  ) as Promise<Commands[Action]["response"]>;
}

export async function consentToTranscriptionEngine(id: string) {
  await postTranscription("/api/transcription/engines", {
    action: "set-upload-consent",
    id,
    allowed: true,
  });
}

async function postTranscription(
  endpoint: string,
  body: object,
  signal?: AbortSignal,
): Promise<unknown> {
  const token = await readDesktopPrimaryBearerToken();
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(endpoint), {
    method: "POST",
    credentials: token ? "omit" : "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`Transcription request failed (${response.status}).`);
  return response.json();
}

export type RecordingNoteRecipe = "summary" | "study-notes" | "action-items";
export type RecordingNote = {
  threadId: string;
  path: string;
  recipe: RecordingNoteRecipe;
  text: string | null;
};

export function listRecordingNotes(project: string, id: string, signal: AbortSignal) {
  return postTranscription(
    "/api/transcription/notes",
    { action: "list", project, id },
    signal,
  ) as Promise<RecordingNote[]>;
}

export function makeRecordingNotes(
  project: string,
  id: string,
  recipe: RecordingNoteRecipe,
  modelSelection?: ModelSelection,
) {
  return postTranscription("/api/transcription/notes", {
    action: "make",
    project,
    id,
    recipe,
    ...(modelSelection ? { modelSelection } : {}),
  }) as Promise<{ needsModel: true } | { threadId: string }>;
}

export function listRecordingThreads(project: string, id: string) {
  return postTranscription("/api/transcription/notes", { action: "links", project, id }) as Promise<
    ThreadId[]
  >;
}

export async function linkRecordingThread(
  project: string,
  id: string,
  threadId: string,
  range?: { start: number; end: number },
) {
  await postTranscription("/api/transcription/notes", {
    action: "link",
    project,
    id,
    threadId,
    range,
  });
}
