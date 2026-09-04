export type ModuleItem = {
  id: string;
  enabled: boolean;
};

export type ThemeSpec = {
  bodyFont: string;
  displayFont: string;
  shellBackground: string;
  panelBackground: string;
  panelBorder: string;
  accentGradient: string;
  accentSoft: string;
  accentStrong: string;
  textPrimary: string;
  textMuted: string;
  dangerSoft: string;
  dangerText: string;
  shadow: string;
};

export type LayoutSpec = {
  titlebarHeight: string;
  railWidth: string;
  shellGap: string;
  shellPadding: string;
  panelRadius: string;
  controlRadius: string;
};

export type AppUiSpec = {
  modules: ModuleItem[];
  theme: ThemeSpec;
  layout: LayoutSpec;
};

export const appUiSpec: AppUiSpec = {
  modules: [
    { id: "notes", enabled: true },
    { id: "player", enabled: true },
    { id: "asmr", enabled: true },
    { id: "gallery", enabled: true },
  ],
  theme: {
    bodyFont:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
    displayFont:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
    shellBackground: "#f5f4f0",
    panelBackground: "#ffffff",
    panelBorder: "rgba(0, 0, 0, 0.08)",
    accentGradient:
      "linear-gradient(135deg, rgba(101, 132, 255, 0.12), rgba(56, 189, 248, 0.12))",
    accentSoft: "rgba(107, 92, 231, 0.13)",
    accentStrong: "#6b5ce7",
    textPrimary: "#29261f",
    textMuted: "#757064",
    dangerSoft: "rgba(211, 84, 80, 0.12)",
    dangerText: "#d35450",
    shadow: "0 10px 30px rgba(30, 25, 15, 0.08)",
  },
  layout: {
    titlebarHeight: "42px",
    railWidth: "270px",
    shellGap: "0px",
    shellPadding: "0px",
    panelRadius: "14px",
    controlRadius: "9px",
  },
};
