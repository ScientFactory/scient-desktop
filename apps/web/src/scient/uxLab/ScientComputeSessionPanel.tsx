import type {
  ComputeExecutionRecord,
  ComputeOutput,
  ComputeRuntimeVerification,
  ComputeSessionRecord,
} from "@scientfactory/compute";
import {
  AlertTriangle,
  ChevronRight,
  CircleSlash,
  FileCode2,
  Image as ImageIcon,
  Loader2,
  Power,
  RotateCcw,
  Scissors,
  Square,
  Terminal,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { resolveComputeFixtureImage } from "./computeFigureFixture";
import type {
  ComputeConsoleState,
  ComputeExperienceFixture,
  ComputeLifetime,
} from "./computeExperienceFixtures";

/**
 * A design proposition for the Phase 4 compute session surface.
 *
 * This is a lab surface, not a production component: Phase 4 has not yet
 * created `apps/web/src/scient/compute`, so there is nothing to inject fixtures
 * into and nothing here is imported by the app. It exists to make the contract's
 * hard states arguable in pixels before they are expensive to change.
 *
 * The two decisions worth disagreeing with are marked DESIGN below.
 */

// ---------------------------------------------------------------------------
// Session status
// ---------------------------------------------------------------------------

type StatusTone = "neutral" | "progress" | "good" | "warn" | "bad";

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "border-border bg-muted/60 text-muted-foreground",
  progress: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
};

type SessionStatusView = {
  readonly label: string;
  readonly tone: StatusTone;
  readonly busy: boolean;
  /** Shown under the chip only when it is not restating the label. */
  readonly detail: string | null;
};

/**
 * DESIGN 1 — Fuse lifecycle and activity into one chip, with lifecycle winning
 * except when it is `ready`.
 *
 * The contract keeps `status` (7 values) and `activity` (3 values) orthogonal,
 * and that is correct as a model: a session can be alive but not answering.
 * Rendering them as two independent badges is the literal translation, and it
 * is worse than useless -- 21 pairs, most of them nonsense, and the reader has
 * to do the fusion themselves every time they glance at it.
 *
 * So: one chip. `activity` is only informative while the lifecycle is `ready`,
 * because a stopping session's idleness tells you nothing. The one case that
 * earns its own wording is ready+unresponsive, which must never read as
 * "Ready" -- that is the state where a user sits waiting for a runtime that is
 * never going to answer.
 */
function describeSession(session: ComputeSessionRecord): SessionStatusView {
  switch (session.status) {
    case "starting":
      return {
        label: "Starting",
        tone: "progress",
        busy: true,
        detail: "Verifying the interpreter and handshaking.",
      };
    case "restarting":
      return {
        label: "Restarting",
        tone: "progress",
        busy: true,
        detail: "Variables from the previous generation will be gone.",
      };
    case "stopping":
      return { label: "Stopping", tone: "progress", busy: true, detail: null };
    case "stopped":
      return {
        label: "Stopped",
        tone: "neutral",
        busy: false,
        detail: "Start a session to run code again.",
      };
    case "failed":
      return { label: "Failed to start", tone: "bad", busy: false, detail: session.lostReason };
    case "lost":
      return { label: "Session lost", tone: "bad", busy: false, detail: session.lostReason };
    case "ready":
      switch (session.activity) {
        case "idle":
          return { label: "Ready", tone: "good", busy: false, detail: null };
        case "busy":
          return {
            label: "Running",
            tone: "progress",
            busy: true,
            detail: session.pendingCount > 0 ? `${session.pendingCount} queued behind it` : null,
          };
        case "unresponsive":
          return {
            label: "Not responding",
            tone: "warn",
            busy: false,
            detail: "The session is alive but the interpreter has stopped answering.",
          };
      }
  }
}

function StatusChip({ view }: { readonly view: SessionStatusView }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE_CLASS[view.tone]}`}
    >
      {view.busy ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
      {view.tone === "warn" ? <AlertTriangle className="size-3" aria-hidden="true" /> : null}
      {view.tone === "bad" ? <Unplug className="size-3" aria-hidden="true" /> : null}
      {view.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Execution status
// ---------------------------------------------------------------------------

const EXECUTION_TONE: Record<string, StatusTone> = {
  queued: "neutral",
  submitting: "progress",
  running: "progress",
  interrupting: "warn",
  succeeded: "good",
  failed: "bad",
  cancelled: "neutral",
  lost: "warn",
};

function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (startedAt === null) return null;
  const end = finishedAt === null ? null : Date.parse(finishedAt);
  if (end === null) return null;
  const ms = end - Date.parse(startedAt);
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Where the code came from, which is the thing a transcript is useless without. */
function SourceChip({ record }: { readonly record: ComputeExecutionRecord }) {
  const source = record.request.source;
  if (source._tag === "console") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Terminal className="size-3" aria-hidden="true" />
        Console
      </span>
    );
  }
  const range =
    source.range === null
      ? null
      : source.origin === "selection" || source.origin === "cell"
        ? `${source.range.startLine + 1}–${source.range.endLine + 1}`
        : null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <FileCode2 className="size-3" aria-hidden="true" />
      <span className="font-medium text-foreground/80">{source.path}</span>
      <span>
        {source.origin}
        {range === null ? "" : ` ${range}`}
      </span>
      {source.bufferState === "dirty" ? (
        /*
         * DESIGN 2 — `dirty` is a warning, not a neutral label.
         *
         * The ADR is emphatic that Scient must never autosave just to make an
         * execution easier to describe, which means dirty-buffer executions are
         * a permanent feature of the transcript rather than an edge case. The
         * consequence is that this row of the transcript cites a file whose
         * contents on disk are not what ran. Six months later that is the single
         * most misleading thing the surface can say, so it gets warning colour
         * rather than a grey pill.
         */
        <span className="ml-0.5 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">
          unsaved buffer
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

function StreamOutput({ output }: { readonly output: Extract<ComputeOutput, { _tag: "stream" }> }) {
  const isError = output.stream === "stderr";
  return (
    <pre
      className={`overflow-x-auto whitespace-pre-wrap break-words rounded-md px-2.5 py-1.5 font-mono text-[11px] leading-relaxed ${
        isError
          ? "border-l-2 border-amber-500/60 bg-amber-500/5 text-amber-900 dark:text-amber-200"
          : "bg-muted/40 text-foreground/90"
      }`}
    >
      {output.text}
    </pre>
  );
}

const USER_FRAME_MARKER = "<scient-session>";

/**
 * A traceback with the user's own frame promoted and the library frames folded.
 *
 * A pandas error arrives with ten frames, nine of which are inside pandas. The
 * useful one is the frame in the submitted code, and it is buried second from
 * the top where an eye trained on Python tracebacks does not look for it.
 */
function DiagnosticOutput({
  diagnostic,
}: {
  readonly diagnostic: {
    readonly errorName: string;
    readonly message: string;
    readonly traceback: readonly string[];
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const userFrameIndex = diagnostic.traceback.findIndex((line) => line.includes(USER_FRAME_MARKER));
  const userFrame =
    userFrameIndex === -1
      ? null
      : diagnostic.traceback.slice(userFrameIndex, userFrameIndex + 2).join("\n");
  const hiddenCount = Math.max(0, diagnostic.traceback.length - (userFrame === null ? 0 : 2) - 2);

  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5">
      <div className="px-2.5 py-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs font-semibold text-red-600 dark:text-red-400">
            {diagnostic.errorName}
          </span>
        </div>
        <p className="mt-0.5 font-mono text-[11px] leading-relaxed text-foreground/90">
          {diagnostic.message}
        </p>
        {userFrame === null ? null : (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded border-l-2 border-red-500/50 bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">
            {userFrame}
          </pre>
        )}
      </div>
      {hiddenCount > 0 ? (
        <>
          <button
            className="flex w-full items-center gap-1 border-t border-red-500/20 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-red-500/5 hover:text-foreground"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            <ChevronRight
              aria-hidden="true"
              className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            {expanded ? "Hide" : "Show"} {hiddenCount} library frames
          </button>
          {expanded ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-red-500/20 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {diagnostic.traceback.join("\n")}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ImageOutput({ output }: { readonly output: Extract<ComputeOutput, { _tag: "image" }> }) {
  const src = resolveComputeFixtureImage(output.contentHash);
  if (src === null) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-3 text-[11px] text-muted-foreground">
        <ImageIcon className="size-3.5" aria-hidden="true" />
        Figure is no longer stored ({(output.byteLength / 1024).toFixed(1)} KB).
      </div>
    );
  }
  return (
    <figure className="overflow-hidden rounded-md border border-border bg-white">
      <img
        alt={`Figure output, ${output.width ?? "unknown"} by ${output.height ?? "unknown"} pixels`}
        className="block h-auto w-full"
        src={src}
      />
      <figcaption className="flex items-center justify-between border-t border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
        <span>
          {output.mediaType} · {output.width}×{output.height}
        </span>
        <span>Open in preview</span>
      </figcaption>
    </figure>
  );
}

const SYSTEM_EVENT_STYLE: Record<
  string,
  { readonly icon: typeof RotateCcw; readonly tone: StatusTone; readonly title: string }
> = {
  "session-started": { icon: Loader2, tone: "neutral", title: "Session started" },
  "session-restarted": { icon: RotateCcw, tone: "warn", title: "Session restarted" },
  "execution-interrupted": { icon: Square, tone: "warn", title: "Execution interrupted" },
  "session-lost": { icon: Unplug, tone: "bad", title: "Session lost" },
  "output-truncated": { icon: Scissors, tone: "warn", title: "Output truncated" },
  "input-unsupported": { icon: CircleSlash, tone: "warn", title: "Input not supported" },
  "runtime-warning": { icon: TriangleAlert, tone: "warn", title: "Runtime warning" },
};

/**
 * A session marker is a full-width rule, not a card.
 *
 * Restarts, losses and truncations are boundaries between things rather than
 * things in their own right. Rendering them as another card in the list makes a
 * restart look like something that happened *in* the transcript rather than
 * something that happened *to* it.
 */
function SystemMarker({ output }: { readonly output: Extract<ComputeOutput, { _tag: "system" }> }) {
  const style = SYSTEM_EVENT_STYLE[output.event] ?? {
    icon: TriangleAlert,
    tone: "warn" as StatusTone,
    title: output.event,
  };
  const Icon = style.icon;
  return (
    <div className="my-1 flex items-start gap-2 px-1">
      <div className="flex-1 border-t border-dashed border-border pt-2">
        <div className="flex items-start gap-1.5">
          <Icon
            aria-hidden="true"
            className={`mt-px size-3.5 shrink-0 ${
              style.tone === "bad"
                ? "text-red-600 dark:text-red-400"
                : "text-amber-600 dark:text-amber-400"
            }`}
          />
          <div className="min-w-0">
            <span className="text-[11px] font-semibold text-foreground/80">{style.title}</span>
            {output.detail === null ? null : (
              <p className="text-[11px] leading-relaxed text-muted-foreground">{output.detail}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OutputList({ outputs }: { readonly outputs: readonly ComputeOutput[] }) {
  return (
    <div className="mt-2 space-y-1.5">
      {outputs.map((output) => {
        const key = `${output._tag}-${output.sequence}`;
        switch (output._tag) {
          case "stream":
            return <StreamOutput key={key} output={output} />;
          case "diagnostic":
            return <DiagnosticOutput key={key} diagnostic={output.diagnostic} />;
          case "image":
            return <ImageOutput key={key} output={output} />;
          case "system":
            return <SystemMarker key={key} output={output} />;
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function ExecutionCard({
  record,
  outputs,
  stale,
}: {
  readonly record: ComputeExecutionRecord;
  readonly outputs: readonly ComputeOutput[];
  readonly stale: boolean;
}) {
  const result = record.result;
  const status = result?.status ?? "queued";
  const tone = EXECUTION_TONE[status] ?? "neutral";
  const duration = formatDuration(result?.startedAt ?? null, result?.finishedAt ?? null);
  const queuePosition = result?.queuePosition ?? null;

  return (
    <article
      className={`rounded-lg border border-border bg-background/60 p-2.5 ${stale ? "opacity-60" : ""}`}
    >
      <header className="flex items-center justify-between gap-2">
        <SourceChip record={record} />
        <div className="flex shrink-0 items-center gap-1.5">
          {duration === null ? null : (
            <span className="font-mono text-[10px] text-muted-foreground">{duration}</span>
          )}
          <span
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${TONE_CLASS[tone]}`}
          >
            {status === "running" || status === "submitting" ? (
              <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
            ) : null}
            {status === "queued" && queuePosition !== null ? `queued · ${queuePosition}` : status}
          </span>
          {/*
            Cancel belongs to the queued execution, not to the header. Interrupt
            in the header stops whatever the session is doing now; a queued cell
            has not started, so stopping it is a different act with a different
            consequence, and the only unambiguous place to say which one you mean
            is on the row itself.
          */}
          {status === "queued" ? (
            <Button className="h-6 px-1.5 text-[10px]" size="sm" variant="ghost">
              Cancel
            </Button>
          ) : null}
        </div>
      </header>

      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-foreground">
        {record.request.code}
      </pre>

      {result !== null && result.failureReason !== null ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          {result.failureReason}
        </p>
      ) : null}

      {outputs.length > 0 ? <OutputList outputs={outputs} /> : null}

      {result?.truncated === true ? null : null}
    </article>
  );
}

/**
 * The seal between generations.
 *
 * This is the piece the contract makes necessary and a naive transcript gets
 * wrong. Executions above a restart really happened and their output is real,
 * but the variables they defined no longer exist. A user scrolling up, seeing
 * `cohort = pd.read_parquet(...)` succeed, and concluding that `cohort` is
 * available is drawing a false conclusion from a true record. Dimming alone does
 * not say why, so the boundary is labelled.
 *
 * REVISED — the earlier version of this said the same thing twice. It rendered
 * the `session-restarted` system marker and then this seal immediately below it,
 * so a restart produced two adjacent notices with the same content, and the one
 * that mattered ("the variables are gone") was the smaller of the two. It also
 * leaned on `opacity-60` alone to mark the dead generation, which at this text
 * size reads as "loading" rather than "sealed".
 *
 * Now: the marker is absorbed into the seal -- one statement, carrying the
 * runtime's own detail when it has any -- and the executions above it are
 * separated by a struck band rather than only dimmed.
 */
function GenerationSeal({
  generation,
  detail,
}: {
  readonly generation: number;
  readonly detail: string | null;
}) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-amber-500/40 bg-amber-500/10">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <RotateCcw
          className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">
          Restarted · everything above lost its variables
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-amber-700/70 dark:text-amber-400/70">
          gen {generation} → {generation + 1}
        </span>
      </div>
      {detail === null ? null : (
        <p className="border-t border-amber-500/30 px-2 py-1 text-[10px] leading-relaxed text-amber-700/90 dark:text-amber-400/90">
          {detail}
        </p>
      )}
    </div>
  );
}

/**
 * The boundary between session lifetimes -- a different thing from a restart.
 *
 * A restart is a new generation inside one session: same runtime choice, same
 * identity, variables cleared. A new lifetime is a new `sessionId`: possibly a
 * different interpreter, a different environment fingerprint, a different
 * machine. Treating them as one boundary (the proposal's copy nearly does) hides
 * the case that actually misleads people -- scrolling past a result that was
 * produced by a Python they are no longer using.
 *
 * So this is a heavier rule than a generation seal, and it names the runtime.
 */
function LifetimeBoundary({
  lifetime,
  expanded,
  onToggle,
}: {
  readonly lifetime: ComputeLifetime;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="my-2">
      <button
        className="flex w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-left transition hover:bg-muted/70"
        onClick={onToggle}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className={`size-3 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[11px] font-semibold">Earlier session</span>
            <span className="truncate text-[10px] text-muted-foreground">
              {lifetime.endedReason}
            </span>
          </div>
          <p className="truncate text-[10px] text-muted-foreground">
            {lifetime.runtimeLabel} · {lifetime.executionCount} executions ·{" "}
            {lifetime.generationCount} generation{lifetime.generationCount === 1 ? "" : "s"}
          </p>
        </div>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {new Date(lifetime.endedAt).toLocaleDateString()}
        </span>
      </button>
      {expanded ? (
        <p className="mt-1 px-2 text-[10px] leading-relaxed text-muted-foreground">
          Collapsed by default. Its records are readable, and nothing in it is connected to the
          session running now — a variable defined here does not exist there.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const READINESS_TONE: Record<string, StatusTone> = {
  ready: "good",
  "missing-requirement": "warn",
  "unsupported-version": "warn",
  unusable: "bad",
};

const SOURCE_EXPLANATION: Record<string, string> = {
  configured: "From your settings",
  project: "Found in this project",
  path: "Found on PATH",
  conventional: "Found in a conventional location",
};

function InterpreterRow({
  verification,
  selected,
}: {
  readonly verification: ComputeRuntimeVerification;
  readonly selected: boolean;
}) {
  const usable = verification.readiness === "ready";
  const tone = READINESS_TONE[verification.readiness] ?? "neutral";
  return (
    <div
      className={`rounded-lg border p-2.5 ${
        selected ? "border-primary/50 bg-primary/5" : "border-border bg-background/60"
      } ${usable ? "" : "opacity-80"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium">{verification.profile.displayName}</span>
            <span className="shrink-0 rounded border border-border bg-muted/60 px-1 text-[10px] text-muted-foreground">
              {verification.profile.languageVersion}
            </span>
          </div>
          <code className="mt-0.5 block truncate text-[10px] text-muted-foreground">
            {verification.profile.executable}
          </code>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {SOURCE_EXPLANATION[verification.profile.source] ?? verification.profile.source}
          </p>
        </div>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${TONE_CLASS[tone]}`}
        >
          {verification.readiness === "ready" ? "usable" : verification.readiness}
        </span>
      </div>

      {verification.message === null ? null : (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {verification.message}
        </p>
      )}

      {/*
        An unusable candidate keeps its remedy attached to it. A list that hid
        the three broken interpreters would be tidier and would leave a user
        who expected to see their pyenv Python unable to find out why it is
        missing -- so they are shown, ranked below, with the reason stated.
      */}
      {verification.missingRequirements.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">missing</span>
          {verification.missingRequirements.map((requirement) => (
            <code
              className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] text-amber-700 dark:text-amber-400"
              key={requirement}
            >
              {requirement}
            </code>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex justify-end">
        <Button disabled={!usable} size="sm" variant={selected ? "secondary" : "default"}>
          {selected ? "In use" : usable ? "Start session" : "Unavailable"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

/**
 * The console lives at the bottom of the full surface, and only here.
 *
 * The proposal is right that exploratory code needs somewhere to go that is not
 * a file, and right to put it under the durable timeline rather than in a
 * separate REPL surface: a console execution is the same kind of record as a
 * file execution and belongs in the same history. What it must not do is look
 * like the chat composer -- this box sends code to a kernel, and the failure
 * mode of confusing the two is running a sentence of English as Python.
 */
function ConsoleComposer({ state }: { readonly state: ComputeConsoleState }) {
  const [draft, setDraft] = useState(state.draft);

  if (!state.enabled) {
    return (
      <div className="border-t border-border px-3 py-2">
        <p className="text-[11px] text-muted-foreground">
          <Terminal className="mr-1 inline size-3" aria-hidden="true" />
          Console unavailable · {state.disabledReason}
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-border p-2">
      <div className="rounded-md border border-border bg-muted/30 focus-within:border-primary/50">
        <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1">
          <Terminal className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-[10px] font-medium text-muted-foreground">Console</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {state.historyDepth} in history · ⏎ to run, ⇧⏎ for a new line
          </span>
        </div>
        <textarea
          className="block max-h-40 min-h-[2.25rem] w-full resize-y bg-transparent px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60"
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="cohort.describe()"
          rows={draft.split("\n").length}
          spellCheck={false}
          value={draft}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// States before a session exists
// ---------------------------------------------------------------------------

function PanelFrame({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{subtitle}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </div>
  );
}

/**
 * Off is a calm state, and that is a deliberate design constraint rather than a
 * cosmetic one. This panel can be opened by someone who has no interest in
 * running code and reached it by exploring; it must not look like something is
 * wrong, must not offer to install anything, and must not have probed the
 * machine to render.
 */
function OffState() {
  return (
    <PanelFrame subtitle="Not enabled for this environment." title="Compute">
      <div className="rounded-lg border border-dashed border-border p-4 text-center">
        <Power className="mx-auto size-5 text-muted-foreground/60" aria-hidden="true" />
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          Scientific computing is not enabled for this environment. Enable only the languages you
          use — Scient will not download or modify a runtime.
        </p>
        <Button className="mt-3" size="sm" variant="secondary">
          Open Scientific Computing settings
        </Button>
      </div>
    </PanelFrame>
  );
}

/** Enabled, discovery done, nothing started. The resolved path is shown before the first run. */
function NotStartedState({ fixture }: { readonly fixture: ComputeExperienceFixture }) {
  const resolved = fixture.discovered.find((candidate) => candidate.readiness === "ready") ?? null;
  const usable = fixture.discovered.filter((candidate) => candidate.readiness === "ready").length;
  const [showAll, setShowAll] = useState(resolved === null);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Compute</h2>
            {resolved === null ? (
              <p className="mt-0.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                No usable interpreter on this environment.
              </p>
            ) : (
              <>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  Python {resolved.profile.languageVersion} · {resolved.profile.displayName}
                </p>
                {/*
                  The exact path, before the first execution, where it is still
                  cheap to change. Once a session starts its runtime is locked,
                  so this is the last moment this decision is reversible without
                  losing state -- which is exactly why it is full width and not
                  hidden behind a details disclosure.
                */}
                <code className="mt-1 block wrap-anywhere text-[10px] text-muted-foreground">
                  {resolved.profile.executable}
                </code>
              </>
            )}
          </div>
          <span className="shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium border-border bg-muted/60 text-muted-foreground">
            No session
          </span>
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <Button disabled={resolved === null} size="sm">
            Start session
          </Button>
          <button
            className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setShowAll((value) => !value)}
            type="button"
          >
            {showAll ? "Hide" : `Change (${usable} usable of ${fixture.discovered.length})`}
          </button>
        </div>

        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
          Chosen automatically: configured runtime, then this project&apos;s <code>.venv</code>,
          then PATH. Once a session starts, its runtime is fixed until you stop it.
        </p>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {showAll ? (
          fixture.discovered.map((verification) => (
            <InterpreterRow
              key={verification.profile.executable}
              selected={verification === resolved}
              verification={verification}
            />
          ))
        ) : (
          <p className="py-8 text-center text-[11px] text-muted-foreground">
            Nothing has run in this project yet.
          </p>
        )}
      </div>

      <ConsoleComposer state={fixture.console} />
    </div>
  );
}

/**
 * Reopened after Scient closed: real history, no live runtime.
 *
 * The honest version of this state is the whole point of the proposal's session
 * correction. Nothing restarts on its own, nothing is replayed, and the
 * transcript stays readable -- but every card in it must be unmistakably inert,
 * or a user reads yesterday's successful `cohort = ...` as today's state.
 */
function PriorLifetimeState({ fixture }: { readonly fixture: ComputeExperienceFixture }) {
  const lifetime = fixture.priorLifetimes[0]!;
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Compute</h2>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {lifetime.runtimeLabel}
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
            No session
          </span>
        </div>

        <div className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5">
          <p className="text-[11px] leading-relaxed text-foreground/80">
            {lifetime.endedReason}. Its variables are no longer available.
          </p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
            The records below are still readable. Starting again creates a new session and leaves
            this one untouched.
          </p>
        </div>

        <div className="mt-2">
          <Button size="sm">Start new session</Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <LifetimeBoundary
          expanded={expanded}
          lifetime={lifetime}
          onToggle={() => setExpanded((value) => !value)}
        />
        {expanded ? (
          <div className="space-y-2">
            {fixture.executions.map((record) => (
              <ExecutionCard
                key={record.request.executionId}
                outputs={fixture.outputs[record.request.executionId] ?? []}
                record={record}
                stale
              />
            ))}
          </div>
        ) : null}
      </div>

      <ConsoleComposer state={fixture.console} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ScientComputeSessionPanel({
  fixture,
}: {
  readonly fixture: ComputeExperienceFixture;
}) {
  const { session, executions, outputs, priorLifetimes } = fixture;
  const [showEnvironment, setShowEnvironment] = useState(false);
  const [expandedLifetimes, setExpandedLifetimes] = useState<readonly string[]>([]);

  if (fixture.enablement === "off") return <OffState />;
  if (session === null) {
    return priorLifetimes.length > 0 ? (
      <PriorLifetimeState fixture={fixture} />
    ) : (
      <NotStartedState fixture={fixture} />
    );
  }

  const view = describeSession(session);
  const sessionMarkers = outputs[""] ?? [];
  const restartDetail =
    sessionMarkers.find(
      (marker): marker is Extract<ComputeOutput, { _tag: "system" }> =>
        marker._tag === "system" && marker.event === "session-restarted",
    )?.detail ?? null;
  const canInterrupt = session.status === "ready" && session.activity === "busy";
  const canRestart =
    session.status === "ready" || session.status === "lost" || session.status === "failed";

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{session.label}</h2>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {session.runtime?.displayName ?? "No interpreter"} · Python{" "}
              {session.identity?.languageVersion ?? session.runtime?.languageVersion ?? "?"} · gen{" "}
              {String(session.generation)}
            </p>
          </div>
          <StatusChip view={view} />
        </div>

        {view.detail === null ? null : (
          <p
            className={`mt-1.5 text-[11px] leading-relaxed ${
              view.tone === "bad"
                ? "text-red-600 dark:text-red-400"
                : view.tone === "warn"
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-muted-foreground"
            }`}
          >
            {view.detail}
          </p>
        )}

        <div className="mt-2 flex items-center gap-1.5">
          {/*
            Interrupt replaces Run rather than sitting next to it. While a cell
            is running, "Run" is the button a user is most likely to hit by
            reflex and least likely to want -- it silently queues work behind a
            cell they are trying to stop.
          */}
          {canInterrupt ? (
            <Button size="sm" variant="secondary">
              <Square className="size-3" aria-hidden="true" />
              Interrupt
            </Button>
          ) : (
            <Button disabled={session.status !== "ready"} size="sm">
              Run cell
            </Button>
          )}
          <Button disabled={!canRestart} size="sm" variant="ghost">
            <RotateCcw className="size-3" aria-hidden="true" />
            Restart
          </Button>
          <Button disabled={session.status !== "ready"} size="sm" variant="ghost">
            Stop
          </Button>
          <button
            className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setShowEnvironment((value) => !value)}
            type="button"
          >
            {showEnvironment ? "Hide" : "Environment"}
          </button>
        </div>

        {showEnvironment ? (
          <dl className="mt-2 space-y-1 rounded-md border border-border bg-muted/30 p-2 text-[10px]">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Interpreter</dt>
              <dd className="min-w-0 break-all font-mono">{session.runtime?.executable}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Working dir</dt>
              <dd className="min-w-0 break-all font-mono">{session.workingDirectory}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Session</dt>
              <dd className="min-w-0 break-all font-mono">{String(session.sessionId)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Processes</dt>
              <dd className="min-w-0 font-mono">
                transport {session.identity?.transportProcessId ?? "—"} · runtime{" "}
                {session.identity?.runtimeProcessId ?? "—"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Env hash</dt>
              <dd className="min-w-0 break-all font-mono">
                {session.environmentFingerprint?.hash.slice(0, 23)}…
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">From</dt>
              <dd className="min-w-0">{session.environmentFingerprint?.contributors.join(", ")}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Stored</dt>
              <dd className="min-w-0">
                {(session.storage.totalBytes / 1024).toFixed(1)} KB ({session.storage.status})
              </dd>
            </div>
          </dl>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/*
          Ended lifetimes sit above the live transcript, collapsed. They are
          older than everything below them, so they read in the same direction as
          the rest of the scroll -- and collapsed, because the common case is a
          user who wants today's session and would otherwise scroll through
          yesterday's to reach it.
        */}
        {priorLifetimes.map((lifetime) => {
          const expanded = expandedLifetimes.includes(lifetime.sessionId);
          return (
            <LifetimeBoundary
              expanded={expanded}
              key={lifetime.sessionId}
              lifetime={lifetime}
              onToggle={() =>
                setExpandedLifetimes((current) =>
                  expanded
                    ? current.filter((entry) => entry !== lifetime.sessionId)
                    : [...current, lifetime.sessionId],
                )
              }
            />
          );
        })}

        {executions.length === 0 ? (
          <p className="py-8 text-center text-[11px] text-muted-foreground">
            Nothing has run in this session yet.
          </p>
        ) : (
          <div className="space-y-2">
            {executions.map((record, index) => {
              const currentGeneration = Number(record.request.generation);
              const previous = executions[index - 1];
              const previousGeneration =
                previous === undefined ? null : Number(previous.request.generation);
              const sealBefore =
                previousGeneration !== null && previousGeneration < currentGeneration
                  ? previousGeneration
                  : null;
              return (
                <div key={record.request.executionId}>
                  {sealBefore === null ? null : (
                    <GenerationSeal detail={restartDetail} generation={sealBefore} />
                  )}
                  <ExecutionCard
                    outputs={outputs[record.request.executionId] ?? []}
                    record={record}
                    stale={currentGeneration < Number(session.generation)}
                  />
                </div>
              );
            })}

            {/*
              Session-scoped markers that are not a generation boundary belong at
              the end. A restart marker is not rendered here: the generation seal
              above already carries it, and printing both was the duplication
              this panel used to have.
            */}
            {sessionMarkers.map((marker) =>
              marker._tag === "system" && marker.event !== "session-restarted" ? (
                <SystemMarker key={`tail-${marker.sequence}`} output={marker} />
              ) : null,
            )}
          </div>
        )}
      </div>

      <ConsoleComposer state={fixture.console} />

      <footer className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
        {executions.length} execution{executions.length === 1 ? "" : "s"} ·{" "}
        {(session.storage.totalBytes / 1024).toFixed(1)} KB stored
        {session.pendingCount > 0 ? ` · ${session.pendingCount} queued` : ""}
        {priorLifetimes.length > 0
          ? ` · ${priorLifetimes.length} earlier session${priorLifetimes.length === 1 ? "" : "s"}`
          : ""}
      </footer>
    </div>
  );
}
