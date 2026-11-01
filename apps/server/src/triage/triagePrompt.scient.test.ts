import { assert, it } from "@effect/vitest";

import { TRIAGE_PLAYBOOK } from "./triagePrompt.ts";

it("describes Scient CLI and desktop surfaces, not T3 hosted web or mobile", () => {
  assert.include(TRIAGE_PLAYBOOK, "scient serve");
  assert.include(TRIAGE_PLAYBOOK, "local web app opened by the");
  assert.include(TRIAGE_PLAYBOOK, "desktop app against a local server");
  assert.notInclude(TRIAGE_PLAYBOOK, "app.t3.codes");
  assert.notInclude(TRIAGE_PLAYBOOK, "mobile app");
});
