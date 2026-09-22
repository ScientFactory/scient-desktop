#!/usr/bin/env node

import { runScientSeams } from "./scient-seam-check.mjs";

export function verifyScientAnalysisSeams(argv = process.argv.slice(2)) {
  return runScientSeams(argv, { names: ["analysis"] });
}

if (import.meta.main) verifyScientAnalysisSeams();
