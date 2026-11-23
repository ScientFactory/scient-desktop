# Edit a protected PDF

Read when an input is encrypted and the user requests a derivative.

1. Open the source with authorized access. Record the intended output protection, including algorithm, user and owner access, and permissions. Use the source settings unless the user requests a change. Keep credentials out of scripts, logs and command arguments. Done when the source opens and the output protection is known.
2. For pypdf edits, explicitly call `writer.encrypt(user_password, owner_password, algorithm=algorithm, permissions_flag=permissions)` with the intended settings before writing the final file. Cloning or appending the decrypted reader does not carry encryption forward. Use qpdf to copy source encryption when its exact settings are needed and a pypdf rewrite cannot reproduce them. When a helper requires cleartext input, use a private temporary directory for authorized decrypted intermediates and remove them after verification. Done when the final file is protected as requested.
3. Run the check below with a private password file. qpdf can print the supplied password during a structural check. Suppress both output streams and record only the exit status. A nonzero status requires investigation in a private session. Reopen with pypdf and verify the authorized access level, expected algorithm and permission flags, and rejection of an incorrect password. For rendering, use a password-aware viewer or render a private decrypted verification copy of the saved output. The lab’s `doc.py validate` and `render` wrappers lack password options. Recheck the saved pages, annotations and field values as applicable. Done when the intended access and restrictions match and the relevant pages have been inspected.

   ```sh
   (
       if qpdf --password-file="$password_file" --check "$protected_pdf" >/dev/null 2>&1; then
           status=0
       else
           status=$?
       fi
       printf 'qpdf structural check exit status %s\n' "$status"
       exit "$status"
   )
   ```
