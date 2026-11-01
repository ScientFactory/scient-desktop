#!/usr/bin/env node

import { runScientSeams } from "./scient-seam-check.mjs";

export function verifyScientAccountsSeams(argv = process.argv.slice(2)) {
  return runScientSeams(argv, { names: ["accounts"] });
}

if (import.meta.main) verifyScientAccountsSeams();
