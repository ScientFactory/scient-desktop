const VOICE_OPERATION_FAILED_MESSAGE = "Voice operation failed. Try again.";

function sanitizeVoiceErrorMessage(message: string): string {
  const sanitized = message
    .trim()
    .replace(/\n\s*at\s+[\s\S]*$/u, "")
    .replace(
      /^(?:Error invoking remote method '[^']*':\s*|[A-Za-z][A-Za-z0-9_]*Error:\s*|Error:\s*)+/u,
      "",
    )
    .trim();
  return sanitized === "Voice messages must be between 1 ms and 180 seconds."
    ? "Record speech, up to 3 minutes."
    : sanitized;
}

export function describeVoiceError(error: unknown): string {
  if (error !== null && typeof error === "object" && "safeMessage" in error) {
    const safe = (error as { readonly safeMessage?: unknown }).safeMessage;
    if (typeof safe === "string" && safe.trim().length > 0)
      return sanitizeVoiceErrorMessage(safe) || VOICE_OPERATION_FAILED_MESSAGE;
  }
  if (error instanceof Error) {
    const sanitized = sanitizeVoiceErrorMessage(error.message);
    if (sanitized.length > 0) return sanitized;
  }
  return VOICE_OPERATION_FAILED_MESSAGE;
}
