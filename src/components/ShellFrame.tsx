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
}: ShellFrameProps) {
  return (
    <div className="window-shell">
      <TitleBar
        brand={messages.brand}
        messages={messages}
        modules={spec.modules}
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
