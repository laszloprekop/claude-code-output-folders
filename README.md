# output-folders

A mod for Claude Code. `/outputs` opens a pane that lists every folder the session's tools,
scripts and agents wrote into, so each can be checked for changes.

Each row shows the folder's kind (`temp`, `cache`, `public`, `config`, `project`, `other`), its
path, how many writes went there, which tool wrote last and when, how many files it
holds and its newest change. A `●` marks a folder that changed since it was marked seen. Artifact
links published in the session are listed under the folders.

A click on a path or a link opens it (the folder in the file manager, the link in the browser),
and so does its number key, `1` to `9` from the top. The mod asks the system to open it (`open`,
or `xdg-open`), so this does not depend on the terminal passing hyperlinks on.

Other keys while the pane has focus: `r` refresh, `s` mark all seen, `c` clear the list, Esc
close.

## What counts as a write

- `Write`, `Edit`, `NotebookEdit`: the file's folder.
- `Bash`: what the command's text says it writes: redirects (`>`, `>>`), `mkdir`, `touch`, `tee`,
  the target of `cp`, `mv`, `rsync`, `ln`, and output flags (`-o`, `--output`, `--out-dir`, ...).
  Simple `NAME=value` variables set in the same command are expanded.
- `Agent`: the folder of a background agent's output file.
- `Artifact`: the published file's folder, and the artifact's link.

## Limits

- A script's own writes are invisible: `python build.py` shows nothing unless the command line
  names the output.
- Paths with unexpanded variables, globs or command substitutions are skipped.
- A folder is checked one level deep.
- The mod API is early access and may change between Claude Code releases. Built against 2.1.292.

## Develop

```
claude --plugin-dir .        # run the mod from this folder
claude plugin validate .     # check the manifest and the hooks module
claude plugin test .         # run tests/
```
