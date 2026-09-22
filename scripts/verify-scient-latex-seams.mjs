#!/usr/bin/env node

import { runScientSeams } from "./scient-seam-check.mjs";

export function verifyScientLatexSeams(argv = process.argv.slice(2)) {
  return runScientSeams(argv, { names: ["latex"] });
}

if (import.meta.main) verifyScientLatexSeams();
