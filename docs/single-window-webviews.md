# Single-window WebView verification harness

Baseline backup: `b806299` on `main`. The verification harness lives on
`codex/single-window-webviews`. The verified architecture is now also used by the
normal `myvault.exe`; this executable only supplies isolated data and diagnostics.

Build and open the self-contained development executable (no Vite server):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-webview-experiment.ps1 -Launch
```

Executable: `src-tauri/target/debug/myvault-webviews.exe`.
It embeds the built frontend and requires the installed WebView2 runtime. Only
run one experiment instance at a time.

## Scope

- One native window. Notes, titlebar and the existing background audio player
  remain in the shell WebView. ASMR and Gallery are native child WebViews;
  they are not React tabs or iframes in the shell renderer.
- Each uses a different WebView2 user-data directory under
  `.test-data/single-window/WebViews/{shell,asmr,gallery}`. A module tab change
  closes the previous child controller, then creates the selected module.
- Switching back to Notes/Player closes the child. Returning to ASMR/Gallery
  cold-loads it; search, scroll, preview and selection are not retained yet.
- ASMR editing and active import/load guards prevent accidental tab destruction.
  Pending module file operations run off the UI thread and are serialized per
  module. Gallery catalog metadata is released after closing the module.
- ASMR saves playback metadata before handing the queue to the main player.
  Switching tabs does not stop background audio.
- The verification executable disables the updater and manual working-set
  trimming. The titlebar always shows total process memory and process count.
- Data is isolated in `.test-data/single-window/MyVaultData`, regardless of the
  production route/environment variable. Import test copies here; do not move
  original media into an experimental library. The installed app is untouched.

## What this does not guarantee

Different user-data folders isolate WebView2 process groups. Controller close
requests browser teardown; process exit may lag and must be measured. This does
not set a hard RAM limit. Native Rust command allocations remain in the main
process. Tauri's native multi-WebView API currently requires its `unstable`
feature, which is part of the production build.

## Manual verification

1. Record idle memory/process count on Notes.
2. Open Gallery, import copies of a representative image set and preview images.
3. Return to Notes, wait several seconds. Check that the Gallery browser group
   exits; do not judge reclamation only by a momentary working-set drop.
4. Repeat ASMR/Gallery/Notes cycles, including maximizing, restoring and resizing.
5. From ASMR start playback; verify a switch to Player, continued audio on Notes,
   and released ASMR browser processes. Stop the player explicitly afterward.
6. Start metadata editing/importing and try switching tabs: it must refuse until
   the edit is saved/cancelled or the operation finishes.
7. Quit while a child is open and check for remaining experimental processes.

The append-only `.test-data/single-window/webviews.log` records controller
open/close requests; it is not itself proof of browser-process exit.

For local automated checks only, `-Diagnostics` opts into loopback CDP ports
9330 (shell), 9331 (ASMR), 9332 (Gallery). Normal launch exposes no debug ports.

`scripts/test-webview-experiment.cjs` can attach with Playwright available on
`NODE_PATH`. It generates a silent WAV and imports test copies into the isolated
library; pass `--quit` to also verify complete process teardown. Reports and page
screenshots go to `.test-data/single-window/verification` (Git-ignored).

## Initial local results (2026-09-03)

- Frontend production build, default backend tests (48 executions), experimental
  backend tests (65 executions), and strict Clippy for both configurations passed.
- Two initial runs completed 10 module open/close cycles each. Each child used
  its own profile; every captured child process exited on switching back to Notes.
  The process count returned from 13 to 7 on each cycle.
- In the first lightweight run, aggregate working set was about 490 MiB initially
  and 507 MiB after ten cycles; private bytes were about 229 MiB and 242 MiB.
  These are debug/CDP measurements, not release-build targets or a RAM guarantee.
- Maximize/restore geometry at the current display scale, ASMR-to-player audio
  handoff, continued playback on Notes, stop/clear, close guards, and quitting
  with a child open were checked. No experimental processes remained after quit.
- The fixtures are small (test images plus a silent WAV); large-library and
  long-session behavior still needs the user's representative workload.
- A final rebuilt run repeated all ten cycles and exercised the actual metadata
  editor's unsaved-change guard. All passed. One open sample briefly had 14
  processes; all closed samples still returned to 7. Total across runs: 30 cycles.
- Final path audit caught WindowConfig ignoring an absolute shell data directory
  (it used the isolated test identifier's AppData directory, not production).
  The shell now uses `WebviewWindowBuilder::data_directory` explicitly. Two more
  cycles plus sizing, actual edit guards, playback, and full exit passed with all
  three profile paths verified. Total: 32 module cycles, plus playback/quit checks.
- The production entry now uses the same single-window boundary and the old
  sidecar/pipe launch path has been removed. A post-unification run completed six
  more ASMR/Gallery cycles, resize, edit guard, silent playback handoff and full
  exit with every child group returning from 13 total processes to the 7-process
  shell baseline.
- Gallery now uses Windows Shell thumbnails and creates no private thumbnail
  cache. A thumbnails-only pass rendered all 766 test images over 16 pages without
  opening an original. The Gallery group reached about 1.0 GiB working set in
  this debug/CDP run, then all six Gallery-profile processes exited in under one
  second; the shell measured about 474 MiB at 15 seconds and 487 MiB at 30 seconds.
  `_MyVault/Cache/Gallery` was absent afterward.
