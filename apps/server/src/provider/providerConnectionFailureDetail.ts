// FILE: providerConnectionFailureDetail.ts
// Purpose: Convert provider CLI output into curated, non-secret sign-in guidance.
// Layer: Provider server utility

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

function normalizedOutput(rawOutput: string): string {
  return Array.from(rawOutput.replace(ANSI_ESCAPE, ""), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code >= 0 && code <= 8) || (code >= 11 && code <= 31) || code === 127 ? " " : character;
  })
    .join("")
    .toLowerCase();
}

/**
 * Returns only authored messages. Raw CLI text is never reflected into the UI:
 * provider output can contain browser URLs, device codes, account identifiers,
 * filesystem paths, or credentials that heuristic redaction could miss.
 */
export function safeProviderConnectionFailureDetail(rawOutput: string): string | null {
  const output = normalizedOutput(rawOutput);
  if (output.trim().length === 0) return null;

  if (/rate.?limit|too many requests|status\s*429/u.test(output)) {
    return "The provider temporarily rate-limited sign-in. Wait a moment, then try again.";
  }
  if (
    /expired|device code.*(invalid|expired)|authorization code.*(invalid|expired)/u.test(output)
  ) {
    return "The authorization request expired. Start a fresh sign-in and try again.";
  }
  if (/eacces|permission denied|access is denied|read-only file system/u.test(output)) {
    return "The provider CLI could not update its local credentials. Check its file permissions and try again.";
  }
  if (
    /enotfound|econnrefused|econnreset|network|dns|socket|tls|certificate|unable to connect|could not connect|connection (?:failed|refused|timed out)/u.test(
      output,
    )
  ) {
    return "The provider CLI could not reach its sign-in service. Check your network and try again.";
  }
  if (
    /failed to open.*browser|could not open.*browser|browser.*not (?:found|available)/u.test(output)
  ) {
    return "The provider CLI could not open the sign-in page. Open the provider CLI and sign in there, then refresh Scient.";
  }
  if (/denied|rejected|cancel(?:led|ed)|access_denied/u.test(output)) {
    return "The provider rejected or cancelled the authorization request. Start a fresh sign-in and try again.";
  }
  if (
    /command not found|executable not found|missing dependency|no such file or directory/u.test(
      output,
    )
  ) {
    return "The provider CLI could not find a required local command or file. Repair the provider installation and try again.";
  }
  if (
    /unauthorized|invalid grant|invalid.*(?:token|credential|authorization)|authentication failed/u.test(
      output,
    )
  ) {
    return "The provider did not accept the authorization. Start a fresh sign-in and try again.";
  }

  return null;
}
