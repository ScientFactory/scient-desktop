import { describeCrashSweep } from "./libraryCrash.ts";

// The rest of the smoke check, in its own file so the two run side by side.
describeCrashSweep(
  "libraryRules.crashMerge.test.ts",
  ["merge two papers", "undo a merge"],
  "these cases",
);
