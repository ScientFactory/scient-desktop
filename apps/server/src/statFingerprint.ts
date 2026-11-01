// SCIENT-FORK:START shared-stat-fingerprint
export const statFingerprint = (stat: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
// SCIENT-FORK:END shared-stat-fingerprint
