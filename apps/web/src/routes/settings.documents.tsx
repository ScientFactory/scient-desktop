import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DocumentsSettings } from "../scient/documents/DocumentsSettings";

export const Route = createFileRoute("/settings/documents")({
  validateSearch: Schema.decodeUnknownSync(
    Schema.Struct({ environmentId: Schema.optionalKey(EnvironmentId) }),
  ),
  component: () => <DocumentsSettings environmentId={Route.useSearch().environmentId} />,
});
