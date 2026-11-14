/**
 * Before inviting people to a thread on this computer: whether Scient Connect is ready, and the
 * one step that gets it there (sign in, turn on, try again, or free a computer slot). Shows nothing
 * on other computers or once setup is done; the server still checks reachability on create.
 */
import { useAuth } from "@clerk/react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useT3ConnectTurnOn } from "~/cloud/useT3ConnectTurnOn";
import { useT3ConnectAuthPrompt } from "~/components/clerk/useT3ConnectAuthPrompt";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  describeScientConnectHost,
  isScientConnectHostReady,
  useScientConnectHost,
} from "./connectHost";

/** False while this computer's own Scient Connect is still being set up or is off. */
export function useScientConnectInviteReady(environmentId: EnvironmentId): boolean {
  const status = useScientConnectHost(environmentId);
  return status === null || isScientConnectHostReady(status);
}

export function ScientConnectReadiness(props: {
  readonly environmentId: EnvironmentId;
  /** Closes the surrounding dialog before Settings opens. */
  readonly onLeave: () => void;
}) {
  const status = useScientConnectHost(props.environmentId);
  if (!hasCloudPublicConfig() || status === null || isScientConnectHostReady(status)) return null;
  return <Notice {...props} />;
}

function Notice({
  environmentId,
  onLeave,
}: {
  readonly environmentId: EnvironmentId;
  readonly onLeave: () => void;
}) {
  const status = useScientConnectHost(environmentId);
  const { isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const controller = useCloudLinkController(environmentId);
  const navigate = useNavigate();
  // Only the Scient app on that computer can set it up; elsewhere, just say what is happening.
  const actsHere = useT3ConnectTurnOn(environmentId).kind === "here";
  const [turningOn, setTurningOn] = useState(false);
  if (status === null) return null;

  const signedIn = isSignedIn === true;
  const busy =
    turningOn ||
    status.phase === "installing" ||
    status.phase === "linking" ||
    (signedIn && !status.off && status.phase === "needs-authorization");
  const turnOn = async () => {
    setTurningOn(true);
    await controller.reconcileCloudState({ managedTunnel: true, publish: false });
    setTurningOn(false);
  };
  const openSettings = () => {
    onLeave();
    void navigate({ to: "/settings/access" });
  };

  const action = !actsHere ? null : !signedIn ? (
    <Button size="xs" variant="outline" onClick={openAuthPrompt}>
      Sign in
    </Button>
  ) : busy ? null : status.phase === "blocked" && status.block?.reason === "limit" ? (
    <Button size="xs" variant="outline" onClick={openSettings}>
      Open Sharing & access
    </Button>
  ) : status.phase === "blocked" && status.block?.reason === "policy" ? null : (
    <Button size="xs" variant="outline" onClick={() => void turnOn()}>
      {status.off || status.block?.reason === "revoked" ? "Turn on" : "Try again"}
    </Button>
  );

  return (
    <div role="status" className="flex items-start gap-3 rounded-md border px-3 py-2 text-xs">
      {busy ? <Spinner className="mt-0.5 size-3.5 shrink-0" /> : null}
      <p className="min-w-0 flex-1 text-muted-foreground">
        {describeScientConnectHost(status, signedIn) ??
          "Scient Connect is setting up this computer…"}{" "}
        {status.off || !signedIn ? "People you invite reach this computer through it." : null}
      </p>
      {action}
    </div>
  );
}
