import type {
  VisualProcessingInput,
  VisualProcessingOutput,
  VisualProcessingReply,
} from "./visualProcessingProtocol";

type Job = {
  id: number;
  input: VisualProcessingInput;
  complete: ((output: VisualProcessingOutput | null) => void) | undefined;
};
const pending = new Map<number, Job>();
let worker: Worker | undefined;
let ready = false;
let sequence = 0;
let active: Job | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;

function stop() {
  clearTimeout(timeout);
  clearTimeout(idle);
  worker?.terminate();
  worker = undefined;
  ready = false;
}

function finish(output: VisualProcessingOutput | null) {
  clearTimeout(timeout);
  const job = active;
  active = undefined;
  try {
    job?.complete?.(output);
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
      for (const job of jobs) job.complete?.(null);
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
          } else if (event.data.id === active?.id) finish(event.data.output);
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
  active = pending.values().next().value!;
  pending.delete(active.id);
  timeout = setTimeout(() => {
    stop();
    finish(null);
  }, 3000);
  try {
    worker.postMessage({ id: active.id, input: active.input });
  } catch {
    finish(null);
  }
}

/** Shared serial processing. Cancellation and deadlines never publish a source edit. */
export function processVisualDocument(
  input: VisualProcessingInput,
  complete: (output: VisualProcessingOutput | null) => void,
) {
  const job: Job = { id: ++sequence, input, complete };
  pending.set(job.id, job);
  pump();
  return () => {
    job.complete = undefined;
    pending.delete(job.id);
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
