# MyVault Architecture Notes

MyVault is designed as a local-first desktop workspace. The main window should stay light, predictable, and cheap to keep running.

## Module Types

### Shell Pages

Shell pages run inside the main window. They are suitable for notes, settings, lightweight lists, and configuration screens.

These pages may stay resident with the main window, but they must keep resource usage low.

Current examples:

- Notes
- Settings

### Heavy Render Modules

Heavy render modules involve large media sets, video, complex visualization, or other expensive rendering work.

These modules should not be embedded into the main window by default, and resource cleanup should not rely on React page switching alone. If a heavy module is built, it needs an explicit rendering boundary and a measurable release strategy.

If the release strategy is not reliable, prefer using native system capabilities instead of rendering everything inside WebView2.

### Persistent Services

Persistent services are long-running capabilities such as a player, downloader, indexer, or sync worker.

The persistent part should live in Rust or another service layer. The UI is only a control surface and may be opened on demand.

Service lifetime and UI lifetime should be separate.

## State Caching

Cache lightweight navigation state only. Do not cache page instances, media resources, or decoded content.

Shell pages may cache current selections:

- Notes: selected folder and selected note id

Heavy render modules may cache navigation state:

- Media modules: selected folder, page number, selected item id

Content should be loaded again from disk or from the service layer when the user re-enters a module.

Startup should restore only the necessary main-window state. It should not eagerly restore multiple heavy modules.

## Media Feature Rules

The removed Gallery module showed that WebView2 image and GPU caches are not a reliable resource-management boundary.

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
