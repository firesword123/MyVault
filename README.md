# MyVault

MyVault is a local-first desktop workspace for notes.

It is designed around real filesystem semantics: folders are directories, notes are files, and system areas such as `_Drafts`, `_Inbox`, and `_Trash` exist directly on disk instead of being abstracted behind a database.

## Stack

- Tauri 2
- React 19
- TypeScript
- Rust
- Vite

## Design Intent

- Keep user data local and inspectable
- Make note and folder behavior match familiar file manager rules
- Use Rust for storage and filesystem operations, with a lightweight React desktop UI on top

## Current Features

- Notes workspace with drafts, inbox, trash, and custom folders
- Autosave draft flow for new notes
- Rename, move, restore, and soft-delete notes
- Rich text editor with basic formatting and color presets
- Standalone DL_ASMR work browser for RJ-numbered DLsite works, with an independently releasable WebView2 lifetime
- Standalone Gallery module that imports images into `MyVaultData/Gallery`, with paged thumbnails and disposable cache data
- On-demand player sidebar embedded in the notes shell, with playback independent of the DL_ASMR browser lifetime
- Desktop packaging for Windows via Tauri

## Development

```bash
npm install
npm run tauri dev
```

Development builds use `D:\MyVault\.dev-data\MyVaultData` by default. Automated tests use temporary roots; neither development path reads or writes an installed copy of MyVault.

## Build

```bash
npm run build
npm run tauri build
```

Packaged builds resolve `MyVaultData` next to the application directory. See [Data Layout and v1 Migration](docs/data-layout-migration.md).
