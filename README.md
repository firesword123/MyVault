# MyVault

MyVault 是一个面向 Windows 的本地个人资料工作台，也是用户文件的一层视图和编辑器。

产品遵循“一切皆文件”：文件夹就是目录，笔记、图片和音频都是普通文件。用户数据独立保存在 `MyVaultData`，不依赖数据库，也不被锁在应用内部；即使不打开 MyVault，仍可直接使用资源管理器和其他软件访问这些资料。

## 当前功能

- 笔记：草稿、收件箱、回收站、自定义目录、自动保存和基础格式编辑；支持记住文件夹选择的单一显示模式。
- DL_ASMR：按 RJ 编号组织作品，管理导入文件、元数据、封面和播放入口。
- 图库：直接浏览 `Gallery` 目录，分页显示系统缩略图，并按需预览原图。
- 播放器：在不同模块之间持续播放当前队列。

## 当前架构

MyVault 只有一个原生主窗口，但不会把所有模块都塞进同一个浏览器页面：

| WebView | 内容 | 生命周期 |
| --- | --- | --- |
| `shell` | 标题栏、笔记、设置、播放器 | 跟随主程序 |
| `asmr` | DL_ASMR 浏览和编辑界面 | 进入模块时创建，切走时销毁 |
| `gallery` | 图库网格和原图预览 | 进入模块时创建，切走时销毁 |

DL_ASMR 和 Gallery 是嵌在同一窗口内容区里的原生 child WebView，并分别使用独立的 WebView2 user-data folder。切换到笔记、播放器或另一个重模块时，MyVault 会关闭当前 child controller；对应的 renderer 进程组随之退出，由操作系统回收其 Chromium、图片解码和 GPU 资源。它们不是隐藏的 React 页面，也不会在后台保留一份模块实例。

播放器保留在 `shell` 中，这是有意设置的例外：DL_ASMR 只把经过 Vault 路径校验的播放队列交给主播放器，因此关闭 DL_ASMR 界面不会中断音频。

图库网格通过 Windows Shell `IShellItemImageFactory` 获取缩略图，复用资源管理器所使用的系统缩略图提取与缓存能力。MyVault 不再生成或维护另一套 JPEG 缩略图；Rust 只把 Shell 返回的 `HBITMAP` 转成一次性响应并立即释放句柄。原图只在用户明确打开预览时加载。这样既保持了“原图就是用户文件”的数据语义，也避免了重复缓存和失效清理。

这套结构不承诺固定的内存上限：高分辨率原图被打开时仍会产生合理峰值。它解决的是生命周期问题——重模块关闭后，其独立 WebView2 进程组可以完整退出，而不是依赖 JavaScript GC 尝试把单一 renderer 恢复到冷启动水位。

## 技术演进

项目最初使用 Python 实现。实际使用中遇到了难以消除的字体割裂和渲染问题，因此前端改用 WebView，获得了更成熟、一致的文字与界面渲染。

早期多个功能共用一个 WebView 页面。功能切换后，即使主动卸载组件、清理媒体资源并触发内存整理，Chromium 的 V8 堆、字体缓存、图片解码缓存和 GPU 资源仍可能保留在同一个 renderer 中，进程内存水位无法可靠回到初始状态。

随后重模块被拆成独立窗口和独立进程。关闭窗口即可让 renderer 退出，内存能够可靠回收，但产品体验也被分割成多个窗口，并引入了 sidecar、命名管道和进程管理等额外复杂度。

当前方案保留了已经验证有效的“独立 WebView 生命周期”，同时把界面重新统一到一个窗口：笔记和播放器留在主 WebView，DL_ASMR 与 Gallery 作为使用独立环境的 child WebView 按需创建和销毁。最终得到单窗口体验、模块级资源隔离，以及可通过进程退出验证的内存回收。

## 技术栈

- Tauri 2
- React 19、TypeScript、Vite
- Rust
- WebView2 与 Windows Shell API

## 开发与构建

```bash
npm install
npm run tauri dev
```

```bash
npm run build
npm run tauri build
```

开发版本默认使用仓库下的 `.dev-data/MyVaultData`；打包版本默认使用应用目录旁的 `MyVaultData`。也可通过 `myvault.data-route.json` 或 `MYVAULT_DATA_ROOT` 指定数据位置。

更详细的设计记录见 [架构说明](docs/architecture.md)、[模块生命周期](docs/module-protocol-lifecycle.md) 和 [数据目录说明](docs/data-layout-migration.md)。
