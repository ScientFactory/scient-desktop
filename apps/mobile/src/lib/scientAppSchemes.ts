/** URL schemes of the production, preview and development builds (app.config.ts). */
export const SCIENT_APP_SCHEMES = ["scient", "scient-preview", "scient-dev"] as const;

export function isScientAppProtocol(protocol: string): boolean {
  return SCIENT_APP_SCHEMES.some((scheme) => protocol === `${scheme}:`);
}
