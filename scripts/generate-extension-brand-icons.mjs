#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const pack = new URL("apps/server/src/scient/extensions/brandIcons/", root);
const listPath = new URL("scient-extension-brands.json", import.meta.url);
const brands = JSON.parse(await NodeFSP.readFile(listPath, "utf8"));
const curated = JSON.parse(
  await NodeFSP.readFile(new URL("../discover/curatedIcons.json", pack), "utf8"),
);
const normalize = (name) => name.trim().toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
const fetchResource = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 5_000_000) throw new Error(`Image too large: ${url}`);
  return bytes;
};
// Sharp does not decode ICO containers; decode their embedded PNG or uncompressed DIB.
const decodeIcon = async (bytes) => {
  if (bytes.readUInt32LE(0) !== 0x00010000) return bytes;
  const entries = Array.from({ length: bytes.readUInt16LE(4) }, (_, i) => {
    const offset = 6 + i * 16;
    return {
      size: (bytes[offset] || 256) * (bytes[offset + 1] || 256),
      data: bytes.subarray(
        bytes.readUInt32LE(offset + 12),
        bytes.readUInt32LE(offset + 12) + bytes.readUInt32LE(offset + 8),
      ),
    };
  }).sort((a, b) => b.size - a.size);
  for (const { data } of entries) {
    if (data.subarray(1, 4).toString() === "PNG") return data;
    if (
      data.length < 40 ||
      ![1, 4, 8, 24, 32].includes(data.readUInt16LE(14)) ||
      data.readUInt32LE(16) !== 0
    )
      continue;
    const width = data.readInt32LE(4);
    const height = data.readInt32LE(8) / 2;
    if (width <= 0 || height <= 0 || width > 256 || height > 256) continue;
    const bits = data.readUInt16LE(14);
    const header = data.readUInt32LE(0);
    const paletteSize = bits <= 8 ? (data.readUInt32LE(32) || 2 ** bits) * 4 : 0;
    const start = header + paletteSize;
    const stride = Math.ceil((width * bits) / 32) * 4;
    const maskStride = Math.ceil(width / 32) * 4;
    if (data.length < start + stride * height) continue;
    const rgba = Buffer.alloc(width * height * 4);
    let alpha = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const row = start + (height - y - 1) * stride;
        let from = row + x * (bits / 8);
        if (bits <= 8) {
          const value = data[row + Math.floor((x * bits) / 8)];
          const index = (value >> (8 - bits - ((x * bits) % 8))) & ((1 << bits) - 1);
          from = header + index * 4;
        }
        const to = (y * width + x) * 4;
        rgba[to] = data[from + 2];
        rgba[to + 1] = data[from + 1];
        rgba[to + 2] = data[from];
        rgba[to + 3] = bits === 32 ? data[from + 3] : 255;
        alpha ||= bits === 32 && data[from + 3] !== 0;
      }
    }
    if (!alpha) {
      const maskStart = start + stride * height;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const mask = data[maskStart + (height - y - 1) * maskStride + Math.floor(x / 8)] ?? 0;
          rgba[(y * width + x) * 4 + 3] = mask & (0x80 >> (x % 8)) ? 0 : 255;
        }
      }
    }
    return sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
  }
  throw new Error("No supported image in ICO container");
};
const image = async (url) => {
  const bytes = await decodeIcon(await fetchResource(url));
  const png = await sharp(bytes, { animated: false })
    .resize(64, 64, { fit: "contain", background: "#00000000" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const stats = await sharp(png).stats();
  if (stats.isOpaque && stats.entropy < 0.1) throw new Error(`Blank icon: ${url}`);
  if (stats.channels[3]?.max === 0) throw new Error(`Transparent icon: ${url}`);
  const data = `data:image/png;base64,${png.toString("base64")}`;
  if (data.length > 90_000) throw new Error(`Icon exceeds contract: ${url}`);
  return data;
};
const siteIcons = async (website) => {
  const html = (await fetchResource(website)).toString("utf8");
  const candidates = [];
  const attribute = (tag, name) =>
    tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(tag[0], "rel") ?? "";
    const href = attribute(tag[0], "href");
    if (!href) continue;
    const url = new URL(href.replaceAll("&amp;", "&"), website).href;
    if (/\bicon\b/.test(rel)) {
      const size = Number(attribute(tag[0], "sizes")?.split("x")[0]) || 0;
      candidates.push({ url, rank: (/apple-touch-icon/.test(rel) ? 1000 : 0) + size });
    }
    if (rel === "manifest") {
      try {
        const manifest = JSON.parse((await fetchResource(url)).toString("utf8"));
        for (const item of manifest.icons ?? []) {
          candidates.push({
            url: new URL(item.src, url).href,
            rank: Number(item.sizes?.split("x")[0]) || 0,
          });
        }
      } catch {
        // A broken web manifest must not hide valid declared icons.
      }
    }
  }
  return [
    ...candidates.sort((a, b) => b.rank - a.rank).map((item) => item.url),
    new URL("/apple-touch-icon.png", website).href,
    new URL("/favicon.ico", website).href,
  ];
};
const icons = {};
const aliases = {};
const missing = [];
let cursor = 0;
await NodeFSP.mkdir(pack, { recursive: true });
await NodeFSP.mkdir(new URL(".logs/", root), { recursive: true });
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (cursor < brands.length) {
      const brand = brands[cursor++];
      if (brand.omitted) continue;
      let data = curated[brand.key];
      if (data) brand.source = { kind: "curated", key: brand.key };
      if (!data && brand.source?.url) {
        try {
          data = await image(brand.source.url);
        } catch (error) {
          console.error(brand.key, String(error));
        }
      }
      if (!data && brand.website) {
        try {
          for (const url of await siteIcons(brand.website)) {
            try {
              data = await image(url);
              brand.source = { kind: "website", url };
              break;
            } catch {
              /* Try the next declared icon. */
            }
          }
        } catch (error) {
          console.error(brand.key, String(error));
        }
      }
      if (!data) {
        console.error("MISSING", brand.key);
        missing.push(brand.key);
        continue;
      }
      if (!curated[brand.key]) icons[brand.key] = data;
      for (const name of [brand.key, ...brand.names]) {
        const key = normalize(name);
        if (aliases[key] && aliases[key] !== brand.key) throw new Error(`Ambiguous alias: ${key}`);
        aliases[key] = brand.key;
      }
      console.log(brand.key, brand.source.kind);
    }
  }),
);
if (missing.length) throw new Error(`Missing active brands: ${missing.join(", ")}`);
const sorted = (record) =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
const bytes = Buffer.byteLength(JSON.stringify(icons)) + Buffer.byteLength(JSON.stringify(curated));
if (bytes > 1_500_000) throw new Error(`Pack exceeds 1.5 MB: ${bytes}`);
await NodeFSP.writeFile(
  new URL("brandIcons.json", pack),
  JSON.stringify(sorted(icons), null, 2) + "\n",
);
await NodeFSP.writeFile(
  new URL("aliases.json", pack),
  JSON.stringify(sorted(aliases), null, 2) + "\n",
);
await NodeFSP.writeFile(listPath, JSON.stringify(brands, null, 2) + "\n");
const escape = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const shipped = brands.filter((brand) => aliases[normalize(brand.key)]);
const html = `<!doctype html><meta charset="utf-8"><title>Scient extension brand icons</title>
<style>body{font:14px system-ui;background:#eee;color:#111}main{display:grid;grid-template-columns:repeat(8,1fr);gap:12px}figure{margin:0;padding:12px;background:white;text-align:center;overflow-wrap:anywhere}img{width:64px;height:64px;object-fit:contain}.dark{background:#222;border-radius:8px}small{display:block;color:#555}</style>
<h1>${shipped.length} bundled brands</h1><main>${shipped.map((brand) => `<figure><img src="${curated[brand.key] ?? icons[brand.key]}"><img class="dark" src="${curated[brand.key] ?? icons[brand.key]}"><figcaption>${escape(brand.key)}<small>${escape(brand.source.kind)}</small></figcaption></figure>`).join("\n")}</main>`;
const sheet = new URL(".logs/extension-brand-icons.html", root);
await NodeFSP.writeFile(sheet, html);

console.log(
  `${shipped.length} brands; ${bytes} bytes including curated pack; contact sheet: ${NodeURL.fileURLToPath(sheet)}`,
);
