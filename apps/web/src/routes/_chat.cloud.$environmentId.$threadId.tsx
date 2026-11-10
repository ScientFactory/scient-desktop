import { createFileRoute } from "@tanstack/react-router";

import { CloudConversationPage } from "../scient/cloud/CloudReader";

function CloudConversationRoute() {
  const { environmentId, threadId } = Route.useParams();
  return <CloudConversationPage environmentId={environmentId} threadId={threadId} />;
}

export const Route = createFileRoute("/_chat/cloud/$environmentId/$threadId")({
  component: CloudConversationRoute,
});
