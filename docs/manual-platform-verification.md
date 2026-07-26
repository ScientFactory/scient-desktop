# Cross-platform manual verification

This document defines how to verify Scient on macOS, Windows, and Linux without
mistaking an already configured developer machine for a clean user environment.
It complements automated tests and the release process; it does not replace
either one.

## The standard

A result is only as strong as the environment that produced it. An isolated
`SCIENT_HOME` proves that Scient can start with empty application data. It does
not prove first-run installation or provider onboarding: the operating-system
user may still have provider binaries, credentials, browser sessions, keychain
items, environment variables, or machine-wide dependencies.

Use the weakest environment that can answer the question, but label it
accurately:

| Evidence tier | Environment                                                    | What it can prove                                                                                                                                                                              |
| ------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A             | Disposable VM or physical machine restored to a clean snapshot | Installation, first launch, provider download and sign-in, updater, OS integration, and full UI behavior                                                                                       |
| B             | New operating-system user with a fresh profile and keychain    | Fresh-user UI, per-user installation, provider sign-in, file associations, and permissions; not absence of machine-wide software                                                               |
| C             | Existing user with a unique `SCIENT_HOME` and ports            | Application-state regressions and fast UI checks; not clean installation, authentication, or dependency discovery                                                                              |
| D             | Native CI runner                                               | Repeatable build, unit, integration, process, and protocol behavior on that OS; not human visual or desktop-interaction approval unless the job explicitly drives and captures the packaged UI |

Tier A is required when the behavior under review includes installation,
managed provider download, authentication, updater behavior, signing warnings,
or a claim that a new user can complete the flow. Tier C is useful for rapid
development, but must never be described as a clean machine.

## Clean-environment contract

Before a Tier A or B run, confirm all of the following:

- The OS user has never launched Scient or the provider being tested.
- Scient data, provider configuration, browser profiles, credentials, and
  relevant environment variables are absent from that user profile.
- The test starts from an exact installer or package with a recorded filename,
  SHA-256 digest, source commit, and build run.
- The workspace contains only public, disposable fixtures. Never expose a real
  project or personal account merely to test the UI.
- Authentication uses the intended test account. Device codes, session tokens,
  cookies, recovery codes, and private account details are never included in
  screenshots or logs.
- The machine clock, OS version, CPU architecture, display scaling, and active
  light/dark theme are recorded.
- The environment is restored to its clean snapshot, or the disposable user is
  deleted, before testing a second first-run scenario.

Treat a fresh Scient database and a fresh provider identity as separate facts.
If either one is inherited, state that explicitly in the result.

## Preparing each platform

### macOS

For release-level verification, use a disposable macOS VM on matching Apple
hardware or a dedicated clean Mac. A new standard macOS user is an acceptable
Tier B shortcut for UI work. Test Apple Silicon and Intel artifacts on their
matching architectures when both are released.

1. Restore the clean snapshot or create a new standard user.
2. Download the exact DMG through the same route a user will use.
3. Record `sw_vers`, `uname -m`, and the installer digest.
4. Install by dragging Scient to Applications, then launch it from Finder.
5. Record Gatekeeper, signing, notarization, permission, or firewall prompts
   exactly as shown. Do not bypass them silently.

For a Tier C development run, use a unique application home and dev instance:

```bash
SCIENT_HOME="$(mktemp -d)" \
SYNARA_DEV_INSTANCE="manual-qa-$(date +%s)" \
bun run dev:desktop
```

This isolates Scient state and ports only. It can still inherit the macOS
user's provider installations, browser login, environment, and keychain. The
development Electron process also keeps its normal `scient-dev` user-data
profile unless that is isolated separately, so do not use this path to certify
fresh browser or desktop-session state.

### Windows

Windows Sandbox is the fastest Tier A environment for install and first-run
checks because closing it destroys the machine. Use Hyper-V, VMware, or a
dedicated Windows machine with a checkpoint when the scenario requires a
restart, updater continuity, persistent browser state, or repeated inspection.

1. Start a fresh Windows Sandbox or restore a clean Windows 11 VM checkpoint.
2. Download or copy in the exact NSIS installer and record its SHA-256 digest.
3. Record `winver`, architecture, display scaling, and Windows theme.
4. Run the installer as a normal user. Record SmartScreen and publisher status;
   an unsigned build is testable but is not signed-release evidence.
5. Launch Scient from the Start menu and perform onboarding without installing
   a provider manually first when managed installation is the feature under
   test.

Tier C PowerShell launch for an already built executable:

```powershell
$qaHome = Join-Path $env:TEMP ("scient-qa-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $qaHome | Out-Null
$env:SCIENT_HOME = $qaHome
& "$env:LOCALAPPDATA\Programs\Scient\Scient.exe"
```

This does not hide machine-wide executables or credentials from the current
Windows user.

### Linux

Use a fresh Ubuntu 24.04 Desktop VM as the reference Tier A environment, plus
another supported distribution when a change touches packaging or desktop
integration. Preserve separate Wayland and X11 results if the behavior differs.

1. Restore a clean VM snapshot with no Scient or provider configuration.
2. Download the exact `.deb` and record `uname -a`, desktop session, display
   scaling, and its SHA-256 digest.
3. Install it through the system package installer, then launch Scient as an
   ordinary user. Record the privilege prompt used for installation separately
   from the unprivileged application launch.
4. Record missing runtime libraries, sandbox errors, desktop integration
   prompts, and file-opening behavior instead of repairing the image silently.

Tier C shell launch:

```bash
sudo apt install ./Scient-*-amd64.deb
SCIENT_HOME="$(mktemp -d)" scient
```

Do not add `--no-sandbox` merely to obtain a green result. If the packaged app
requires it, that is a release defect. The AppImage compatibility artifact
remains fail-closed and is not the supported Ubuntu route because stock Ubuntu
24.04 can block its randomized mount path from obtaining a Chromium sandbox.

## Running a manual verification

Begin every run with the exact claim being tested. Examples include “a new
Windows user can install Codex through Scient” and “a static HTML artifact opens
as a rendered page in Scient and in the default browser.” Do not replace that
claim with a looser one after seeing the result.

Use this order:

1. Record environment tier, OS, architecture, theme, scale, artifact digest,
   source commit, and whether any provider identity is inherited.
2. Perform the shortest ordinary-user path without developer tools.
3. Verify failure and recovery paths relevant to the change.
4. Repeat theme, directionality, keyboard, or scaling variants only when the
   feature can be affected by them.
5. Capture concise evidence: screenshots at decision points, exact error text,
   and logs or process output only where they explain behavior.
6. Restore the snapshot before testing a genuinely fresh path again.

A passing run must describe what was observed, not merely say “works.” A failed
run should preserve the first failure before retrying or repairing anything.

## HTML, Markdown, and artifact-shelf checklist

Use a public fixture project containing a static HTML page, an interactive HTML
page with obvious local JavaScript state, a Markdown document, and at least four
cited artifacts.

Verify the following in both light and dark themes at normal scaling, then at
one non-default scaling setting:

- A Markdown card opens directly in rendered Preview. Source remains a
  secondary choice.
- A static HTML card shows one rendered thumbnail, not a thumbnail plus a file
  icon. The thumbnail enlarges modestly on pointer hover without changing row
  height or hiding neighboring controls.
- The primary card surface shows a pointer cursor and opens the preview; the
  explicit Preview control does the same.
- A static HTML page renders in Scient and the Default browser action opens the
  rendered page in the OS browser.
- Interactive HTML does not execute merely because its card is visible and is
  not opened in the external browser. It runs only in Scient's isolated browser
  when executable preview is explicitly enabled.
- The interactive fixture can change its own local state, while top-level
  navigation, popups, downloads, permissions, new windows, service workers,
  and unapproved external requests remain blocked.
- Closing the preview removes its temporary grant; reopening creates a fresh
  working preview rather than depending on the old tab's hidden state.
- Missing, moved, oversized, unsupported, outside-workspace, traversal, and
  symlink-escape inputs fail clearly and do not fall back to a raw `file://`
  page.
- A long artifact shelf shows two complete cards and a partial third card. Its
  disclosure reveals all remaining files, collapses again, and restores focus
  without making the teaser interactive.
- Hebrew and mixed Hebrew/English content render correctly inside the document
  without forcing the surrounding Scient shell into RTL.

For executable-preview development builds, first prove that the rollout flag
reaches both Electron and the server process. A passing page after manually
altering the process environment does not validate the documented launch
command.

## Automation and Computer Use

Computer Use can supply strong visual evidence only for a machine it can
actually control. A macOS Computer Use run does not certify Windows or Linux,
and a native GitHub runner that exercises server endpoints does not certify the
desktop UI.

For repeatable automated visual evidence on Windows and Linux, maintain a
packaged-app journey that:

1. launches the exact native artifact in a fresh runner or disposable VM;
2. creates an isolated Scient home and imports only public fixtures;
3. opens Markdown, static HTML, interactive HTML, and the disclosure shelf;
4. asserts accessibility-visible text and security failure states;
5. captures screenshots and app logs as workflow artifacts; and
6. fails if the packaged UI never launches or the screenshots are missing.

Label that result “automated native UI verification.” Reserve “manual visual
verification” for a human or Computer Use agent that inspected the rendered UI
on that operating system. Keep protocol/process CI as its own evidence tier.

## Test record

Copy this block into the PR, release record, or QA note:

```text
Claim:
Source commit:
Artifact filename and SHA-256:
Build/run URL:
Platform, version, architecture:
Desktop/session, theme, scale:
Isolation tier:
Scient state fresh: yes/no
Provider identity fresh: yes/no/not in scope
Machine-wide dependencies known to exist:

Observed path:
1.
2.
3.

Failure/recovery checks:
Evidence links:
Result: pass/fail/blocked
Remaining limitation:
Tester and time zone:
```

“Blocked” is the correct result when the required native environment is not
available. Do not convert unavailable Windows or Linux visual evidence into a
pass based on macOS behavior or server-only CI.
