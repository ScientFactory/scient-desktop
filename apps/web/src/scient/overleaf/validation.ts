import type { ScientOverleafOperationSnapshot } from "@t3tools/contracts";

const AUTHOR_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function overleafAuthorEmailError(value: string): string | null {
  const email = value.trim();
  if (email.length === 0) return "Enter the email address used for your Overleaf identity.";
  if (!AUTHOR_EMAIL_PATTERN.test(email))
    return "Enter a complete email address, such as name@example.com.";
  return null;
}

export function overleafOperationFailureMessage(
  operation: ScientOverleafOperationSnapshot | null,
): string | null {
  if (operation === null || !["failed", "interrupted"].includes(operation.phase)) return null;
  return operation.message.trim() || "The Overleaf operation could not be completed.";
}
