import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ComputeLanguagePage } from "../scient/compute/ComputeLanguagePage";

function SettingsComputeLanguageRoute() {
  const { languageId } = Route.useParams();
  return (
    <ComputeLanguagePage languageId={languageId} environmentId={Route.useSearch().environmentId} />
  );
}

export const Route = createFileRoute("/_chat/settings/scientific-computing_/$languageId")({
  validateSearch: Schema.decodeUnknownSync(
    Schema.Struct({ environmentId: Schema.optionalKey(EnvironmentId) }),
  ),
  component: SettingsComputeLanguageRoute,
});
