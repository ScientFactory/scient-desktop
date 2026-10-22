#!/usr/bin/env node

import { runScientSeams } from "./scient-seam-check.mjs";

export function verifyScientExtensionsSeams(argv = process.argv.slice(2)) {
  return runScientSeams(argv, { names: ["extensions"] });
}

if (import.meta.main) verifyScientExtensionsSeams();
