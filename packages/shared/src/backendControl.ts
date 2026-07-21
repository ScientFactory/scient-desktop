export const SCIENT_BACKEND_SHUTDOWN_MESSAGE_TYPE = "scient.backend.shutdown";

export interface ScientBackendShutdownMessage {
  readonly type: typeof SCIENT_BACKEND_SHUTDOWN_MESSAGE_TYPE;
  readonly reason: string;
}

export function makeScientBackendShutdownMessage(reason: string): ScientBackendShutdownMessage {
  return {
    type: SCIENT_BACKEND_SHUTDOWN_MESSAGE_TYPE,
    reason,
  };
}

export function isScientBackendShutdownMessage(
  message: unknown,
): message is ScientBackendShutdownMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === SCIENT_BACKEND_SHUTDOWN_MESSAGE_TYPE &&
    "reason" in message &&
    typeof message.reason === "string"
  );
}
