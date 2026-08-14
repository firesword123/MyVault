import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FolderInput,
  Images,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type GalleryItem = {
  relativePath: string;
  fileName: string;
  originalPath: string;
  thumbnailPath: string;
};

type GalleryPage = {
  galleryPath: string;
  items: GalleryItem[];
  totalItems: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type ImportResult = {
  imported: number;
  skipped: number;
};

const PAGE_SIZE = 48;
const IMAGE_FILTERS = [
  {
    name: "图片",
    extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"],
  },
];

function selectedPaths(selection: string | string[] | null) {
  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}

export function GalleryWorkspace() {
  const [payload, setPayload] = useState<GalleryPage | null>(null);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("正在加载图库…");
  const requestId = useRef(0);

  const loadPage = useCallback(async (page: number) => {
    const currentRequest = ++requestId.current;
    setBusy(true);
    try {
      const next = await invoke<GalleryPage>("list_gallery", {
        input: { page, pageSize: PAGE_SIZE },
      });
      if (currentRequest !== requestId.current) return;
      setPayload(next);
      setMessage(next.totalItems > 0 ? `共 ${next.totalItems} 张图片` : "图库中还没有图片");
    } catch (error) {
      if (currentRequest !== requestId.current) return;
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (currentRequest === requestId.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadPage(1);
  }, [loadPage]);

  useEffect(() => {
    if (!preview || !payload) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreview(null);
        return;
      }
      const index = payload.items.findIndex((item) => item.relativePath === preview.relativePath);
      if (event.key === "ArrowLeft" && index > 0) {
        setPreview(payload.items[index - 1]);
      } else if (event.key === "ArrowRight" && index >= 0 && index < payload.items.length - 1) {
        setPreview(payload.items[index + 1]);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [payload, preview]);

  async function importPaths(paths: string[]) {
    if (paths.length === 0) return;
    setBusy(true);
    setMessage("正在导入图片…");
    try {
      const result = await invoke<ImportResult>("import_gallery", { input: { paths } });
      const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 项` : "";
      await loadPage(1);
      setMessage(`已导入 ${result.imported} 张图片${skipped}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  async function chooseImages() {
    const selection = await open({ multiple: true, directory: false, filters: IMAGE_FILTERS });
    await importPaths(selectedPaths(selection));
  }

  async function chooseFolder() {
    const selection = await open({ multiple: false, directory: true });
    await importPaths(selectedPaths(selection));
  }

  async function deletePreviewedImage() {
    if (!preview || !payload) return;
    if (!window.confirm(`永久删除图库中的图片？\n\n${preview.relativePath}`)) return;
    const nextPage = payload.items.length === 1 && payload.page > 1 ? payload.page - 1 : payload.page;
    try {
      setBusy(true);
      await invoke("delete_gallery_image", {
        input: { relativePath: preview.relativePath },
      });
      setPreview(null);
      await loadPage(nextPage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  return (
    <main className="gallery-workspace">
      <header className="gallery-toolbar">
        <div className="gallery-heading">
          <span className="gallery-heading-icon"><Images size={20} /></span>
          <div>
            <h1>图库</h1>
            <p>{message}</p>
          </div>
        </div>
        <div className="gallery-actions">
          <button type="button" className="gallery-secondary-button" disabled={busy} onClick={() => void chooseFolder()}>
            <FolderInput size={16} />
            导入文件夹
          </button>
          <button type="button" className="gallery-primary-button" disabled={busy} onClick={() => void chooseImages()}>
            <FilePlus2 size={16} />
            导入图片
          </button>
        </div>
      </header>

      <section className={`gallery-content ${busy ? "is-busy" : ""}`} aria-busy={busy}>
        {payload && payload.items.length > 0 ? (
          <div className="gallery-grid">
            {payload.items.map((item) => (
              <button
                type="button"
                className="gallery-card"
                key={item.relativePath}
                title={item.relativePath}
                onClick={() => setPreview(item)}
              >
                <span className="gallery-thumbnail-frame">
                  <img
                    src={convertFileSrc(item.thumbnailPath)}
                    alt={item.fileName}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                </span>
                <span className="gallery-card-name">{item.fileName}</span>
                <span className="gallery-card-path">{item.relativePath}</span>
              </button>
            ))}
          </div>
        ) : !busy ? (
          <div className="gallery-empty">
            <Images size={38} strokeWidth={1.4} />
            <h2>导入第一批图片</h2>
            <p>图片将复制到 MyVaultData/Gallery，原文件不会被修改。</p>
            <button type="button" className="gallery-primary-button" onClick={() => void chooseImages()}>
              <FilePlus2 size={16} />
              选择图片
            </button>
          </div>
        ) : null}
        {busy ? <div className="gallery-loading">处理中…</div> : null}
      </section>

      {payload && payload.totalItems > 0 ? (
        <footer className="gallery-pagination">
          <span className="gallery-storage-path" title={payload.galleryPath}>{payload.galleryPath}</span>
          <div>
            <button
              type="button"
              aria-label="上一页"
              disabled={busy || payload.page <= 1}
              onClick={() => void loadPage(payload.page - 1)}
            >
              <ChevronLeft size={17} />
            </button>
            <span>{payload.page} / {payload.totalPages}</span>
            <button
              type="button"
              aria-label="下一页"
              disabled={busy || payload.page >= payload.totalPages}
              onClick={() => void loadPage(payload.page + 1)}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </footer>
      ) : null}

      {preview ? (
        <div className="gallery-preview" role="dialog" aria-modal="true" aria-label={preview.fileName}>
          <button type="button" className="gallery-preview-close" aria-label="关闭预览" onClick={() => setPreview(null)}>
            <X size={20} />
          </button>
          <img src={convertFileSrc(preview.originalPath)} alt={preview.fileName} draggable={false} />
          <div className="gallery-preview-footer">
            <div>
              <strong>{preview.fileName}</strong>
              <span>{preview.relativePath}</span>
            </div>
            <button type="button" className="gallery-delete-button" disabled={busy} onClick={() => void deletePreviewedImage()}>
              <Trash2 size={16} />
              删除图片
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
