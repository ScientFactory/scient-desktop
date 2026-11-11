import {
  buildEnvironmentScientCloudShare,
  completeEnvironmentScientCloudEnrollment,
  makeEnvironmentScientCloudEnrollmentProof,
  readEnvironmentScientCloudStatus,
  setEnvironmentScientCloudEnabled,
  stopEnvironmentScientCloud,
  takeOverEnvironmentScientCloudThread,
} from "@t3tools/client-runtime/state/scient-cloud";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  EnvironmentId,
  ScientCloudShareBuildRequest,
  ScientCloudTakeOverRequest,
} from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";
import type { CloudApi } from "./cloudApi";
import { markCloudConversationsAvailable } from "./cloudConversationsAvailable";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("That computer isn't connected right now.");
  return connection;
}

/** What a computer's server says about its cloud copy. */
export async function readCloudStatus(environmentId: EnvironmentId) {
  return runtime.runPromise(
    readEnvironmentScientCloudStatus({ prepared: prepared(environmentId) }),
  );
}

/**
 * Turns the cloud copy on for a computer: enrolls it with the signed-in person's account when it
 * isn't yet (the computer signs the proof with its own key), then flips its setting.
 */
export async function turnOnCloudCopy(input: {
  readonly environmentId: EnvironmentId;
  readonly userId: string;
  readonly api: CloudApi;
}) {
  const connection = prepared(input.environmentId);
  const status = await runtime.runPromise(
    readEnvironmentScientCloudStatus({ prepared: connection }),
  );
  if (status.enrolledUserId !== input.userId) {
    const nonce = await input.api.computerNonce();
    const proof = await runtime.runPromise(
      makeEnvironmentScientCloudEnrollmentProof({
        prepared: connection,
        payload: { nonce, userId: input.userId },
      }),
    );
    await input.api.enrollComputer({
      environmentId: proof.environmentId,
      label: proof.label,
      publicKey: proof.publicKey,
      proof: proof.proof,
    });
    await runtime.runPromise(
      completeEnvironmentScientCloudEnrollment({ prepared: connection, userId: input.userId }),
    );
  }
  const enabled = await runtime.runPromise(
    setEnvironmentScientCloudEnabled({ prepared: connection, enabled: true }),
  );
  markCloudConversationsAvailable(input.userId);
  return enabled;
}

export async function turnOffCloudCopy(environmentId: EnvironmentId) {
  return runtime.runPromise(
    setEnvironmentScientCloudEnabled({ prepared: prepared(environmentId), enabled: false }),
  );
}

/** Deletes every copy this computer made, then forgets its enrollment and turns copying off. */
export async function deleteCloudCopies(environmentId: EnvironmentId) {
  return runtime.runPromise(
    stopEnvironmentScientCloud({ prepared: prepared(environmentId), deleteCopies: true }),
  );
}

export async function buildShare(
  environmentId: EnvironmentId,
  request: ScientCloudShareBuildRequest,
) {
  return runtime.runPromise(
    buildEnvironmentScientCloudShare({ prepared: prepared(environmentId), payload: request }),
  );
}

/** Fetches one attachment the share build listed, from the computer that built it. */
export async function fetchShareBlob(environmentId: EnvironmentId, relativeUrl: string) {
  const url = resolveAssetUrl(prepared(environmentId).httpBaseUrl, relativeUrl);
  if (url === null) throw new Error("An attachment couldn't be read.");
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error("An attachment couldn't be read.");
  return new Uint8Array(await response.arrayBuffer());
}

export async function takeOverCloudThread(
  environmentId: EnvironmentId,
  request: ScientCloudTakeOverRequest,
) {
  return runtime.runPromise(
    takeOverEnvironmentScientCloudThread({ prepared: prepared(environmentId), payload: request }),
  );
}
