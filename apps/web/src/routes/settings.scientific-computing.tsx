import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ScientificComputingSettings } from "../scient/compute/ScientificComputingSettings";

export const Route = createFileRoute("/settings/scientific-computing")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  validateSearch: Schema.decodeUnknownSync(
    Schema.Struct({ environmentId: Schema.optionalKey(EnvironmentId) }),
  ),
  component: () => <ScientificComputingSettings environmentId={Route.useSearch().environmentId} />,
});
