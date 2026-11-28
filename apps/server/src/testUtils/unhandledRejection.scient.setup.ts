import { afterEach, beforeEach, expect } from "vite-plus/test";

// Round 6s: in the server browser's and Accounts' suites, a promise rejected with no handler
// fails the test that was running. In the server it would end the backend.
const SCOPED = /[\\/]src[\\/](?:preview|scient[\\/]accounts)[\\/]/u;
const caught: unknown[] = [];
const record = (reason: unknown) => void caught.push(reason);

beforeEach(() => {
  caught.length = 0;
  if (SCOPED.test(expect.getState().testPath ?? "")) process.on("unhandledRejection", record);
});

afterEach(async () => {
  if (!SCOPED.test(expect.getState().testPath ?? "")) return;
  // Node reports a rejection with no handler only after the current task: one turn waits for it.
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", record);
  if (caught.length > 0)
    throw new Error(
      `A promise was rejected with no handler during this test: ${String(caught[0])}`,
    );
});
