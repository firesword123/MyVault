# MyVault

MyVault is a local-first desktop workspace for notes.

It is designed around real filesystem semantics: folders are directories, notes are files, and system areas such as `drafts`, `inbox`, and `trash` exist directly on disk instead of being abstracted behind a database.

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
- Desktop packaging for Windows via Tauri

## Development

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run build
npm run tauri build
```
