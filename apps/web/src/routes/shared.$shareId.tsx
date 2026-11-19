import { createFileRoute } from "@tanstack/react-router";

import { SignedInSharePage } from "../scient/cloud/share/SignedInSharePage";

function SharedConversationRoute() {
  const { shareId } = Route.useParams();
  return <SignedInSharePage key={shareId} shareId={shareId} />;
}

export const Route = createFileRoute("/shared/$shareId")({
  component: SharedConversationRoute,
});
