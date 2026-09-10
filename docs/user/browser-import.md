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
