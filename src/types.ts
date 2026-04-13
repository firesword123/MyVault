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
};

export type GalleryImageEntry = {
  id: string;
  fileName: string;
  relativePath: string;
  folderPath: string;
  absolutePath: string;
  fileSize: number;
  updatedAt: number;
  tags: string[];
  note: string;
  isTrashed: boolean;
  originalFolderPath: string | null;
  deletedAt: number | null;
};

export type GalleryBootstrapPayload = {
  imagesRootPath: string;
  images: GalleryImageEntry[];
  folders: string[];
  tags: string[];
};

export type GalleryWorkspacePayload = {
  images: GalleryImageEntry[];
  folders: string[];
  tags: string[];
};
