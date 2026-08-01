/**
 * The panel operations features need to call back into: redrawing, opening and closing. The panel
 * owns these, so it registers them at start-up and features reach them through `panelActions` rather than
 * importing companion.ts and creating a cycle.
 */
export interface PanelActions {
  renderPanel(): void;
  renderPanelPreservingScroll(): void;
  refreshOpenPanel(): void;
  cancelPanelRefresh(): void;
  openPanel(tab: string): void;
  togglePanel(): void;
  closePanel(): void;
  activeTab(): string;
}

const notReady = () => {
  throw new Error('The Garden Companion panel is not ready yet.');
};

export let panelActions: PanelActions = {
  renderPanel: notReady,
  renderPanelPreservingScroll: notReady,
  refreshOpenPanel: notReady,
  cancelPanelRefresh: notReady,
  openPanel: notReady,
  togglePanel: notReady,
  closePanel: notReady,
  activeTab: () => '',
};

export function setPanelActions(actions: PanelActions): void {
  panelActions = actions;
}
