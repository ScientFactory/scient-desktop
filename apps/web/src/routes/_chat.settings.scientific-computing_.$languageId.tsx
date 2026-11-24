import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ComputeLanguagePage } from "../scient/compute/ComputeLanguagePage";

// SCIENT-FORK:START — open the project runtime shown in the Compute toolbar.
function SettingsComputeLanguageRoute() {
  const { languageId } = Route.useParams();
  const { environmentId, cwd, runtime } = Route.useSearch();
  return (
    <ComputeLanguagePage
      languageId={languageId}
      environmentId={environmentId}
      {...(cwd === undefined || runtime === undefined
        ? {}
        : { focus: { cwd, executable: runtime } })}
    />
  );
}

export const Route = createFileRoute("/_chat/settings/scientific-computing_/$languageId")({
  validateSearch: Schema.decodeUnknownSync(
    Schema.Struct({
      environmentId: Schema.optionalKey(EnvironmentId),
      cwd: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(4096))),
      runtime: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(4096))),
    }),
  ),
  component: SettingsComputeLanguageRoute,
});
// SCIENT-FORK:END
