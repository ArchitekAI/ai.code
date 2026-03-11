import { create } from "zustand";

interface WorkspaceDockPanelMeta {
  dirty?: boolean;
}

interface WorkspaceDockPanelStoreState {
  metaByPanelId: Record<string, WorkspaceDockPanelMeta>;
  setMeta: (panelId: string, patch: WorkspaceDockPanelMeta) => void;
  clearMeta: (panelId: string) => void;
}

export const useWorkspaceDockPanelStore = create<WorkspaceDockPanelStoreState>()((set) => ({
  metaByPanelId: {},
  setMeta: (panelId, patch) =>
    set((state) => ({
      metaByPanelId: {
        ...state.metaByPanelId,
        [panelId]: {
          ...state.metaByPanelId[panelId],
          ...patch,
        },
      },
    })),
  clearMeta: (panelId) =>
    set((state) => {
      if (!state.metaByPanelId[panelId]) {
        return state;
      }
      const next = { ...state.metaByPanelId };
      delete next[panelId];
      return { metaByPanelId: next };
    }),
}));
