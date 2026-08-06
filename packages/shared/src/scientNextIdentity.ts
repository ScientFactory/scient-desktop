/**
 * Scient's product label plus the collision-safe candidate runtime identity.
 *
 * Keep this small, explicit, and separate from T3's internal package names.
 * It is the boundary that prevents the private candidate from colliding with
 * an installed T3 Code build or the current Scient desktop build.
 */
export const SCIENT_NEXT_IDENTITY = {
  baseName: "Scient",
  developmentName: "Scient (Dev)",
  appId: "com.scientfactory.scient.next",
  developmentAppId: "com.scientfactory.scient.next.dev",
  baseDirName: ".scient-next",
  productionScheme: "scient-next",
  developmentScheme: "scient-next-dev",
  productionUserDataDirName: "scient-next",
  developmentUserDataDirName: "scient-next-dev",
  linuxDesktopEntryName: "scient-next.desktop",
  linuxDevelopmentDesktopEntryName: "scient-next-dev.desktop",
  linuxWmClass: "scient-next",
  linuxDevelopmentWmClass: "scient-next-dev",
  previewPartitionPrefix: "persist:scient-next-preview-",
  clientSettingsStorageKey: "scient-next:client-settings:v1",
  safetyEnvelopeMarker: "true",
  safetyEnvelopeEnabled: true,
  cloudEnabled: false,
  autoUpdateEnabled: false,
  outboundTelemetryEnabled: false,
} as const;

export type ScientNextIdentity = typeof SCIENT_NEXT_IDENTITY;
