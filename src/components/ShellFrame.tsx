import type { ReactNode } from "react";
import type { LocaleMessages } from "../i18n";
import type { AppUiSpec } from "../ui-spec";
import { TitleBar } from "./TitleBar";

type ShellFrameProps = {
  spec: AppUiSpec;
  messages: LocaleMessages;
  activeModule: string;
  bodyContent: ReactNode;
  settingsPanel: ReactNode;
  onSelectModule: (moduleId: string) => void;
  onOpenSettings: () => void;
  showMemory?: boolean;
  memoryBytes?: number | null;
  processCount?: number | null;
  onMinimize?: () => void;
  onClose?: () => void;
  modulesDisabled?: boolean;
  experimental?: boolean;
};

export function ShellFrame({
  spec,
  messages,
  activeModule,
  bodyContent,
  settingsPanel,
  onSelectModule,
  onOpenSettings,
  showMemory,
  memoryBytes,
  processCount,
  onMinimize,
  onClose,
  modulesDisabled,
  experimental,
}: ShellFrameProps) {
  return (
    <div className="window-shell">
      <TitleBar
        brand={experimental ? `${messages.brand} · 实验版` : messages.brand}
        messages={messages}
        modules={modulesDisabled ? spec.modules.map((module) => ({ ...module, enabled: false })) : spec.modules}
        activeModule={activeModule}
        onSelectModule={onSelectModule}
        onOpenSettings={onOpenSettings}
        showSettings={false}
        showMemory={showMemory}
        memoryBytes={memoryBytes}
        processCount={processCount}
        onMinimize={onMinimize}
        onClose={onClose}
      />

      <div className="app-body">{bodyContent}</div>
      {settingsPanel}
    </div>
  );
}
