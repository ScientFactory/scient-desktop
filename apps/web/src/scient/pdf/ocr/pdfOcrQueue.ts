/** Pages in view are read before pages a search is waiting for. */
export const PDF_OCR_PRIORITY = { search: 1, visible: 2 } as const;

export interface PdfOcrQueueJob {
  /** Raises or lowers the job while it waits; no effect once it runs. */
  setPriority(priority: number): void;
  /** Drops the job if it has not started; reports whether it was dropped. */
  cancel(): boolean;
}

export interface PdfOcrQueue {
  /** Runs `work` when a slot is free, highest priority first, then in arrival order. */
  add(priority: number, work: () => Promise<void>): PdfOcrQueueJob;
  readonly size: number;
}

interface Entry {
  priority: number;
  readonly order: number;
  readonly work: () => Promise<void>;
  state: "waiting" | "running" | "done";
}

export function createPdfOcrQueue(concurrency: number): PdfOcrQueue {
  const waiting: Entry[] = [];
  let running = 0;
  let order = 0;
  const pump = () => {
    while (running < concurrency && waiting.length > 0) {
      let best = 0;
      for (let index = 1; index < waiting.length; index += 1) {
        const entry = waiting[index]!;
        const current = waiting[best]!;
        if (
          entry.priority > current.priority ||
          (entry.priority === current.priority && entry.order < current.order)
        )
          best = index;
      }
      const [entry] = waiting.splice(best, 1);
      entry!.state = "running";
      running += 1;
      void Promise.resolve()
        .then(entry!.work)
        .catch(() => undefined)
        .finally(() => {
          entry!.state = "done";
          running -= 1;
          pump();
        });
    }
  };
  return {
    add(priority, work) {
      const entry: Entry = { priority, order: order++, work, state: "waiting" };
      waiting.push(entry);
      queueMicrotask(pump);
      return {
        setPriority(next) {
          if (entry.state === "waiting") entry.priority = next;
        },
        cancel() {
          if (entry.state !== "waiting") return false;
          waiting.splice(waiting.indexOf(entry), 1);
          entry.state = "done";
          return true;
        },
      };
    },
    get size() {
      return waiting.length + running;
    },
  };
}
