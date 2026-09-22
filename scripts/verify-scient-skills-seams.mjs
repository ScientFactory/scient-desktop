#!/usr/bin/env node

import { runScientSeams } from "./scient-seam-check.mjs";

export function verifyScientSkillsSeams(argv = process.argv.slice(2)) {
  return runScientSeams(argv, { names: ["skills"] });
}

if (import.meta.main) verifyScientSkillsSeams();
