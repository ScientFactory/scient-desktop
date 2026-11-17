import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import type * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import { httpDeliveryTarget } from "./DesktopUpdateFactsHttpDelivery.ts";

const snapshot = (ready: boolean): DesktopBackendManager.DesktopBackendSnapshot => ({
  desiredRunning: true,
  ready,
  activePid: Option.some(1),
  restartAttempt: 0,
  restartScheduled: false,
});

const config = (controlFd: number | undefined) =>
  Option.some({
    httpBaseUrl: new URL("http://172.20.0.2:3774"),
    bootstrap: { desktopTelemetryControlFd: controlFd },
  } as unknown as DesktopBackendManager.DesktopBackendStartConfig);

describe("httpDeliveryTarget", () => {
  it("delivers over HTTP only to a ready primary without the telemetry pipe", () => {
    assert.deepEqual(
      httpDeliveryTarget(snapshot(true), config(undefined)).pipe(Option.map(String)),
      Option.some("http://172.20.0.2:3774/"),
    );
    // A primary with the pipe takes facts there.
    assert.isTrue(Option.isNone(httpDeliveryTarget(snapshot(true), config(5))));
    assert.isTrue(Option.isNone(httpDeliveryTarget(snapshot(false), config(undefined))));
    assert.isTrue(Option.isNone(httpDeliveryTarget(snapshot(true), Option.none())));
  });
});
