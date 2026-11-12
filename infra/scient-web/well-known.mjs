// Writes the phone app's link files into the hosted build: node well-known.mjs <dist>.
// App IDs come from apps/web/public/.well-known (checked by apps/mobile/app.config.test.ts).
// Android fingerprints are never committed: SCIENT_ANDROID_SHA256_* hold them, comma-separated,
// and a package without one is left out rather than trusting the wrong signing key.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const FINGERPRINT_VARIABLES = {
  production: "SCIENT_ANDROID_SHA256_PRODUCTION",
  preview: "SCIENT_ANDROID_SHA256_PREVIEW",
  development: "SCIENT_ANDROID_SHA256_DEV",
};
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const SCIENT_PACKAGE_PREFIX = "com.scientfactory.";

const variantOf = (packageName) =>
  packageName.endsWith(".preview")
    ? "preview"
    : packageName.endsWith(".dev")
      ? "development"
      : "production";

function fingerprints(variant) {
  const name = FINGERPRINT_VARIABLES[variant];
  const values = (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  for (const value of values) {
    if (!FINGERPRINT.test(value)) {
      throw new Error(`${name} holds "${value}", not a colon-separated SHA-256 fingerprint.`);
    }
  }
  return values;
}

const [dist] = process.argv.slice(2);
if (!dist) throw new Error("Usage: node infra/scient-web/well-known.mjs <dist directory>");
const source = NodePath.join(import.meta.dirname, "../../apps/web/public/.well-known");
const target = NodePath.join(dist, ".well-known");
const readJson = (name) => JSON.parse(NodeFS.readFileSync(NodePath.join(source, name), "utf8"));

// Only Scient's own identifiers are served from app.scientfactory.com.
const isScientPackage = (identifier) => identifier.startsWith(SCIENT_PACKAGE_PREFIX);
const isScientAppID = (appID) => isScientPackage(appID.slice(appID.indexOf(".") + 1));
const warnDropped = (identifiers) => {
  if (identifiers.length > 0) console.warn(`Not Scient's, left out: ${identifiers.join(", ")}`);
};

const sourceDetails = readJson("apple-app-site-association.json").applinks.details;
warnDropped(sourceDetails.flatMap((detail) => detail.appIDs.filter((id) => !isScientAppID(id))));
const details = sourceDetails
  .map((detail) => ({ ...detail, appIDs: detail.appIDs.filter(isScientAppID) }))
  .filter((detail) => detail.appIDs.length > 0);
const appIDs = [...new Set(details.flatMap((detail) => detail.appIDs))];
const appleAppSiteAssociation = { applinks: { details }, webcredentials: { apps: appIDs } };

const sourceLinks = readJson("assetlinks.json");
warnDropped(
  sourceLinks.map((link) => link.target.package_name).filter((name) => !isScientPackage(name)),
);
const assetLinks = sourceLinks.flatMap((link) => {
  if (!isScientPackage(link.target.package_name)) return [];
  const variant = variantOf(link.target.package_name);
  const sha256 = fingerprints(variant);
  if (sha256.length === 0) {
    console.warn(
      `${link.target.package_name}: ${FINGERPRINT_VARIABLES[variant]} is unset; its links stay unverified.`,
    );
    return [];
  }
  return [{ ...link, target: { ...link.target, sha256_cert_fingerprints: sha256 } }];
});

NodeFS.rmSync(target, { recursive: true, force: true });
NodeFS.mkdirSync(target, { recursive: true });
const aasa = `${JSON.stringify(appleAppSiteAssociation, null, 2)}\n`;
// Apple fetches the extensionless path; _headers gives both paths a JSON content type.
NodeFS.writeFileSync(NodePath.join(target, "apple-app-site-association"), aasa);
NodeFS.writeFileSync(NodePath.join(target, "apple-app-site-association.json"), aasa);
NodeFS.writeFileSync(
  NodePath.join(target, "assetlinks.json"),
  `${JSON.stringify(assetLinks, null, 2)}\n`,
);
console.log(`Apple app IDs: ${appIDs.join(", ") || "none"}`);
console.log(
  `Android packages: ${assetLinks.map((link) => link.target.package_name).join(", ") || "none"}`,
);
