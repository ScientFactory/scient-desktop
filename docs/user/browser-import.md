# Import browser logins

In the desktop app, open **Settings → Integrations → Browser profiles → Add profile**
and choose a browser under **Import from**. The import copies cookies into a Scient browser
profile so you can use existing logins in the preview browser. Changes made afterward stay
separate from the source browser.

On macOS, Safari's primary profile can also be imported. Its cookies require **Full Disk Access**;
the wizard opens the relevant System Settings pane. macOS may require quitting and reopening Scient
before the permission applies. You can revoke it after importing. Additional Safari profiles are
not imported, and some websites may still require a fresh sign-in.

Linux discovery includes Helium and both native and Snap installations of Firefox. Windows
discovery includes Firefox and Helium builds that still use Windows' standard profile
encryption. Other Chromium-based browsers on Windows use app-bound cookie encryption and cannot
be imported. A browser appears once it has a profile with a cookie database. Close the source
browser before importing; the import wizard will prompt you if it is still running.

On Linux, Chromium-based browsers use your desktop keyring to protect their cookies. Scient
includes the keyring reader; no separate command-line tool is needed. Allow the desktop unlock
prompt if one appears. If the keyring cannot be accessed, Scient reports that failure when no
cookies can be imported. Partitioned cookies are skipped.
On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag Scient into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen Scient before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

On Windows, import supports Firefox and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.
