# MyVault Architecture Notes

MyVault is a local-first file view and editor. User data stays independently usable under `MyVaultData`; the application is never the only way to reach it.

## Rendering boundaries

MyVault has one native window and three WebView2 profiles:

| Profile | Content | Lifetime |
| --- | --- | --- |
| `shell` | Title bar, notes, settings, lightweight player | Main window lifetime |
| `asmr` | DL_ASMR library, import, metadata, cover and file browser | Only while DL_ASMR is selected |
| `gallery` | Gallery grid, import and explicit original preview | Only while Gallery is selected |

ASMR and Gallery are native child WebViews placed inside the shell window. They are not routes, React tabs, iframes, hidden pages or separate top-level windows. Selecting Notes or Player closes the active child controller; selecting the other heavy module closes the old child before creating the new one.

This boundary is intentional: JavaScript cleanup cannot guarantee that Chromium returns decoded image, font, GPU and allocator memory to the OS. Closing the WebView2 controller lets its independently profiled process group exit, which is the measurable release mechanism.

A real-library ASMR check on 2026-09-04 reached about 2 GiB while loading original high-resolution artwork, then returned to the roughly 500 MiB shell baseline after switching modules. This confirms the lifecycle boundary; it is not a fixed memory ceiling.

## Module rules

- Keep lightweight, frequently used UI in `shell`.
- Put media grids or other historically high-watermark renderers in a releasable child WebView with its own profile.
- Never cache an inactive child page. Persist only small navigation values such as page number or selected ID when that becomes useful.
- Long-running work belongs in Rust or a deliberately designed service. A hidden WebView is not a service.
- A module with unsaved edits or active import may set a close guard; shell switching must honor it.
- Validate resource release with process-group exit, not only DOM removal, JS heap snapshots or working-set trimming.

## Persistent audio

The single `<audio>` element and queue live in the shell so playback can continue after DL_ASMR closes. DL_ASMR sends only bounded metadata and validated file paths inside the active Vault. Closing the player pauses, removes `src`, calls `load()`, clears its queue and unmounts the component.

The player does not create another WebView or native window. It is the deliberate exception to “close the heavy view when switching,” because background playback is an explicit product behavior.

## Gallery and native thumbnail reuse

Gallery is paged. Its grid requests thumbnails from Windows Shell through `IShellItemImageFactory`, allowing Explorer and MyVault to share the operating system's thumbnail cache. MyVault does not create a parallel JPEG cache. Returned `HBITMAP` handles are copied into ephemeral responses and released immediately.

Original files load only after explicit preview. Large-original preview peaks are treated separately from grid/cache behavior: first prove that closing the Gallery profile reclaims the renderer group, then optimize peak usage without weakening the lifecycle boundary.

## Data and profile placement

`MyVaultData` contains user-owned notes, DL_ASMR works, Gallery originals, settings, manifests and migration reports. It does not contain WebView2 profiles or newly generated Gallery thumbnails.

Notes are versioned JSON block documents. The initial format supports one `richText` block per note; new block types can extend the ordered `blocks` array without changing folder ownership.

WebView2 profiles live below the application's local-data directory and remain separate from user-owned Vault data.

Data-root resolution order is: `MYVAULT_DATA_ROOT`, optional `myvault.data-route.json` beside the executable, then the platform build default. Debug builds default to `.dev-data/MyVaultData`; packaged builds default to `MyVaultData` beside the application directory.

## Feature checklist

Before adding a feature:

1. Is it light enough to remain in shell for the whole app lifetime?
2. Does it decode many images, video, audio visualization or other large render assets?
3. Must any work continue after its UI closes?
4. What exact process/profile boundary proves release?
5. Can a Windows native service or file handler replace app-owned indexing, conversion or caching?

Prefer OS facilities where they preserve the “everything is a file” model. Add app-owned derivatives only when native behavior is insufficient and the fallback has explicit ownership, invalidation and cleanup rules.
