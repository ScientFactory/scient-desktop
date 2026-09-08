import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";

/**
 * Hosted connection wizard, outside the sidebar shell like /pair.
 * Authenticated local clients retain Scient's existing assisted setup.
 */
export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status === "authenticated") {
      throw redirect({ to: "/getting-started", replace: true });
    }
    if (authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const navigate = useNavigate();
  // The root shell can remount this pending outlet after the location changes.
  // Never reopen setup while the destination route is still loading.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  const openNewThread = useNewThreadHandler();
  return (
    <>
      <NoProjectsHero />
      {isWelcomeRoute && !dismissed ? (
        <WelcomeWizard
          localAvailable={false}
          onDone={(projectRef) => {
            setDismissed(true);
            if (projectRef !== undefined) {
              void openNewThread(projectRef, { replace: true }).catch(() => {
                void navigate({ to: "/", replace: true });
              });
              return;
            }
            void navigate({ to: "/", replace: true });
          }}
        />
      ) : null}
    </>
  );
}
