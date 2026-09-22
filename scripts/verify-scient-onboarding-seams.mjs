#!/usr/bin/env node

import { runScientSeams } from "./scient-seam-check.mjs";

export function verifyScientOnboardingSeams(argv = process.argv.slice(2)) {
  return runScientSeams(argv, { names: ["onboarding"] });
}

if (import.meta.main) verifyScientOnboardingSeams();
