# Local files, databases and programs

Take user-selected files and directories from manifest settings and paths from environment variables, so the connector works on any machine. Set `_meta["com.scientfactory.scient"].workingDirectory: "project"` only when the task should run in the chat's project.

Resolve requested paths under the allowed root and check containment after canonicalizing symlinks; a string-prefix check is insufficient. Read by default; writes get separate tools and destinations. Return bounded text or output paths rather than whole binary files.

Open databases read-only and bind query parameters. For a live database, go through the application's supported API; copying a locked database needs its WAL or backup semantics. Database passwords are sensitive environment settings. Check the actual Node runtime before choosing `node:sqlite` (absent on Node 20) or a packaged driver.

Spawn command-line programs with an executable and an argument array, not agent-built shell strings. Set a timeout, an output cap and cancellation, and check the exit code. On Windows, call a real .exe or run a Node script through `process.execPath`; untrusted arguments stay out of .cmd and .bat command lines. Report a missing executable and how to install it.

Use `node:path`, exact path case, and test paths with spaces and non-Latin names. Keep dependencies inside the connector folder. Record the runtime and OS you actually exercised; a declaration for another platform is not a passing test there.
