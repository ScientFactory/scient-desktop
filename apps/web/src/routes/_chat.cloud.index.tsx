import { createFileRoute } from "@tanstack/react-router";

import { CloudConversationsPage } from "../scient/cloud/CloudReader";

export const Route = createFileRoute("/_chat/cloud/")({
  component: CloudConversationsPage,
});
