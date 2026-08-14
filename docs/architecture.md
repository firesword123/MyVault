# MyVault Architecture Notes

MyVault is designed as a local-first desktop workspace. The main window should stay light, predictable, and cheap to keep running.

## Module Types

### Shell Pages

Shell pages run inside the main window. They are suitable for notes, settings, lightweight lists, and configuration screens.

These pages may stay resident with the main window, but they must keep resource usage low.

Current examples:

- Notes
- Settings
- The lightweight player queue and playback controls, mounted on demand as a sidebar in the main notes WebView

### Heavy Render Modules

Heavy render modules involve large media sets, video, complex visualization, or other expensive rendering work.

These modules should not be embedded into the main window by default, and resource cleanup should not rely on React page switching alone. If a heavy module is built, it needs an explicit rendering boundary and a measurable release strategy.

If the release strategy is not reliable, prefer using native system capabilities instead of rendering everything inside WebView2.

### Dockable Extension Windows

Some future features may start as a compact companion window next to a note and expand into a full detail view. This is a window-composition pattern, not an embedded page pattern.

- The extension owns a separate native window and WebView. Docking only synchronizes window bounds and visual tokens.
- Supported presentation states are `detached`, `docked-compact`, and `expanded-detail`.
- A compact window may snap to the left or right edge of its host note window. Moving, resizing, minimizing, restoring, changing DPI, or changing monitors must recalculate the attachment geometry.
- The extension must remain independently movable and closable. Detaching must not recreate the WebView or lose the selected item.
- Closing the host note window detaches or closes the extension according to the negotiated module capability; it must never leave a hidden orphan window.
- Do not use global always-on-top behavior. Z-order should only follow the host while docked.
- The host sends geometry and view-state commands through the module protocol. React DOM, decoded media, and page instances are never shared across processes.

The first DL_ASMR process migration does not implement this presentation pattern. DL_ASMR opens as a standalone full module window; the docking protocol is reserved for later note extensions.

### Persistent Services

Persistent services are long-running capabilities such as a player, downloader, indexer, or sync worker.

The persistent part should live in Rust or another service layer. The UI is only a control surface and may be opened on demand.

Service lifetime and UI lifetime should be separate.

The current DL_ASMR compromise keeps the playback boundary in the main process: the notes WebView mounts one lightweight player sidebar containing the queue and one audio element. The standalone DL_ASMR process owns only work browsing, importing, metadata, and folder navigation. Selecting an audio file sends a queue to the main process and opens the sidebar; closing the DL_ASMR browser does not interrupt playback while the sidebar remains open.

The player does not create another native window or WebView2 renderer. Closing the sidebar unmounts the React component, pauses playback, removes the media `src`, calls `load()`, and clears the in-memory queue. Shared browser and GPU processes are still not expected to return exactly to a cold-start baseline.

This does not make the DL_ASMR browser a shell page. Its cover grid, work data, and file browser remain outside the main WebView and are released when `myvault-dl-asmr.exe` exits.

## State Caching

Cache lightweight navigation state only. Do not cache page instances, media resources, or decoded content.

Shell pages may cache current selections:

- Notes: selected folder and selected note id

Heavy render modules may cache navigation state:

- Media modules: selected folder, page number, selected item id

Content should be loaded again from disk or from the service layer when the user re-enters a module.

Startup should restore only the necessary main-window state. It should not eagerly restore multiple heavy modules.

## Media Feature Rules

The removed Gallery module, not the DL_ASMR module, produced the observed 1-2 GB growth after browsing many images and the incomplete return to cold-start memory. It showed that WebView2 image and GPU caches are not a reliable resource-management boundary.

Any future media feature should assume that WebView2 may keep decoded image or GPU resources longer than the React component lifecycle.

Rules:

- Use thumbnails or proxy resources for grids.
- Load original files only for explicit preview or editing.
- Prefer pagination over infinite scrolling.
- Clear media `src` values and render state when leaving the module.
- Verify memory and GPU recovery with the actual packaged app, not only in development mode.
- If resource usage remains unpredictable, prefer system-native handling through `opener` or a dedicated native path.

## New Feature Checklist

Before adding a feature, answer these questions:

1. Is it light enough to live in the main window?
2. Does it involve images, video, audio visualization, or other heavy rendering?
3. Does it need to keep working after its UI is closed?
4. Can resource release be verified in the packaged application?

Classification guidance:

- Light UI only: make it a shell page.
- Heavy rendering: design it as a heavy render module with an explicit boundary.
- Long-running behavior: implement it as a persistent service with an optional UI.
- Unreliable rendering cleanup: prefer native system capability instead of WebView2 rendering.
- Compact UI that can attach to a note: make it a dockable extension window and define its detached/compact/detail transitions before implementation.

## Current DL_ASMR Ownership

| Capability | Owner | Lifetime |
| --- | --- | --- |
| Notes and main shell | `myvault.exe` | Main application lifetime |
| Player queue, one audio element, volume and next/previous controls | `myvault.exe` notes WebView sidebar | Sidebar lifetime; the queue and media source are cleared on unmount |
| DL_ASMR work library, metadata, import and file browsing | `myvault-dl-asmr.exe` | DL_ASMR browser window lifetime |
| DL_ASMR playback request | Named-pipe message from DL_ASMR to main | One bounded queue-transfer message |
| Gallery browsing and image decode resources | Future standalone gallery module | Gallery window lifetime; no background persistence |

Only track metadata and file paths cross the process boundary. React state, DOM nodes, cover images, decoded media, and WebView instances never cross it.

## Portable Data Root

Both executables receive one resolved `MyVaultData` root. The main process owns resolution; the DL_ASMR process receives the same absolute root through `--data-root` and cannot choose a second location.

Resolution order is: explicit test override, `MYVAULT_DATA_ROOT`, an optional `myvault.data-route.json` beside the executable, then the platform default. Debug builds default to the current workspace's `.dev-data/MyVaultData`; packaged builds default to a `MyVaultData` directory beside the application directory.

Version 0.1.9 was the one-release transition that copied v1 `myvault-data` into schema 2. Version 0.1.10 removes runtime discovery and migration of v1 completely; it only reads `MyVaultData`. Existing `myvault-data` directories are ignored and never deleted. On the first DL_ASMR module open, version 0.1.10 performs a narrowly scoped repair for the 0.1.9 relative-path error and archives duplicate root-level work metadata before removing empty erroneous RJ directories.
