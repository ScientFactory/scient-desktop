# Scient mobile release hold

Status: not available in a public Scient release. Exclude this page from
current Scient Docs.

Scient retains T3-derived mobile source and build foundations so future mobile
work does not need to start from an empty client. Production CI store builds
and over-the-air publication are disabled by the
[mobile production workflow](../../.github/workflows/mobile-eas-production.yml).
Retained local build scripts and runtime update settings do not establish a
supported Scient mobile app for users to install.

The retained client includes appearance behavior such as system/light/dark
mode, selectable theme presets, compact system-bar controls, and a theme-aware
launch screen. Those implementation foundations are not a product availability
claim. The retained native-module and store identifiers are compatibility names;
the client displays Scient in its own screens. Instructions for operating-system
settings use the configured native app name. Store configuration and screenshots remain maintainer
evidence until Scient has a release owner, platform qualification, and public Help
navigation.

Do not direct Scient users to a T3 mobile build or describe T3's mobile update
channel as a Scient distribution. When a Scient mobile release is authorized,
replace this hold notice with version-qualified instructions that have been
verified on the published iOS and Android artifacts.
