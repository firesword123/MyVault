# 模块边界与生命周期

## 当前决策

MyVault 使用一个原生主窗口，但不把所有模块塞进同一个 Chromium renderer。

- 笔记、设置和播放器属于 shell WebView，生命周期跟随主窗口。
- DL_ASMR 与 Gallery 分别是主窗口内的 native child WebView；两者使用独立的 WebView2 user-data folder。
- 任一时刻最多存在一个重模块 child WebView。切换到另一个模块、笔记或播放器时，先关闭当前 child controller，再创建目标模块。
- 不保留隐藏的重模块页面，不依赖 React 卸载或 JavaScript GC 回收 Chromium 内部缓存。
- 播放器留在 shell 中，因此关闭 DL_ASMR 后播放仍可继续；DL_ASMR 只向 shell 传递经过 Vault 边界校验的有界曲目队列。

这套结构统一由 `myvault.exe` 承载。旧的 ASMR/Gallery sidecar、命名管道、进程注册表和 Job Object 启动链已经移除。

## 模块所有权

| 能力 | WebView | 生命周期 |
| --- | --- | --- |
| 笔记、设置、更新 | `main` | 应用生命周期 |
| 播放队列与唯一 `<audio>` | `main` | 播放器组件生命周期；可跨模块切换继续播放 |
| DL_ASMR 浏览、导入、元数据、封面和文件树 | `embedded-asmr` | DL_ASMR 页签可见期间 |
| Gallery 网格、导入与原图预览 | `embedded-gallery` | Gallery 页签可见期间 |

WebView2 数据目录分别为 `WebViews/shell`、`WebViews/asmr` 和 `WebViews/gallery`。child WebView 不共享 shell profile，也不共享 React DOM、解码位图、GPU 纹理或页面实例。

## 切换流程

1. shell 校验目标模块与内容区边界。
2. 若当前 child 声明了未保存编辑或正在执行导入，拒绝切换并保留现场。
3. 关闭当前 child WebView；Gallery 同时释放 Rust 侧的目录表。
4. 使用目标模块独立的 WebView2 数据目录创建 child，并覆盖标题栏下方内容区。
5. 返回笔记或播放器时不创建 child；焦点回到 shell。

WebView2 controller 关闭是资源边界。是否实际回收必须通过对应 profile 的 `msedgewebview2.exe` 进程组退出验证，不能用 JavaScript heap 或一次工作集下降代替。

## Gallery 的系统缩略图

Gallery 网格不生成、保存或维护 MyVault 私有缩略图。Rust 在两个有界 COM STA worker 上调用 Windows Shell `IShellItemImageFactory`：

- Windows 负责命中或填充系统级缩略图缓存。
- MyVault 只把返回的 `HBITMAP` 复制成一次性的 BMP 响应，并立即 `DeleteObject`。
- 前端只持有当前页的 16 位临时 ID，不获得缩略图服务可解析的任意磁盘路径。
- 翻页会替换允许集合，排队中的旧页请求返回 `410 Gone`。
- 原图只在用户显式打开预览时通过 Tauri asset protocol 加载。

升级时会删除旧版明确归 MyVault 所有的 16 位哈希 `.jpg` 和 `.thumb-*.tmp` 派生文件；缓存目录中的未知文件会保留。

## 数据与安全

- 用户数据仍全部位于独立的 `MyVaultData`；WebView2 profile 位于应用本地数据目录，不进入用户资料库。
- child 命令由 Tauri capability 按 WebView label 限制。
- Gallery 自定义协议只接受 `embedded-gallery` 发出的 GET 请求、合法短 ID 和当前页可见项。
- ASMR 播放请求必须包含 1–2000 首曲目；所有绝对路径都要 canonicalize 后确认属于当前 Vault。
- 所有持久化写入继续使用临时文件与原子重命名。

## 验收标准

1. 冷启动只有 shell WebView2 进程组。
2. 打开 ASMR 或 Gallery 时只增加该模块独立 profile 的进程组。
3. 切回笔记/播放器后，该 child 的进程组在限定时间内完全退出。
4. 快速切换不会同时创建两个 child；窗口缩放、最大化与 DPI 变化保持内容边界一致。
5. 未保存编辑和进行中的导入会阻止销毁。
6. ASMR 发起播放后 child 可关闭，shell 中唯一播放器继续工作。
7. Gallery 网格不会在 `_MyVault/Cache/Gallery` 产生新缩略图；700+ 图片分页浏览不打开原图也能完成，关闭后 Gallery 进程组归零。
8. 应用退出时 shell 与任何 child 的 WebView2 进程均不残留。
