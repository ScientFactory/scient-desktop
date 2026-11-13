export interface AntigravityReleaseAsset {
  readonly version: string;
  // SCIENT-FORK:START — Scient's qualified catalog records the registry revision it installed.
  /** The official registry's ordered release version, distinct from native agentInfo.version. */
  readonly registryVersion?: string;
  // SCIENT-FORK:END
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: {
    readonly name: string;
    readonly bytes: number;
  };
  readonly harness: {
    readonly name: string;
    readonly bytes: number;
  };
}
