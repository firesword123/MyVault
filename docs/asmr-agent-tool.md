# ASMR agent 终端工具

`npm run asmr:agent -- preview|import ...` 是供本地 agent/LLM 调用的无 UI 导入工具，模块入口位于 `src-tauri/asmr/agent.ps1`。它只接受带 schema-2 Manifest 的 MyVault 数据目录，不会在 `MyVaultData` 中写入工具配置或缓存；只有 `import` 会写入预期的 `DL_ASMR` 作品目录、`_Library.json`，覆盖时另存到 `_MyVault/Backups/DL_ASMR`。

输入 JSON 为对象，支持 `rjId`、`title`、`circle`、`tags`、`voiceActors`（兼容 `voice_actors`）和 `note`。`--missing skip` 会跳过尚未存在的社团/声优/标签；`--missing create` 会自动加入词典。

示例：

```powershell
Get-Content .\metadata.json -Raw | npm run asmr:agent -- import `
  --data-root D:\MyVaultData `
  --source D:\Downloads\RJ12345678 `
  --missing create
```

先用 `preview` 检查 `rjId`、文件数量和跳过项，再调用 `import`。默认不覆盖已有作品，覆盖必须显式增加 `--Overwrite`。为避免与应用同时改写 `_Library.json`，运行 `import` 时请先关闭 ASMR 模块窗口。
