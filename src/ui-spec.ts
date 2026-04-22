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
    { id: "asmr", enabled: true },
  ],
  theme: {
    bodyFont: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    displayFont: '"Segoe UI Semibold", "PingFang SC", sans-serif',
    shellBackground: "linear-gradient(180deg, #ffffff 0%, #fbfbfc 46%, #f5f6f8 100%)",
    panelBackground: "rgba(255, 255, 255, 0.88)",
    panelBorder: "#e7e9ee",
    accentGradient:
      "linear-gradient(135deg, rgba(101, 132, 255, 0.12), rgba(56, 189, 248, 0.12))",
    accentSoft: "#eef2ff",
    accentStrong: "#5b6df8",
    textPrimary: "#2f3640",
    textMuted: "#6b7280",
    dangerSoft: "#fff1f0",
    dangerText: "#c04d42",
    shadow: "0 10px 30px rgba(15, 23, 42, 0.04)",
  },
  layout: {
    titlebarHeight: "38px",
    railWidth: "270px",
    shellGap: "0px",
    shellPadding: "0px",
    panelRadius: "14px",
    controlRadius: "10px",
  },
};
