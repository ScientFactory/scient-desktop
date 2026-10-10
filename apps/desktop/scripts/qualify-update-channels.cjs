// Qualify the locked updater with synthetic GitHub feeds and loopback-only downloads.
// Native signature checks and installer execution require separate platform receipts.
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { realpathSync } = require("node:fs");
const { join } = require("node:path");
const requireScient = createRequire(
  realpathSync(join(__dirname, "../node_modules/electron-updater/package.json")),
);
const { GitHubProvider } = requireScient("./out/providers/GitHubProvider.js");
const { AppUpdater } = requireScient("./out/AppUpdater.js");
const { NsisUpdater } = requireScient("./out/NsisUpdater.js");
const { ElectronHttpExecutor } = requireScient("./out/electronHttpExecutor.js");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const crypto = require("node:crypto");
const semver = requireScient("semver");
const libraryVersion = requireScient("./package.json").version;
process.env.TEST_UPDATER_ARCH = "x64";

const stable = "v0.6.22";
const beta = "v0.6.23-beta.20261010.1";
const nextBeta = "v0.6.23-beta.20261010.2";
const preview = "v0.6.24-preview.20261010.1";
const nightly = "v0.6.24-nightly.20261010.1";
const alpha = "v0.6.24-alpha.1";
const promoted = "v0.6.23";
const atom = (tags) =>
  '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
  tags
    .map(
      (tag) =>
        `<entry><title>${tag}</title><link href="https://github.com/ScientFactory/scient-desktop/releases/tag/${tag}"/><content>synthetic notes</content></entry>`,
    )
    .join("") +
  "</feed>";

async function feedCase({
  name,
  channel,
  tags,
  expectedTag,
  expectedSuffix,
  latest = stable,
  platform = "darwin",
  current = "0.6.22",
}) {
  const requests = [];
  const executor = {
    request: async (options) => {
      requests.push(options.path);
      if (options.path.endsWith(".atom")) return atom(tags);
      if (options.path.includes("/releases/latest")) return JSON.stringify({ tag_name: latest });
      if (options.path.endsWith(".yml")) {
        const tag = decodeURIComponent(options.path.split("/").at(-2));
        // Stable releases carry latest manifests only. Beta releases carry beta manifests only.
        const manifest = options.path.split("/").at(-1);
        if (!tag.includes("-") && manifest.startsWith("beta"))
          throw new Error("synthetic missing beta manifest on stable release");
        return `version: ${tag.slice(1)}\nfiles: []\nreleaseName: Synthetic ${tag}\nreleaseNotes: Synthetic notes\n`;
      }
      throw new Error("Unexpected synthetic request: " + options.path);
    },
  };
  const updater = {
    channel,
    allowPrerelease: channel !== "latest",
    currentVersion: semver.parse(current),
    fullChangelog: false,
  };
  const provider = new GitHubProvider(
    { provider: "github", owner: "ScientFactory", repo: "scient-desktop" },
    updater,
    { executor, platform },
  );
  const info = await provider.getLatestVersion();
  assert.equal(info.tag, expectedTag, name);
  assert.ok(requests.at(-1).endsWith(expectedSuffix), name);
  return {
    name,
    platform,
    channel,
    selectedTag: info.tag,
    manifest: requests.at(-1).split("/").at(-1),
    requests,
  };
}

async function availabilityCase(name, current, target, allowDowngrade, expected) {
  const result = await AppUpdater.prototype.isUpdateAvailable.call(
    {
      currentVersion: semver.parse(current),
      allowDowngrade,
      isUpdateSupported: () => true,
      isUserWithinRollout: async () => true,
    },
    { version: target },
  );
  assert.equal(result, expected, name);
  return { name, current, target, allowDowngrade, available: result };
}

async function downloadPath() {
  const payload = Buffer.from("Synthetic installer fixture. Never executed.");
  const stablePayload = Buffer.from("Distinct promoted Stable installer fixture. Never executed.");
  const payloadForTag = (tag) => (tag === promoted ? stablePayload : payload);
  const requests = [];
  let corrupt = false;
  let stablePublished = stable;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url.endsWith(".atom")) {
      const tags = req.url.includes("scient-desktop-beta/")
        ? [nextBeta, beta]
        : [stablePublished, stable];
      res.end(atom(tags));
    } else if (req.url.includes("/releases/latest")) {
      res.end(JSON.stringify({ tag_name: stablePublished }));
    } else if (req.url.endsWith(".yml")) {
      const tag = req.url.split("/").at(-2);
      const selectedPayload = payloadForTag(tag);
      const sha512 = crypto.createHash("sha512").update(selectedPayload).digest("base64");
      res.end(
        `version: ${tag.slice(1)}\nfiles:\n  - url: Scient-${tag.slice(1)}-x64.exe\n    size: ${selectedPayload.length}\n    sha512: ${sha512}\n`,
      );
    } else if (req.url.endsWith(".exe")) {
      res.end(corrupt ? Buffer.from("corrupted") : payloadForTag(req.url.split("/").at(-2)));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const root = await fs.mkdtemp(join(os.tmpdir(), "scient-beta-update-path-"));
  await fs.writeFile(
    join(root, "app-update.yml"),
    "updaterCacheDirName: scient-beta-qualification\n",
  );
  class LoopbackExecutor extends ElectronHttpExecutor {
    createRequest(options, callback) {
      assert.equal(options.hostname, "127.0.0.1", "qualifier must never download external content");
      return http.request({ ...options, agent: false }, callback);
    }
  }
  const newUpdater = (current) => {
    const updater = new NsisUpdater(null, {
      version: current,
      name: "Scient Beta qualification",
      isPackaged: true,
      appUpdateConfigPath: join(root, "app-update.yml"),
      userDataPath: join(root, current),
      baseCachePath: join(root, current, "cache"),
      whenReady: async () => {},
      relaunch: () => {
        throw new Error("Unexpected native relaunch");
      },
      quit: () => {
        throw new Error("Unexpected native quit");
      },
      onQuit: () => {},
    });
    updater.httpExecutor = new LoopbackExecutor();
    updater._testOnlyOptions = { platform: "win32" };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.disableWebInstaller = true;
    updater.logger = null;
    return updater;
  };
  const select = (updater, channel) => {
    updater.setFeedURL({
      provider: "github",
      owner: "ScientFactory",
      repo: channel === "beta" ? "scient-desktop-beta" : "scient-desktop",
      host: `127.0.0.1:${address.port}`,
      protocol: "http",
    });
    updater.channel = channel;
    updater.allowPrerelease = channel === "beta";
    updater.allowDowngrade = false;
  };
  try {
    const updater = newUpdater(stable.slice(1));
    select(updater, "beta");
    let offered = null;
    let downloaded = null;
    updater.on("update-available", (info) => {
      offered = info.version;
    });
    updater.on("update-downloaded", (info) => {
      downloaded = info.version;
    });
    const check = await updater.checkForUpdates();
    assert.equal(check.updateInfo.version, nextBeta.slice(1));
    assert.equal(offered, nextBeta.slice(1));
    const files = await updater.downloadUpdate();
    assert.deepEqual(await fs.readFile(files[0]), payload);
    assert.equal(downloaded, nextBeta.slice(1));
    const downloadsBeforeCacheHit = requests.filter((request) => request.endsWith(".exe")).length;
    const cachedFiles = await updater.downloadUpdate();
    assert.deepEqual(await fs.readFile(cachedFiles[0]), payload);
    assert.equal(
      requests.filter((request) => request.endsWith(".exe")).length,
      downloadsBeforeCacheHit,
      "a verified cached Beta must not download again",
    );
    const betaUpdater = newUpdater(beta.slice(1));
    select(betaUpdater, "beta");
    assert.equal((await betaUpdater.checkForUpdates()).updateInfo.version, nextBeta.slice(1));
    const newerBetaFiles = await betaUpdater.downloadUpdate();
    assert.deepEqual(await fs.readFile(newerBetaFiles[0]), payload);
    let noUpdate = false;
    betaUpdater.on("update-not-available", () => {
      noUpdate = true;
    });
    select(betaUpdater, "latest");
    assert.equal((await betaUpdater.checkForUpdates()).updateInfo.version, stable.slice(1));
    assert.equal(noUpdate, true, "return to Stable must wait rather than downgrade");
    stablePublished = promoted;
    assert.equal((await betaUpdater.checkForUpdates()).updateInfo.version, promoted.slice(1));
    assert.equal(betaUpdater.allowDowngrade, false);
    const stableFiles = await betaUpdater.downloadUpdate();
    assert.deepEqual(await fs.readFile(stableFiles[0]), stablePayload);
    assert.ok(
      requests.some(
        (request) =>
          request.startsWith(`/ScientFactory/scient-desktop/releases/download/${promoted}/`) &&
          request.endsWith(".exe"),
      ),
      "return to Stable must download from its canonical repository",
    );
    const corruptUpdater = newUpdater("0.6.21");
    select(corruptUpdater, "beta");
    await corruptUpdater.checkForUpdates();
    corrupt = true;
    await assert.rejects(corruptUpdater.downloadUpdate(), /checksum mismatch/);
    corrupt = false;
    const retryFiles = await corruptUpdater.downloadUpdate();
    assert.deepEqual(await fs.readFile(retryFiles[0]), payload);
    return {
      name: "Loopback discovery, download, cache, checksum rejection and feed changes",
      downloadVerified: true,
      cacheVerified: true,
      betaToBetaDownloadVerified: true,
      betaToStableDownloadVerified: true,
      corruptDownloadRejected: true,
      downloadRetryVerified: true,
      nativeInstall: false,
      requests,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

(async () => {
  const cases = [];
  for (const platform of ["darwin", "win32", "linux"]) {
    const suffix = platform === "darwin" ? "-mac" : platform === "linux" ? "-linux" : "";
    cases.push(
      await feedCase({
        name: "Stable ignores all prereleases",
        channel: "latest",
        tags: [preview, nightly, alpha, nextBeta, beta, stable],
        expectedTag: stable,
        expectedSuffix: `latest${suffix}.yml`,
        platform,
      }),
    );
    cases.push(
      await feedCase({
        name: "Beta skips preview/nightly/alpha",
        channel: "beta",
        tags: [preview, nightly, alpha, nextBeta, beta, stable],
        expectedTag: nextBeta,
        expectedSuffix: `beta${suffix}.yml`,
        platform,
      }),
    );
    cases.push(
      await feedCase({
        name: "Legacy nightly feed stays isolated from beta/preview/stable",
        channel: "nightly",
        tags: [preview, promoted, alpha, nextBeta, nightly, stable],
        expectedTag: nightly,
        expectedSuffix: `nightly${suffix}.yml`,
        platform,
      }),
    );
    cases.push(
      await feedCase({
        name: "Beta accepts newer stable through latest-manifest fallback",
        channel: "beta",
        tags: [preview, promoted, nightly, beta, stable],
        expectedTag: promoted,
        expectedSuffix: `latest${suffix}.yml`,
        platform,
        current: beta.slice(1),
        latest: promoted,
      }),
    );
  }
  cases.push(
    await availabilityCase(
      "Normal beta checks do not regress to older stable",
      beta.slice(1),
      stable.slice(1),
      false,
      false,
    ),
  );
  cases.push(
    await availabilityCase(
      "Inherited nightly-style downgrade flag would offer older stable",
      beta.slice(1),
      stable.slice(1),
      true,
      true,
    ),
  );
  cases.push(
    await availabilityCase(
      "Promotion from beta to matching stable is an upgrade",
      beta.slice(1),
      promoted.slice(1),
      false,
      true,
    ),
  );
  cases.push(
    await availabilityCase(
      "Later beta is an upgrade",
      beta.slice(1),
      nextBeta.slice(1),
      false,
      true,
    ),
  );
  cases.push(await downloadPath());
  console.log(
    JSON.stringify(
      { libraryVersion, synthetic: true, network: "loopback only", nativeInstall: false, cases },
      null,
      2,
    ),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
