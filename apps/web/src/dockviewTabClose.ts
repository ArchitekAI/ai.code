import type { DockviewApi } from "dockview";

export const DOCKVIEW_CLOSE_TAB_REQUEST_EVENT = "t3code:dockview-close-tab";
export const DOCKVIEW_CLOSE_ACTIVE_TAB_REQUEST_EVENT = "t3code:dockview-close-active-tab";
export const DOCKVIEW_REOPEN_LAST_CLOSED_TAB_REQUEST_EVENT = "t3code:dockview-reopen-last-closed-tab";

export interface DockviewCloseTabRequestDetail {
  panelId: string;
}

let lastClosedThreadId: string | null = null;

export function rememberLastClosedThreadId(threadId: string): void {
  lastClosedThreadId = threadId;
}

export function getLastClosedThreadId(): string | null {
  return lastClosedThreadId;
}

export function requestCloseDockTab(panelId: string): void {
  window.dispatchEvent(
    new CustomEvent<DockviewCloseTabRequestDetail>(DOCKVIEW_CLOSE_TAB_REQUEST_EVENT, {
      detail: { panelId },
    }),
  );
}

export function closeActiveDockTab(
  dockviewApi: DockviewApi,
  closeDockPanel: (panelId: string) => boolean,
): void {
  const activePanel = dockviewApi.activePanel;
  if (activePanel) {
    closeDockPanel(activePanel.id);
  }
}
