import { createFileRoute } from "@tanstack/react-router";

import { ScientGettingStartedFlow } from "../scient/onboarding/ScientGettingStartedFlow";

function GettingStartedRoute() {
  return <ScientGettingStartedFlow mode="manual" />;
}

export const Route = createFileRoute("/_chat/getting-started")({
  component: GettingStartedRoute,
});
