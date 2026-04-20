export type NoteSummary = {
  id: string;
  title: string;
  relativePath: string;
  folderPath: string;
  isDraft: boolean;
  isTrashed: boolean;
  updatedAt: number;
  preview: string;
  originalFolderPath: string | null;
  deletedAt: number | null;
};

export type NoteDetail = {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  relativePath: string;
  folderPath: string;
  isDraft: boolean;
  isTrashed: boolean;
  originalFolderPath: string | null;
  deletedAt: number | null;
};

export type BootstrapPayload = {
  vaultPath: string;
  notes: NoteSummary[];
  folders: string[];
  settings: AppSettings;
};

export type WorkspacePayload = {
  notes: NoteSummary[];
  folders: string[];
};

export type AppSettings = {
  language: string;
  showNoteTime: boolean;
  colorPresets: string[];
  colorPresetCount: number;
  closeBehavior: "quit" | "tray";
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxy: string;
  notesState: {
    selectedNoteId: string;
  };
  persistentModules: string[];
};
