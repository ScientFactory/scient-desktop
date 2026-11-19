import {
  encodeAgentModelSlug,
  splitAgentModelSlug,
} from "@t3tools/provider-core/server/agentModel";

export const encodePiModelSlug = encodeAgentModelSlug;

export function decodePiModelSlug(
  slug: string,
): { readonly provider: string; readonly modelId: string } | undefined {
  const decoded = splitAgentModelSlug(slug);
  if (!decoded) return undefined;
  return encodePiModelSlug(decoded.provider, decoded.modelId) === slug ? decoded : undefined;
}

// The capability builder Pi model discovery uses (status.ts), for Scient callers outside the package.
export { piModelCapabilities } from "./modelCapabilities.ts";
