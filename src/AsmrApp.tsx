import { AsmrWorkspace } from "./components/AsmrWorkspace";
import { TitleBar } from "./components/TitleBar";
import { resolveMessages } from "./i18n";
import "./styles/global.css";
import "./styles/asmr.css";

export function AsmrApp() {
  const messages = resolveMessages("zh-CN");

  return (
    <div className="app-shell asmr-app-shell">
      <div className="window-shell">
        <TitleBar
          brand={`${messages.brand} · ${messages.moduleAsmrLabel}`}
          messages={messages}
          modules={[]}
          activeModule="asmr"
          onSelectModule={() => undefined}
          onOpenSettings={() => undefined}
          showSettings={false}
        />
        <div className="app-body">
          <AsmrWorkspace />
        </div>
      </div>
    </div>
  );
}
