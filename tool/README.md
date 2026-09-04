# MyVault maintenance tools

These tools are deliberately outside the application and run only when invoked manually.

## Migrate legacy notes

Close MyVault, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tool\migrate-notes-v1-to-json.ps1 -DataRoot "E:\MyVaultData"
```

The tool converts every `Notes/**/*.md` file into a `formatVersion: 1` JSON block document in the same logical note folder. Original `.md` files are moved to `_MyVault/Backups/Notes-v1/<batch>` instead of being deleted. The application itself contains no legacy note reader.
