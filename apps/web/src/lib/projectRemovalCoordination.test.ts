import { ProjectId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  finishProjectSend,
  hasActiveProjectSends,
  isProjectRemovalReserved,
  releaseProjectRemoval,
  reserveProjectRemoval,
  resetProjectRemovalCoordinationForTests,
  tryBeginProjectSend,
  waitForProjectSendsToDrain,
} from "./projectRemovalCoordination";

const PROJECT_ID = ProjectId.makeUnsafe("project-removal-coordination");

describe("project removal coordination", () => {
  afterEach(() => resetProjectRemovalCoordinationForTests());

  it("reserves synchronously, blocks new sends, and drains admitted send cleanup", async () => {
    const admittedSend = tryBeginProjectSend(PROJECT_ID);
    expect(admittedSend).not.toBeNull();
    expect(hasActiveProjectSends(PROJECT_ID)).toBe(true);
    const reservation = reserveProjectRemoval(PROJECT_ID);
    expect(reservation).not.toBeNull();
    expect(isProjectRemovalReserved(PROJECT_ID)).toBe(true);
    expect(tryBeginProjectSend(PROJECT_ID)).toBeNull();

    let drained = false;
    const drainPromise = waitForProjectSendsToDrain(reservation!).then((owned) => {
      drained = true;
      return owned;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finishProjectSend(admittedSend!);
    expect(hasActiveProjectSends(PROJECT_ID)).toBe(false);
    await expect(drainPromise).resolves.toBe(true);
    expect(tryBeginProjectSend(PROJECT_ID)).toBeNull();

    releaseProjectRemoval(reservation!);
    expect(isProjectRemovalReserved(PROJECT_ID)).toBe(false);
    const nextSend = tryBeginProjectSend(PROJECT_ID);
    expect(nextSend).not.toBeNull();
    finishProjectSend(nextSend!);
  });

  it("releases a waiter and send admission when removal is cancelled", async () => {
    const admittedSend = tryBeginProjectSend(PROJECT_ID)!;
    const reservation = reserveProjectRemoval(PROJECT_ID)!;
    const drainPromise = waitForProjectSendsToDrain(reservation);

    releaseProjectRemoval(reservation);
    await expect(drainPromise).resolves.toBe(false);
    finishProjectSend(admittedSend);

    const nextSend = tryBeginProjectSend(PROJECT_ID);
    expect(nextSend).not.toBeNull();
    finishProjectSend(nextSend!);
  });
});
