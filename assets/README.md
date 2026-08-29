# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `symbol.svg` for the Scient mark and `background.svg` when the background is a vector layer. Additional layers use semantic names that describe their role and placement.

The active Scient icon keeps one stable appearance across development,
preview, and production: the canonical burgundy `#471A1A` and slate
`#46587E` symbol on the website's warm off-white `#FAF9F6` surface. Runtime
labels such as `Scient (Dev)` distinguish channels without fragmenting the
product mark or changing it with system appearance.

The symbol layer uses Icon Composer scale `8.0` with zero translation in every
channel project. This is a 5.88% linear reduction from the initial `8.5`
placement: the mark remains mathematically centered while gaining a little more
breathing room inside the icon body.

The canonical symbol uses the approved 16-unit geometry inside its unchanged
`376 x 400` design footprint. Its outer bounds and center `(188, 200)` are the
same as the preceding 10-unit mark, so the heavier lines do not enlarge or
reposition the symbol inside the icon.

The in-app masthead, splash screen, and authentication surfaces use the same
canonical mark from `apps/web/src/assets/scient-symbol.svg`. Keep that compact
web asset geometrically and chromatically aligned with the Icon Composer
sources; it is intentionally a separate SVG file so the app does not depend on
an icon-project implementation detail at runtime.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer on macOS. The script selects the newest exporter from Xcode or a standalone Icon Composer installation. Icon Composer 2 and newer are pinned to design generation 26; older exporters read the generation embedded in the source project. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

Icon Composer's command-line exporter does not expose the `macOS pre-Tahoe` preset. A plain command-line `macOS` export is full bleed and is not suitable for the desktop app, so the export script intentionally leaves the tracked macOS PNGs unchanged and prints a reminder after every run.

After changing an Icon Composer project, open it in Icon Composer and export the macOS PNG with exactly these settings:

- Platform: `macOS pre-Tahoe`
- Appearance: `Default`
- Size: `1024pt`
- Scale: `1×`

Save the three exports to:

- `dev/app-icon.icon` -> `dev/blueprint-macos-1024.png`
- `nightly/app-icon.icon` -> `nightly/nightly-macos-1024.png`
- `prod/app-icon.icon` -> `prod/black-macos-1024.png`

The result must be a 1024×1024 PNG with the classic macOS safe area: the opaque icon body is 824×824, inset 100 pixels on every side, with only the native Icon Composer shadow extending into the surrounding transparent canvas.

To have Codex perform the native exports, paste this prompt into a task opened at the repository root:

```text
Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.

For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:

- assets/dev/app-icon.icon -> assets/dev/blueprint-macos-1024.png
- assets/nightly/app-icon.icon -> assets/nightly/nightly-macos-1024.png
- assets/prod/app-icon.icon -> assets/prod/black-macos-1024.png

Do not resize, composite, or otherwise post-process the exported PNGs.

Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.
```

Do not edit the generated PNG or ICO files directly.

## Android adaptive foreground

`apps/mobile/assets/android-icon-foreground.svg` is the source of truth for the foreground used by
the normal Android adaptive launcher icon. Export its paired PNG after changing it:

```sh
rsvg-convert -w 432 -h 432 \
  -o apps/mobile/assets/android-icon-foreground.png \
  apps/mobile/assets/android-icon-foreground.svg
```

The foreground must remain transparent and keep the T3 mark inside Android's adaptive-icon safe
zone. `android-icon-mark.png` remains a flat silhouette for Android's monochrome themed icon.
