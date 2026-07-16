// FILE: _chat.worldcup.tsx
// Purpose: Redirects retired World Cup bookmarks to the PapiLab home surface.
// Layer: Routing compatibility

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/worldcup")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
