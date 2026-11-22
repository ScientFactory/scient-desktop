// @effect-diagnostics nodeBuiltinImport:off
// Linux and macOS: every step shape killed at called. One file per kill point, so the macOS
// Overleaf job runs them side by side.
import { describe, it } from "@effect/vitest";

import { privateFoldersAndIdentityHost } from "../workspace/fileExchange.testkit.ts";
import { recoversStepShape, stepShapeCases } from "./WorkspaceApplier.crash.testkit.ts";

const hasPrivateFoldersAndIdentity = await privateFoldersAndIdentityHost();

describe.skipIf(!hasPrivateFoldersAndIdentity)(
  "WorkspaceApplier step shapes after real process death",
  () => {
    it.live.each(stepShapeCases("called"))(
      "recovers $name killed at $point, guard changed: $changed",
      recoversStepShape,
    );
  },
);
