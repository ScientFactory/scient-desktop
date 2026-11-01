import { createFileRoute } from "@tanstack/react-router";

import { DocumentsSettings } from "../scient/documents/DocumentsSettings";

export const Route = createFileRoute("/_chat/settings/documents")({
  component: DocumentsSettings,
});
