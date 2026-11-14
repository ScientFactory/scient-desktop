# Mobile release

Scient's phone app is not released. Every mobile workflow stays off until the owner
sets repository variable `SCIENT_MOBILE_RELEASE` to `true`, and nothing here
authorizes doing that. Until a release is published and checked on both stores,
do not direct users to a Scient phone app, and never to T3's builds or update channel.

This runbook covers what must exist first, the switches, and how dev, preview and
production builds reach testers and the stores.

## Identity

| Variant     | iOS bundle ID / Android package    | Scheme           | Expo channel  |
| ----------- | ---------------------------------- | ---------------- | ------------- |
| production  | `com.scientfactory.mobile`         | `scient`         | `production`  |
| preview     | `com.scientfactory.mobile.preview` | `scient-preview` | `preview`     |
| development | `com.scientfactory.mobile.dev`     | `scient-dev`     | `development` |

Apple team `XR49G75382`. Copied thread links (`https://app.scientfactory.com/threads/…`)
open the app. Sign-in uses Clerk production (`clerk.scientfactory.com`, JWT template
`scient-relay`) and the relay at `https://relay.scientfactory.com`; those public
values are in `.env.example`.

## Accounts needed

1. **Expo.** An organization account owns the project. Run `eas init` in `apps/mobile`
   with `T3CODE_EAS_OWNER` set to that account; it prints the project ID. Create
   two robot-user access tokens: one for production, one for previews.
2. **Apple Developer Program** on team `XR49G75382`, with the three bundle IDs and an
   App Store Connect record for `com.scientfactory.mobile`. Give EAS an App Store
   Connect API key (`eas credentials`) so it manages signing, the push key and
   TestFlight uploads. Non-interactive submission (the workflows' `--auto-submit`)
   requires the record's Apple ID in `eas.json` as `submit.production.ios.ascAppId`
   (`testflight` inherits it): add it in a reviewed PR before setting
   `SCIENT_MOBILE_RELEASE`.
3. **Google Play Console** with an app for each package you publish, Play App
   Signing turned on, and a service account with release permission. Upload the
   service-account JSON to EAS (`eas credentials`, Android, Google Service Account).
   Play rejects API uploads until one build is uploaded by hand, so upload the first
   `.aab` in the Console.
4. **Firebase** Android apps for the three packages; their `google-services.json` is
   needed for push notifications.

## EAS environment variables

Set these in each EAS environment (`development`, `preview`, `production`) on expo.dev.
EAS cloud builds read the app config there, not from GitHub.

| Name                                  | Value                                                           |
| ------------------------------------- | --------------------------------------------------------------- |
| `T3CODE_EAS_OWNER`                    | Expo account name                                               |
| `T3CODE_EAS_PROJECT_ID`               | Expo project ID (OTA updates stay off without it)               |
| `T3CODE_CLERK_PUBLISHABLE_KEY`        | from `.env.example`                                             |
| `T3CODE_CLERK_JWT_TEMPLATE`           | `scient-relay`                                                  |
| `T3CODE_RELAY_URL`                    | `https://relay.scientfactory.com`                               |
| `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` | file variable, `google-services.json` (required for production) |

`EXPO_PUBLIC_CLERK_GOOGLE_*` client IDs are optional; without them the app has no
native Google sign-in.

## GitHub secrets and variables

Repository settings, Actions. Variables are public values; secrets are not.

| Name                                                   | Kind     | Needed by                                                             |
| ------------------------------------------------------ | -------- | --------------------------------------------------------------------- |
| `SCIENT_MOBILE_RELEASE`                                | variable | every mobile workflow; `true` turns them on                           |
| `T3CODE_EAS_OWNER`                                     | variable | EAS workflows                                                         |
| `T3CODE_EAS_PROJECT_ID`                                | variable | EAS workflows                                                         |
| `T3CODE_EAS_SLUG`                                      | variable | optional; defaults to `scient`                                        |
| `EXPO_PRODUCTION_TOKEN`                                | secret   | Mobile EAS Production                                                 |
| `EXPO_PREVIEW_TOKEN`                                   | secret   | Mobile EAS Preview, Mobile EAS Preview (Fork)                         |
| `SCIENT_MOBILE_MACOS_RUNNER`                           | variable | optional macOS runner label; default `xcode-27`                       |
| `MOBILE_IOS_LOCAL_BUILDS`                              | variable | optional; `true` builds iOS on the macOS runner instead of EAS        |
| `MOBILE_IOS_ALLOW_XCODE_RC`                            | variable | optional; accepts the Xcode release candidate                         |
| `MOBILE_SOURCEMAPS_R2`                                 | secret   | optional; uploads source maps for relay crash stacks                  |
| `SCIENT_MOBILE_FORK_PREVIEWS`                          | variable | `true` also runs previews for fork PRs                                |
| `SCIENT_MOBILE_APK_MIRROR`                             | variable | `true` turns on the Android APK mirror                                |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`                     | secret   | Mobile Android APK                                                    |
| `SCIENT_ANDROID_SHA256_PRODUCTION`, `_PREVIEW`, `_DEV` | variable | Deploy Scient hosted web (`scient-connect` environment or repository) |

Do not create `T3_NATIVE_CLIENT_WRITE_TOKEN` or `T3_TASK_CACHE_READ_TOKEN`: they log in
to T3's caches. Without them the Mobile Dev Client workflow keeps the client as a run
artifact.

Keep the fork-preview variable off unless you review each fork PR before labelling it:
that workflow runs the PR's code with the preview Expo token. Keep the APK mirror off
for now. It publishes `android-beta-*` GitHub prereleases beside the desktop releases,
and its release text still says T3 Code.

The workflows use GitHub-hosted runners (`ubuntu-24.04`, and `xcode-27` for local iOS
builds). Android builds keep Gradle and ccache state in the Actions cache, which
shares the repository's cache quota with CI.

## App links

`infra/scient-web/build.sh` writes the link files into the hosted build of
app.scientfactory.com with `infra/scient-web/well-known.mjs`:

- `/.well-known/apple-app-site-association` (and `.json`): `applinks` for `/threads/*`
  and `webcredentials`, with the app IDs from `apps/web/public/.well-known`.
- `/.well-known/assetlinks.json`: one entry per package that has a fingerprint.

Both are served as `application/json`. Only `com.scientfactory.*` identifiers are served.
The desktop app's web build is unchanged.

The Android signing fingerprints are never committed. Once Play App Signing exists,
copy each app's SHA-256 certificate fingerprints from Play Console (Test and release,
App integrity, App signing): the app signing key first, then the upload key. Use
`eas credentials` for a build that Play does not re-sign. Set them, comma-separated, as
`SCIENT_ANDROID_SHA256_PRODUCTION`, `SCIENT_ANDROID_SHA256_PREVIEW` and
`SCIENT_ANDROID_SHA256_DEV`, then redeploy with Deploy Scient hosted web. A package with
no fingerprint is left out, so Android does not verify its links. A badly formed
fingerprint fails the build.

Check after a deploy:

    curl -sI https://app.scientfactory.com/.well-known/apple-app-site-association | grep -i content-type
    curl -s https://app.scientfactory.com/.well-known/assetlinks.json

## Build and release

Run EAS commands from `apps/mobile` with `T3CODE_EAS_OWNER` and `T3CODE_EAS_PROJECT_ID`
in the shell, or in the repository-root `.env.local`.

**Development client.** `vp run eas:ios:dev` and `vp run eas:android:dev` build on EAS
for internal installs. The Mobile Dev Client workflow builds the simulator and emulator
client on each native change to `main`, or for one commit on dispatch, and keeps it as
a run artifact.

**Preview.** Add the `🚀 Mobile Continuous Deployment` label to a same-repository PR
(create the label first). Mobile EAS Preview publishes an OTA update to branch
`pr-<number>` and comments with the QR code. iOS reuses or builds an EAS client;
Android builds an APK on the runner when its fingerprint has none. A persistent
preview build is `vp run eas:ios:preview` or `vp run eas:android:preview`.

**Production.** Mobile EAS Production runs only by manual dispatch, never on a push to
`main`, so App Store users get only tested code. Dispatch it from a tested release
commit. `mode=update` publishes an OTA update to the `production` channel.
`mode=build` with `profile=production` and `platform=ios` (or `all`) makes App Store
binaries; `profile=testflight` makes TestFlight builds. Turn the gate on only for the
dispatch, then delete it again, because the dev-client and preview workflows read it too.

**Versions.** The app version is the default in `apps/mobile/app.config.ts`; the
`testflight` profile in `eas.json` pins its own. Change either in a reviewed PR,
never by a workflow commit. Build numbers come from EAS (`appVersionSource: remote`,
`autoIncrement`). Apple closes a version after App Store approval, so raise the
version in a PR before the next App Store build.

**TestFlight.** Builds submitted by EAS appear in App Store Connect after processing.
Add internal testers there; external testers need beta review.

**Play internal testing.** Android submissions land on the `internal` track. Add
testers in Play Console, then promote a release to closed, open or production testing
there.

**Store release.** Submit for review in App Store Connect and Play Console. Then
replace the "not released" note at the top of this page with version-qualified install
instructions, checked on the published iOS and Android apps.
