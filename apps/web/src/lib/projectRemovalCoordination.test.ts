import { ProjectId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  finishProjectOperation,
  hasActiveProjectOperations,
  isProjectRemovalReserved,
  releaseProjectRemoval,
  reserveProjectRemoval,
  resetProjectRemovalCoordinationForTests,
  tryBeginProjectOperation,
  waitForProjectOperationsToDrain,
} from "./projectRemovalCoordination";

const PROJECT_ID = ProjectId.makeUnsafe("project-removal-coordination");

describe("project removal coordination", () => {
  afterEach(() => resetProjectRemovalCoordinationForTests());

  it("reserves synchronously, blocks new operations, and drains the admitted operation", async () => {
    const admittedOperation = tryBeginProjectOperation(PROJECT_ID);
    expect(admittedOperation).not.toBeNull();
    expect(hasActiveProjectOperations(PROJECT_ID)).toBe(true);
    const reservation = reserveProjectRemoval(PROJECT_ID);
    expect(reservation).not.toBeNull();
    expect(isProjectRemovalReserved(PROJECT_ID)).toBe(true);
    expect(tryBeginProjectOperation(PROJECT_ID)).toBeNull();

    let drained = false;
    const drainPromise = waitForProjectOperationsToDrain(reservation!).then((owned) => {
      drained = true;
      return owned;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finishProjectOperation(admittedOperation!);
    expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false);
    await expect(drainPromise).resolves.toBe(true);
    expect(tryBeginProjectOperation(PROJECT_ID)).toBeNull();

    releaseProjectRemoval(reservation!);
    expect(isProjectRemovalReserved(PROJECT_ID)).toBe(false);
    const nextOperation = tryBeginProjectOperation(PROJECT_ID);
    expect(nextOperation).not.toBeNull();
    finishProjectOperation(nextOperation!);
  });

  it("waits for every concurrent operation to finish before draining", async () => {
    const first = tryBeginProjectOperation(PROJECT_ID)!;
    const second = tryBeginProjectOperation(PROJECT_ID)!;
    const third = tryBeginProjectOperation(PROJECT_ID)!;
    const reservation = reserveProjectRemoval(PROJECT_ID)!;

    let drained = false;
    const drainPromise = waitForProjectOperationsToDrain(reservation).then((owned) => {
      drained = true;
      return owned;
    });

    finishProjectOperation(first);
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(hasActiveProjectOperations(PROJECT_ID)).toBe(true);

    finishProjectOperation(second);
    await Promise.resolve();
    expect(drained).toBe(false);

    finishProjectOperation(third);
    expect(hasActiveProjectOperations(PROJECT_ID)).toBe(false);
    await expect(drainPromise).resolves.toBe(true);
  });

  it("releases a waiter and operation admission when removal is cancelled", async () => {
    const admittedOperation = tryBeginProjectOperation(PROJECT_ID)!;
    const reservation = reserveProjectRemoval(PROJECT_ID)!;
    const drainPromise = waitForProjectOperationsToDrain(reservation);

    releaseProjectRemoval(reservation);
    await expect(drainPromise).resolves.toBe(false);
    finishProjectOperation(admittedOperation);

    const nextOperation = tryBeginProjectOperation(PROJECT_ID);
    expect(nextOperation).not.toBeNull();
    finishProjectOperation(nextOperation!);
  });
});
