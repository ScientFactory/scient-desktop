import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

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
  const openNewThread = useNewThreadHandler();
  return (
    <WelcomeWizard
      localAvailable={false}
      onDone={(projectRef) => {
        if (projectRef !== undefined) {
          void openNewThread(projectRef, { replace: true }).catch(() => {
            void navigate({ to: "/", replace: true });
          });
          return;
        }
        void navigate({ to: "/", replace: true });
      }}
    />
  );
}
