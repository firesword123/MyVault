import { GalleryWorkspace } from "./components/GalleryWorkspace";
import { TitleBar } from "./components/TitleBar";
import { resolveMessages } from "./i18n";
import { isEmbeddedModule } from "./useEmbeddedGuard";
import "./styles/global.css";
import "./styles/gallery.css";

export function GalleryApp() {
  const messages = resolveMessages("zh-CN");

  return (
    <div className={`app-shell gallery-app-shell ${isEmbeddedModule ? "embedded-module" : ""}`}>
      <div className="window-shell">
        {!isEmbeddedModule && <TitleBar
          brand={`${messages.brand} · ${messages.moduleGalleryLabel}`}
          messages={messages}
          modules={[]}
          activeModule="gallery"
          onSelectModule={() => undefined}
          onOpenSettings={() => undefined}
          showSettings={false}
        />}
        <div className="app-body">
          <GalleryWorkspace />
        </div>
      </div>
    </div>
  );
}
