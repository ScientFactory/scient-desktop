import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/settings/voice")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/transcription", search: true, hash: true, replace: true });
  },
});
