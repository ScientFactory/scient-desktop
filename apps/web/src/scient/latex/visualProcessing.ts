import type {
  VisualProcessingInput,
  VisualProcessingOutput,
  VisualProcessingReply,
} from "./visualProcessingProtocol";
import type { LatexVisualDocument } from "./latexVisualDocument";
import type { JSONContent } from "@tiptap/core";
import { visualChangeDelta } from "./visualProcessingState";

type Job = {
  id: number;
  input: VisualProcessingInput;
  complete: ((output: VisualProcessingOutput | null) => void) | undefined;
  delta: boolean;
};
const pending = new Map<number, Job>();
let worker: Worker | undefined;
let ready = false;
let sequence = 0;
let active: Job | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
const bases = new WeakMap<
  LatexVisualDocument,
  { generation: number; id: number; content: JSONContent }
>();

function deliver(job: Job | undefined, output: VisualProcessingOutput | null) {
  try {
    job?.complete?.(output);
  } catch (error) {
    globalThis.reportError?.(error);
  }
}

function stop() {
  clearTimeout(timeout);
  clearTimeout(idle);
  worker?.terminate();
  worker = undefined;
  ready = false;
  generation++;
}

function finish(output: VisualProcessingOutput | null) {
  clearTimeout(timeout);
  const job = active;
  active = undefined;
  try {
    deliver(job, output);
  } finally {
    pump();
  }
}

function pump() {
  if (active) return;
  clearTimeout(idle);
  if (!pending.size) {
    idle = setTimeout(stop, 30_000);
    return;
  }
  if (!worker) {
    const unavailable = () => {
      stop();
      const jobs = [...pending.values()];
      pending.clear();
      for (const job of jobs) deliver(job, null);
    };
    try {
      worker = new Worker(new URL("./visualProcessing.worker.ts", import.meta.url), {
        type: "module",
      });
      const owner = worker;
      worker.addEventListener(
        "message",
        (event: MessageEvent<VisualProcessingReply & { ready?: boolean }>) => {
          if (worker !== owner) return;
          if (event.data.ready) {
            clearTimeout(timeout);
            ready = true;
            pump();
          } else if (event.data.id === active?.id) {
            if (event.data.needsFull && active.delta) {
              active.delta = false;
              clearTimeout(timeout);
              timeout = setTimeout(() => {
                stop();
                finish(null);
              }, 3000);
              try {
                owner.postMessage({ id: active.id, input: active.input });
              } catch {
                finish(null);
              }
              return;
            }
            const output = event.data.output;
            const projection =
              output?.kind === "project"
                ? output.projection
                : output?.kind === "change"
                  ? output.change?.projection
                  : undefined;
            if (projection)
              bases.set(projection, {
                generation,
                id: active.id,
                // Structured clone changes every returned block's identity. Keep
                // the submitted immutable content only when the worker confirms
                // its accepted projection uses that exact content.
                content:
                  event.data.contentMatchesInput && active.input.kind === "change"
                    ? active.input.content
                    : projection.content,
              });
            finish(output);
          }
        },
      );
      worker.addEventListener("error", (event) => {
        event.preventDefault();
        if (worker !== owner) return;
        if (active) {
          stop();
          finish(null);
        } else unavailable();
      });
      timeout = setTimeout(unavailable, import.meta.env.DEV ? 60_000 : 15_000);
    } catch {
      unavailable();
    }
    return;
  }
  if (!ready) return;
  const priority = (job: Job) =>
    job.input.kind === "change" ? 0 : job.input.kind === "project" ? 1 : 2;
  active = [...pending.values()].reduce((first, job) =>
    priority(job) < priority(first) ? job : first,
  );
  pending.delete(active.id);
  timeout = setTimeout(() => {
    stop();
    finish(null);
  }, 3000);
  try {
    const base = active.input.kind === "change" ? bases.get(active.input.projection) : undefined;
    const delta =
      active.input.kind === "change" && base?.generation === generation
        ? visualChangeDelta(active.input, base.id, base.content)
        : null;
    active.delta = delta !== null;
    worker.postMessage({ id: active.id, input: delta ?? active.input });
  } catch {
    finish(null);
  }
}

/** Shared serial processing. Cancellation and deadlines never publish a source edit. */
export function processVisualDocument(
  input: VisualProcessingInput,
  complete: (output: VisualProcessingOutput | null) => void,
) {
  const job: Job = { id: ++sequence, input, complete, delta: false };
  pending.set(job.id, job);
  pump();
  return () => {
    job.complete = undefined;
    pending.delete(job.id);
    if (active === job) {
      // Superseded work cannot publish an edit. Release its CPU and deadline
      // rather than holding the next document behind an abandoned parse.
      stop();
      finish(null);
    }
  };
}

/** Closing a caller releases both its request and its awaiting continuation. */
export function processVisualDocumentAsync(input: VisualProcessingInput, signal: AbortSignal) {
  return new Promise<VisualProcessingOutput | null>((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let cancel = () => {};
    const abort = () => {
      cancel();
      signal.removeEventListener("abort", abort);
      resolve(null);
    };
    signal.addEventListener("abort", abort, { once: true });
    cancel = processVisualDocument(input, (output) => {
      signal.removeEventListener("abort", abort);
      resolve(output);
    });
  });
}
