# MyVault

MyVault is a local-first desktop workspace for notes and image references.

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
- Support both text notes and a simple local image gallery in one workspace

## Current Features

- Notes workspace with drafts, inbox, trash, and custom folders
- Autosave draft flow for new notes
- Rename, move, restore, and soft-delete notes
- Rich text editor with basic formatting and color presets
- Local gallery module for image import, foldering, tags, notes, and trash
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
