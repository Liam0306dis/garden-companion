/**
 * Wires a search box to the `.gc-filter-list` beside it, hiding rows whose `data-filter-text` does
 * not contain the query. Applied immediately so a redraw keeps the current filter.
 */
export function bindListSearch(input: HTMLInputElement | null): void {
  if (!input) return;
  const list = input.parentElement?.querySelector('.gc-filter-list') ?? input.closest('section, #gc-team-picker')?.querySelector('.gc-filter-list');
  const apply = () => {
    const query = input.value.trim().toLowerCase();
    list?.querySelectorAll<HTMLElement>('[data-filter-text]').forEach(row => { row.hidden = Boolean(query && !row.dataset.filterText?.includes(query)); });
  };
  input.oninput = apply;
  apply();
}
