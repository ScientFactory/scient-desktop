// @effect-diagnostics-next-line nodeBuiltinImport:off -- Read CodexManagedErrors.ts as text to list the codes it curates.
import * as NodeFS from "node:fs";

import { analyticsFailureCode } from "@scientfactory/analytics";
import { assert, it } from "@effect/vitest";

import { classifyCodexManagedError } from "../provider/CodexManagedErrors.ts";

// Analytics lists ChatGPT sharing codes explicitly. A code CodexManagedErrors starts curating
// must be added to that list, or its failures are reported without a code.
it("reports every ChatGPT sharing code CodexManagedErrors curates", () => {
  const source = NodeFS.readFileSync(
    new URL("../provider/CodexManagedErrors.ts", import.meta.url),
    "utf8",
  );
  const codes = [
    ...new Set(
      [...source.matchAll(/^\s+((?:subscription_sharing|chatpass)_[a-z0-9_]+):/gmu)].map(
        (match) => match[1]!,
      ),
    ),
  ];
  assert.isAtLeast(codes.length, 15);
  for (const code of codes) {
    assert.equal(classifyCodexManagedError({ error: { code } })?.code, code);
    assert.equal(analyticsFailureCode("codex", code), code, code);
  }
});
