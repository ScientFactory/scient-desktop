/**
 * The one LibreOffice build Document Lab jobs are qualified with. Sizes and digests are the
 * archive's published SHA-256 at download time; provisioning rejects any other bytes, and the
 * server refuses a receipt naming another version or build. Repin and requalify every target
 * together. Targets without an entry stay unavailable rather than borrowing another build.
 */

export type OfficePlatformArch = "darwin-arm64" | "darwin-x64" | "win32-x64" | "linux-x64";

export interface OfficeAsset {
  readonly fileName: string;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** `dmg` is copied out of the mounted image, `msi` is unpacked by an administrative install, `deb-tar` is unpacked from its packages. */
  readonly archive: "dmg" | "msi" | "deb-tar";
}

const VERSION = "26.2.4.2";
const BASE = `https://downloadarchive.documentfoundation.org/libreoffice/old/${VERSION}`;

export const OFFICE_TOOLCHAIN = {
  engine: "LibreOffice",
  version: VERSION,
  /** The source revision `soffice --version` prints after the version. */
  buildId: "0229ac93fcf0d7cbc6376066c6f35021cef002dc",
  license: "MPL-2.0",
  sourceUrl: `${BASE}/src/`,
  allowedHosts: ["downloadarchive.documentfoundation.org"],
  assets: {
    "darwin-arm64": {
      fileName: `LibreOffice_${VERSION}_MacOS_aarch64.dmg`,
      url: `${BASE}/mac/aarch64/LibreOffice_${VERSION}_MacOS_aarch64.dmg`,
      sha256: "64e0ad05564554eeee639d49b08b20908a38d4722ec95f1620d05c99bcbe9fb1",
      sizeBytes: 295_019_039,
      archive: "dmg",
    },
    "darwin-x64": {
      fileName: `LibreOffice_${VERSION}_MacOS_x86-64.dmg`,
      url: `${BASE}/mac/x86_64/LibreOffice_${VERSION}_MacOS_x86-64.dmg`,
      sha256: "f92ba40fdada173232fe929bf77973a1ffcccec55ae7971957a6de84d33f0f1e",
      sizeBytes: 305_573_151,
      archive: "dmg",
    },
    "win32-x64": {
      fileName: `LibreOffice_${VERSION}_Win_x86-64.msi`,
      url: `${BASE}/win/x86_64/LibreOffice_${VERSION}_Win_x86-64.msi`,
      sha256: "202f26cda071c5aa4996a5a28412fddceb3891dceb0366982c62650456c0730f",
      sizeBytes: 372_539_392,
      archive: "msi",
    },
    "linux-x64": {
      fileName: `LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz`,
      url: `${BASE}/deb/x86_64/LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz`,
      sha256: "810ef197e190d7804a60e0016052c46ff33792303a200fddda9d5216a64b9900",
      sizeBytes: 217_982_126,
      archive: "deb-tar",
    },
  } satisfies Readonly<Record<OfficePlatformArch, OfficeAsset>>,
} as const;

export const officePlatformArch = (
  platform: string,
  arch: string,
): OfficePlatformArch | undefined => {
  const key = `${platform}-${arch}`;
  return key in OFFICE_TOOLCHAIN.assets ? (key as OfficePlatformArch) : undefined;
};

/** `soffice --version` output of the pinned build, exactly. */
export const isPinnedOfficeVersion = (output: string): boolean =>
  output.trim().split(/\s+/u).slice(0, 3).join(" ") ===
  `${OFFICE_TOOLCHAIN.engine} ${OFFICE_TOOLCHAIN.version} ${OFFICE_TOOLCHAIN.buildId}`;
