# Import browser logins

In the desktop app, open **Settings → Browser → Browser profiles → Add profile**
and choose a browser under **Import from**. The import copies cookies into a Scient browser
profile so you can use existing logins in the preview browser. Changes made afterward stay
separate from the source browser.

On macOS, Safari's primary profile can also be imported. Its cookies require **Full Disk Access**;
the wizard opens the relevant System Settings pane. macOS may require quitting and reopening Scient
before the permission applies. You can revoke it after importing. Additional Safari profiles are
not imported, and some websites may still require a fresh sign-in.

Linux discovery includes Helium and both native and Snap installations of Firefox. A browser
appears once it has a profile with a cookie database. Close the source browser before importing;
the import wizard will prompt you if it is still running.

On Linux, Chromium-based browsers use your desktop keyring to protect their cookies. Scient
includes the keyring reader; no separate command-line tool is needed. Allow the desktop unlock
prompt if one appears. If the keyring cannot be accessed, Scient reports that failure when no
cookies can be imported.
On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag Scient into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen Scient before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

## On Windows

Firefox, Zen and Helium import directly. Chrome, Edge, Brave, Vivaldi, Opera and Arc lock their
saved sign-ins so only they can read them (app-bound encryption), and Scient doesn't work around
that. They are listed, unavailable, with "Windows protects this browser's saved sign-ins from other
apps." and a **Sign in in a Chrome window** button (named after the browser you have, such as
**Sign in in an Edge window**): sign in to a site in a small window of that browser, click
**Done**, and Main gets the sign-in. See [Google](accounts.md#google) for Google and passkeys.
For saved passwords, use the browser's own password export and Accounts' **Import passwords…**.

## When some cookies can't be copied

Some cookies may be unreadable: protected by app-bound encryption, encrypted with a key Scient
can't read, or partitioned without the data Scient needs to keep them in their partition. The
import copies the rest and says how many were left behind, for example "6 protected cookies
couldn't be copied; some sites may need sign-in." Sign in to those sites again in Scient. An import
that could copy nothing fails instead of creating an empty profile.

Manage imported profiles and saved sign-ins in [Accounts](accounts.md).
