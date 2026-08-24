const VOICE_OPERATION_FAILED_MESSAGE = "Voice operation failed. Try again.";

export function sanitizeVoiceErrorMessage(message: string): string {
  return message
    .replace(/\n\s*at\s+[\s\S]*$/u, "")
    .replace(/^Error invoking remote method '[^']*':\s*/u, "")
    .replace(/^[A-Za-z][A-Za-z0-9_]*Error:\s*/u, "")
    .replace(/^(?:Error:\s*)+/u, "")
    .trim();
}

export function describeVoiceError(error: unknown): string {
  if (error !== null && typeof error === "object" && "safeMessage" in error) {
    const safe = (error as { readonly safeMessage?: unknown }).safeMessage;
    if (typeof safe === "string" && safe.trim().length > 0) return safe;
  }
  if (error instanceof Error) {
    const sanitized = sanitizeVoiceErrorMessage(error.message);
    if (sanitized.length > 0) return sanitized;
  }
  return VOICE_OPERATION_FAILED_MESSAGE;
}
