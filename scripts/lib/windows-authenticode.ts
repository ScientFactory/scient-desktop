export interface WindowsAuthenticodeSignatureDetails {
  readonly signerSubject: string | null;
  readonly signerThumbprint: string | null;
  readonly status: string;
  readonly statusMessage: string;
  readonly timestampSubject: string | null;
}

export const WINDOWS_AUTHENTICODE_READER_FUNCTION_LINES = [
  "function Read-AuthenticodeSignature([string]$Path) {",
  "  $Signature = Get-AuthenticodeSignature -LiteralPath $Path",
  "  [pscustomobject]@{",
  "    status = [string]$Signature.Status",
  "    statusMessage = [string]$Signature.StatusMessage",
  "    signerSubject = if ($null -eq $Signature.SignerCertificate) { $null } else { [string]$Signature.SignerCertificate.Subject }",
  "    signerThumbprint = if ($null -eq $Signature.SignerCertificate) { $null } else { [string]$Signature.SignerCertificate.Thumbprint }",
  "    timestampSubject = if ($null -eq $Signature.TimeStamperCertificate) { $null } else { [string]$Signature.TimeStamperCertificate.Subject }",
  "  }",
  "}",
] as const;

export function isWindowsAuthenticodeSignatureDetails(
  value: unknown,
): value is WindowsAuthenticodeSignatureDetails {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WindowsAuthenticodeSignatureDetails>;
  return (
    typeof candidate.status === "string" &&
    typeof candidate.statusMessage === "string" &&
    (typeof candidate.signerSubject === "string" || candidate.signerSubject === null) &&
    (typeof candidate.signerThumbprint === "string" || candidate.signerThumbprint === null) &&
    (typeof candidate.timestampSubject === "string" || candidate.timestampSubject === null)
  );
}

function nonEmptySignatureValue(value: string | null, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is missing.`);
  return normalized;
}

export function assertValidTimestampedWindowsAuthenticodeSignature(
  signature: WindowsAuthenticodeSignatureDetails,
  label: string,
): { readonly signerSubject: string; readonly signerThumbprint: string } {
  if (signature.status !== "Valid") {
    throw new Error(
      `${label} Authenticode signature is not valid (${signature.status}: ${signature.statusMessage}).`,
    );
  }
  nonEmptySignatureValue(signature.timestampSubject, `${label} timestamp signer`);
  return {
    signerSubject: nonEmptySignatureValue(signature.signerSubject, `${label} signer subject`),
    signerThumbprint: nonEmptySignatureValue(
      signature.signerThumbprint,
      `${label} signer thumbprint`,
    ),
  };
}
