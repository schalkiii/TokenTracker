# Sangfor endpoint security interference with node (Windows ops runbook)

## Symptom (observed 2026-11-09 → 2026-11-18)

On hosts running **Sangfor Endpoint Secure** (`SangforUDProtectEx.exe`, the
unified desktop-protection / transparent-encryption agent), `tokentracker-cli`
degrades in three distinct ways, all specific to `node.exe` child processes:

1. **serve freezes at startup.** The autostarted dashboard process stays alive
   for hours with zero CPU, no listening socket, and not a single log line.
   The freeze lands in the pre-listen port check: `execFileSync("lsof", …)`
   on a binary that does not exist on Windows. The ENOENT spawn is wedged
   inside the agent's process-creation hook, and the `timeout: 5000` option
   never fires — the synchronous wait blocks the main thread forever.
2. **node stdout vanishes.** `node -v` prints nothing; anything node writes
   to stdout (pipes and redirected files alike) never arrives. **stderr
   still works.** This is why serve.log stops mid-boot: the `echo` lines
   come from cmd, the node lines are eaten.
3. **Files written by node are encrypted at rest** with an 8 KiB-block
   format marked `%TSD-Header-###%`. Reads from *node itself* are
   transparently decrypted, so TokenTracker's own data round-trips are
   unaffected — but grep/python/bash see ciphertext (this is the agent's
   document-encryption policy applied per-process, not file corruption).

Cloud-side, the sequence compounded into "recent days show 0 tokens": the
upload pipeline is driven by the serve process's background publication loop;
with serve frozen, nothing uploads for days.

## Diagnosis playbook

Work around the three effects to see what a node process is actually doing:

- **Use stderr, never stdout**: `console.error` / `2>&1 1>/dev/null`.
- **Encode verdicts in exit codes or file names** when you need data out of
  a node one-liner (`process.exit(42)`).
- **Read node-written state files through node itself** — it decrypts them
  transparently; other runtimes read ciphertext.
- **Replicate the autostart exactly** (stdout appended to a file) when
  reproducing: the freeze is intermittent and path-sensitive. A proxy script
  that patches `process.stdout.write` and every `child_process` call and
  prints each step to stderr will show the exact call that wedges.

## Fixes

### Upstream fix (in this repo)

`src/commands/serve.js` now uses Windows-native tools on `win32`:

- `findPidOnPort` → `netstat -ano -p tcp` parsed by the pure
  `parseNetstatListeningPids` (unit-tested in
  `test/serve-find-pid-on-port.test.js`); `lsof` remains for POSIX.
- `readProcessCommand` → `powershell -NoProfile (Get-CimInstance
  Win32_Process -Filter 'ProcessId=<n>').CommandLine` with the pid validated
  as an integer before interpolation.

Real binaries do not hit the ENOENT-wedge path, so the port check can no
longer freeze the boot.

### Shim for already-installed packages (cannot hot-patch npm installs)

For a released CLI that still calls `lsof`/`ps`, drop instant-exit stand-ins
into a directory and prepend it to PATH for the dashboard process:

```
%USERPROFILE%\.tokentracker\shim\lsof.exe   (copy of where.exe)
%USERPROFILE%\.tokentracker\shim\ps.exe     (copy of where.exe)
```

`where.exe` with unix-ish arguments exits non-zero immediately;
`execFileSync` throws, the existing `catch` returns `[]`/`""` — semantically
identical to ENOENT, minus the wedge. Wire it into the autostart wrapper:

```bat
set "PATH=%USERPROFILE%\.tokentracker\shim;%PATH%"
"%NODE_EXE%" "%TRACKER_JS%" serve --no-open --port 7681 >> serve.log 2>&1
```

### Logging guidance for scripts on such hosts

Log through **both** `fs.appendFileSync` (machine-readable, TSD-encrypted at
rest) and a bounded `cmd /c echo … >> log` (plaintext channel), never through
stdout — see `scripts/cloud-device-rotate.cjs` for the pattern.

## What to tell IT

Ask for the endpoint policy to exclude `node.exe` (or at least the
tokentracker install/data directories) from stdout inspection and
transparent encryption. Even with the fixes above, the agent's per-process
file encryption means any non-node tooling that inspects
`~/.tokentracker/tracker/` sees ciphertext.
