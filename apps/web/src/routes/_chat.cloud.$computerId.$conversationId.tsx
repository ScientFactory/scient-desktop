import { createFileRoute } from "@tanstack/react-router";

import { CloudConversationPage } from "../scient/cloud/CloudReader";

// Not `$environmentId/$threadId`: the chat layout reads those params as a local thread to show.
function CloudConversationRoute() {
  const { computerId, conversationId } = Route.useParams();
  return <CloudConversationPage environmentId={computerId} threadId={conversationId} />;
}

export const Route = createFileRoute("/_chat/cloud/$computerId/$conversationId")({
  component: CloudConversationRoute,
});
