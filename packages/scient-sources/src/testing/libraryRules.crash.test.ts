import { describeCrashSweep } from "./libraryCrash.ts";

/** Every case of a full sweep (LIBRARY_CRASH_SWEEP=full) runs from this file. */
describeCrashSweep(
  "libraryRules.crash.test.ts",
  ["add a paper with its PDF", "delete for good"],
  "every case",
);
