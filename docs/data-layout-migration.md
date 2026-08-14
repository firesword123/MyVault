# Data Layout and v1 Migration

## Active layout (schema 2)

```text
Portable root/
├─ myvault/
│  ├─ myvault.exe
│  ├─ myvault-dl-asmr.exe
│  └─ myvault.data-route.json       # optional path override only
└─ MyVaultData/
   ├─ Notes/
   │  ├─ _Drafts/
   │  ├─ _Inbox/
   │  ├─ _Trash/
   │  └─ <user folders>/
   ├─ DL_ASMR/
   │  ├─ _Library.json
   │  └─ RJxxxxxx/
   │     ├─ _Work.json
   │     └─ <imported files and folders>/
   ├─ Attachments/
   └─ _MyVault/
      ├─ Manifest.json
      ├─ Settings.json
      ├─ Importing/
      ├─ Backups/
      ├─ Migrations/
      └─ MigrationReports/
```

All paths persisted in `_Library.json` are relative to `MyVaultData`. A DL_ASMR `coverPath` points directly to an existing image inside its RJ work directory; MyVault does not create a cover copy or thumbnail. Absolute media paths are created only in command responses while the application is running.

`myvault.data-route.json` contains no application state:

```json
{
  "dataRoot": "../MyVaultData"
}
```

If the file is absent, packaged builds use the same `../MyVaultData` default. Development builds use `<workspace>/.dev-data/MyVaultData`. `MYVAULT_DATA_ROOT` is the explicit development/test override and must be an absolute path.

## Retired 0.1.9 transition behavior

The following process documents the one-release migration that existed in 0.1.9. It is no longer executed by 0.1.10 or later.

Migration runs only when all of these conditions hold:

1. The active v2 root has no `Manifest.json` and is empty or absent.
2. A v1 root exists at `<executable directory>/myvault-data` (or the explicit legacy test override).
3. The v1 root contains settings, notes, or the old ASMR domain.

The migration process:

1. Creates `MyVaultData.migrating-<UUID>` beside the final root.
2. Copies settings, notes, attachments and RJ resources. Every copy is checked against the source byte length.
3. Maps `drafts`, `inbox`, and `trash` to `_Drafts`, `_Inbox`, and `_Trash`.
4. Renames the data domain from `asmr` to `DL_ASMR`, promotes the old `files` contents into each RJ directory, and writes `_Work.json`.
5. Rewrites `workDir`, `filesDir`, cover and thumbnail paths as schema-2 relative paths.
6. Generates thumbnails in `_MyVault/Index`, preserves old settings/index files in `_MyVault/Backups/Legacy`, and writes a migration report.
7. Writes `Manifest.json`, validates it, then renames the staging directory to `MyVaultData`.

The source `myvault-data` is never renamed, edited, or deleted. A failed migration leaves the uniquely named staging directory for diagnosis and does not activate partial data.

For the installed 0.1.8 data inspected on 2026-07-21, the acceptance baseline is 8 notes, 4 user note categories, 2 RJ works and 92 imported work-resource files. Old `cover` and `thumb` derivatives are accounted for separately; schema 2 regenerates thumbnails.

## 0.1.10 behavior and repair

Version 0.1.10 removes all v1 discovery and migration from startup. It neither reads nor modifies any surviving `myvault-data` directory. If `MyVaultData` does not exist, the application creates a new schema-2 root; if a nonempty root has no valid schema-2 manifest, startup fails instead of adopting it.

When the DL_ASMR module is first opened, version 0.1.10 repairs a 0.1.9 path error where `workDir`, `filesDir`, and `coverPath` could omit the `DL_ASMR/` prefix. The repaired index uses data-root-relative paths such as `DL_ASMR/RJ123456`. If a mistaken root-level `RJxxxxxx` directory contains only duplicate `_Work.json` metadata, those files are moved to `_MyVault/Backups/Repair-0.1.10` and the empty directory is removed. Any directory containing other files is left untouched. A repair report is written under `_MyVault/RepairReports`.

## 0.1.12 cover storage migration

Version 0.1.12 stops creating `_Cover.<ext>` copies and generated DL_ASMR thumbnails. `coverPath` now identifies an existing image under the work's own `DL_ASMR/RJxxxxxx` directory, and the frontend renders that resource directly.

On the first DL_ASMR index load after updating:

1. A legacy `_Cover.<ext>` explicitly referenced by the work index is removed and the old cover reference is cleared.
2. An unreferenced `_Cover.<ext>` is removed only when it is byte-for-byte identical to another image in the same work tree. Ambiguous files are preserved.
3. The old app-owned thumbnail for that RJ work is removed and `thumbnailPath` is cleared.
4. A report is written to `_MyVault/Migrations/DL_ASMR-CoverPaths-v2.json`, including every removed and preserved path.

Existing works intentionally have no cover after their legacy reference is cleared. Users can select an image in the work browser and choose **设置封面**. Newly imported works scan files in a stable breadth-first order and store the first image detected from its file header.
