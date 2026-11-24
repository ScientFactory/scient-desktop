import { expect, it } from "vite-plus/test";
import { WindowPriority } from "./WindowPriority.ts";

it.each([false, true])("prioritizes dictation with window abandonment %s", async (abandon) => {
  let deadline: (() => void) | undefined;
  const priority = new WindowPriority((expire) => {
    deadline = expire;
    return () => {
      deadline = undefined;
    };
  });
  const controller = new AbortController();
  const finish = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const events: string[] = [];
  let attempts = 0;
  const recording = priority
    .recognize(controller.signal, async (signal) => {
      attempts += 1;
      events.push("window");
      if (attempts === 1) {
        await finish.promise;
        if (signal.aborted) await exited.promise;
      }
      return "result";
    })
    .then(() => events.push("commit"));
  const dictation = priority.dictate(0, controller.signal, async (admitted) => {
    admitted();
    events.push("dictation");
  });
  expect(priority.waiting(1999)).toBe(false);
  if (abandon) {
    deadline?.();
    expect(priority.waiting(2000)).toBe(true);
    finish.resolve();
    await Promise.resolve();
    expect(events).toEqual(["window"]);
    exited.resolve();
  } else {
    finish.resolve();
  }
  await dictation;
  await recording;
  expect(attempts).toBe(abandon ? 2 : 1);
  expect(events).toEqual(
    abandon ? ["window", "dictation", "window", "commit"] : ["window", "commit", "dictation"],
  );
});
