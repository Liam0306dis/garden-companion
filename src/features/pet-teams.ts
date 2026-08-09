import type { Pet, PetTeamEmblem } from '../types.js';
import { abilityChips } from '../ability-chips.js';
import { config } from '../config.js';
import { ABILITY_DETAILS, MAX_PET_TEAMS, MAX_TEAM_PETS, PET_CATALOG } from '../constants.js';
import { send } from '../game-connection.js';
import { bindListSearch } from '../list-search.js';
import { page } from '../page.js';
import { panelActions } from '../panel-actions.js';
import { activePets, allPets, petMetrics, petSprite } from '../pets.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { escapeHtml, humanize } from '../utils.js';

/**
 * The Pet Teams tab and the create/edit team popout. Saving, activating and deleting all go through
 * the game, so nothing here is authoritative: a request is sent and the panel catches up when the
 * server reports the change back.
 */
export function teams() { return state.slot?.data?.petTeams || []; }

const EMBLEM_ICONS = ['rainbow', 'gold', 'thunder', 'dawn', 'amber', 'wet', 'chilled', 'frozen', 'coin', 'egg'];
const EMBLEM_LETTERS = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));

let teamPickerSelection: Set<string> | null = null;
let teamPickerEmblem: PetTeamEmblem | null = null;
let teamPickerEmblemKind: 'number' | 'icon' | 'pet' = 'number';
let editingTeamId: string | null = null;
let pendingTeamSave: { teamId: string | null; name: string; petIds: string[]; emblem?: PetTeamEmblem | null } | null = null;
let confirmDeleteTeamId: string | null = null;
let pendingTeamDeleteId: string | null = null;

function emblemKey(emblem: PetTeamEmblem | null | undefined): string {
  if (!emblem) return '';
  if (emblem.type === 'number') return `number:${emblem.number}`;
  if (emblem.type === 'pet') return `pet:${emblem.petSpecies}`;
  return `icon:${emblem.icon}`;
}

function emblemFromKey(key: string): PetTeamEmblem | null {
  const [kind, value] = key.split(':', 2);
  if (kind === 'number') return { type: 'number', number: Number(value) };
  if (kind === 'pet') return { type: 'pet', petSpecies: value };
  if (kind === 'icon') return { type: 'icon', icon: value };
  return null;
}

function emblemLabel(emblem: PetTeamEmblem | null | undefined): string {
  if (!emblem) return '';
  if (emblem.type === 'number') return EMBLEM_LETTERS[emblem.number - 1] || String(emblem.number);
  if (emblem.type === 'pet') return PET_CATALOG[emblem.petSpecies]?.name || humanize(emblem.petSpecies);
  return humanize(emblem.icon);
}

function setPetTeamEmblem(teamId: string, emblem: PetTeamEmblem): void {
  send({ type: 'SetPetTeamEmblem', teamId, emblem });
}

export function saveTeam(name, petIds, teamId = null) {
  if (!name.trim() || petIds.length < 1 || petIds.length > MAX_TEAM_PETS) throw new Error(`Choose a name and one to ${MAX_TEAM_PETS} pets.`);
  if (!teamId && teams().length >= MAX_PET_TEAMS) throw new Error(`The game allows ${MAX_PET_TEAMS} pet teams.`);
  send({ type: 'SavePetTeam', teamId, name: name.trim(), petIds });
}

export function closeTeamPicker(): void {
  teamPickerSelection = null;
  teamPickerEmblem = null;
  editingTeamId = null;
  document.getElementById('gc-team-picker')?.remove();
}

function updateTeamPickerCount(picker: HTMLElement): void {
  const count = teamPickerSelection?.size ?? 0;
  const counter = picker.querySelector<HTMLElement>('[data-picker-count]');
  if (counter) {
    counter.textContent = count >= MAX_TEAM_PETS ? `${count} of ${MAX_TEAM_PETS} selected - team full` : `${count} of ${MAX_TEAM_PETS} selected`;
    counter.dataset.tone = count ? 'good' : '';
  }
  picker.querySelectorAll<HTMLInputElement>('[data-pet-id]').forEach(input => {
    const full = count >= MAX_TEAM_PETS && !input.checked;
    input.disabled = full;
    input.closest('label')?.classList.toggle('gc-pet-locked', full);
  });
  const save = picker.querySelector<HTMLButtonElement>('[data-save-team]');
  if (save) save.disabled = count < 1 || count > MAX_TEAM_PETS;
}

function emblemIconMarkup(icon: string): string {
  const sprite = page.__gardenCompanionEmblemSprites?.[icon];
  return sprite
    ? `<img src="${escapeHtml(sprite)}" alt=""><small>${escapeHtml(humanize(icon))}</small>`
    : `<i data-emblem-icon="${escapeHtml(icon)}"></i><small>${escapeHtml(humanize(icon))}</small>`;
}

function emblemChip(emblem: PetTeamEmblem): string {
  if (emblem.type === 'icon') {
    const sprite = page.__gardenCompanionEmblemSprites?.[emblem.icon];
    if (sprite) return `<span class="gc-team-emblem"><img src="${escapeHtml(sprite)}" alt="${escapeHtml(humanize(emblem.icon))}" title="${escapeHtml(humanize(emblem.icon))}"></span>`;
  }
  if (emblem.type === 'pet') {
    const sprite = page.__gardenCompanionPetSprites?.[emblem.petSpecies];
    if (sprite) return `<span class="gc-team-emblem"><img src="${escapeHtml(sprite)}" alt="${escapeHtml(emblemLabel(emblem))}" title="${escapeHtml(emblemLabel(emblem))}"></span>`;
  }
  return `<span class="gc-team-emblem">${escapeHtml(emblemLabel(emblem))}</span>`;
}

function selectedTeamSpecies(): string[] {
  const chosen = teamPickerSelection ?? new Set<string>();
  const species = allPets().filter(pet => chosen.has(pet.id)).map(pet => pet.petSpecies);
  return [...new Set(species)];
}

function takenEmblemNumbers(): Set<number> {
  return new Set(teams()
    .filter(team => team.id !== editingTeamId && team.emblem?.type === 'number')
    .map(team => (team.emblem as { number: number }).number));
}

function renderEmblemOptions(): string {
  const selected = emblemKey(teamPickerEmblem);
  const option = (key: string, inner: string, title: string, disabled = false) =>
    `<button data-emblem-option="${escapeHtml(key)}" data-active="${key === selected}" title="${escapeHtml(title)}" ${disabled ? 'disabled' : ''}>${inner}</button>`;
  const taken = takenEmblemNumbers();
  const letters = EMBLEM_LETTERS.map((letter, index) => option(
    `number:${index + 1}`,
    `<b>${letter}</b>`,
    taken.has(index + 1) ? `${letter} is used by another team` : `Letter ${letter}`,
    taken.has(index + 1),
  )).join('');
  const icons = EMBLEM_ICONS.map(icon => option(`icon:${icon}`, emblemIconMarkup(icon), humanize(icon))).join('');
  const species = selectedTeamSpecies();
  const pets = species.length ? species.map(name => {
    const sprite = page.__gardenCompanionPetSprites?.[name];
    const label = PET_CATALOG[name]?.name || humanize(name);
    const inner = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : `<b>${escapeHtml(label.slice(0, 1))}</b>`;
    return option(`pet:${name}`, inner, label);
  }).join('') : '<p class="gc-emblem-hint">Choose pets first. A pet emblem has to be a species on the team.</p>';
  const groups: Array<[string, string]> = [['number', letters], ['icon', icons], ['pet', pets]];
  const tabs = groups.map(([kind]) => `<button data-emblem-kind="${kind}" class="${kind === teamPickerEmblemKind ? 'active' : ''}">${kind === 'number' ? 'Letters' : kind === 'icon' ? 'Icons' : 'Pets'}</button>`).join('');
  const strips = groups.map(([kind, markup]) => `<div class="gc-emblem-strip" data-emblem-group="${kind}" ${kind === teamPickerEmblemKind ? '' : 'hidden'}>${markup}</div>`).join('');
  const current = teamPickerEmblem ? `Emblem: ${escapeHtml(emblemLabel(teamPickerEmblem))}` : 'No emblem selected';
  return `<div class="gc-emblem-head"><span>Team emblem</span><div class="gc-emblem-tabs">${tabs}</div><small data-emblem-current>${current}</small></div>${strips}`;
}

function refreshEmblemUi(picker: HTMLElement): void {
  const species = new Set(selectedTeamSpecies());
  if (teamPickerEmblem?.type === 'pet' && !species.has(teamPickerEmblem.petSpecies)) teamPickerEmblem = null;
  const petGroup = picker.querySelector<HTMLElement>('[data-emblem-group=pet]');
  if (petGroup) {
    petGroup.innerHTML = species.size ? [...species].map(name => {
      const sprite = page.__gardenCompanionPetSprites?.[name];
      const label = PET_CATALOG[name]?.name || humanize(name);
      const inner = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : `<b>${escapeHtml(label.slice(0, 1))}</b>`;
      return `<button data-emblem-option="pet:${escapeHtml(name)}" title="${escapeHtml(label)}">${inner}</button>`;
    }).join('') : '<p class="gc-emblem-hint">Choose pets first. A pet emblem has to be a species on the team.</p>';
    petGroup.querySelectorAll<HTMLButtonElement>('[data-emblem-option]').forEach(button => button.onclick = () => {
      const key = button.dataset.emblemOption!;
      teamPickerEmblem = emblemFromKey(key);
      refreshEmblemUi(picker);
    });
  }
  const selected = emblemKey(teamPickerEmblem);
  picker.querySelectorAll<HTMLButtonElement>('[data-emblem-option]').forEach(button => {
    button.dataset.active = String(button.dataset.emblemOption === selected);
  });
  picker.querySelectorAll<HTMLButtonElement>('[data-emblem-kind]').forEach(button => {
    button.classList.toggle('active', button.dataset.emblemKind === teamPickerEmblemKind);
  });
  picker.querySelectorAll<HTMLElement>('[data-emblem-group]').forEach(group => {
    group.hidden = group.dataset.emblemGroup !== teamPickerEmblemKind;
  });
  const current = picker.querySelector<HTMLElement>('[data-emblem-current]');
  if (current) current.textContent = teamPickerEmblem ? `Emblem: ${emblemLabel(teamPickerEmblem)}` : 'No emblem selected';
}

export function openTeamPicker(teamId: string | null | undefined): void {
  const team = teamId ? teams().find(entry => entry.id === teamId) ?? null : null;
  editingTeamId = team?.id ?? null;
  teamPickerSelection = new Set(team?.members.map(member => member.petId) ?? []);
  teamPickerEmblem = team?.emblem ?? null;
  teamPickerEmblemKind = teamPickerEmblem?.type ?? 'number';
  document.getElementById('gc-team-picker')?.remove();
  const picker = document.createElement('div');
  picker.id = 'gc-team-picker';
  picker.innerHTML = `<div class="gc-team-picker-shell"><header><div><small>PET TEAM</small><h2>${team ? 'Edit team' : 'Create team'}</h2></div><button data-picker-close aria-label="Close">x</button></header><div class="gc-team-picker-controls"><input data-team-name placeholder="Team name" maxlength="32" value="${escapeHtml(team?.name || '')}"><input class="gc-search" data-team-search placeholder="Filter by pet name, species, location, or ability"><span class="gc-team-picker-count" data-picker-count></span></div><section class="gc-emblem-picker">${renderEmblemOptions()}</section><div class="gc-pet-grid gc-filter-list gc-team-picker-grid">${petPickerRows(teamPickerSelection) || '<p class="gc-empty">No pet data yet.</p>'}</div><footer><button data-picker-cancel>Cancel</button><button class="gc-primary" data-save-team>${team ? 'Save changes' : 'Save team'}</button></footer></div>`;
  document.body.appendChild(picker);
  bindTeamPickerEvents(picker);
  updateTeamPickerCount(picker);
  picker.querySelector<HTMLInputElement>('[data-team-name]')?.focus();
}

function bindTeamPickerEvents(picker: HTMLElement): void {
  picker.querySelector<HTMLButtonElement>('[data-picker-close]')!.onclick = closeTeamPicker;
  picker.querySelector<HTMLButtonElement>('[data-picker-cancel]')!.onclick = closeTeamPicker;
  picker.onpointerdown = event => { if (event.target === picker) closeTeamPicker(); };
  picker.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); closeTeamPicker(); } };
  picker.querySelectorAll<HTMLInputElement>('[data-pet-id]').forEach(input => input.onchange = () => {
    const petId = input.dataset.petId!;
    input.checked ? teamPickerSelection?.add(petId) : teamPickerSelection?.delete(petId);
    updateTeamPickerCount(picker);
    refreshEmblemUi(picker);
  });
  bindListSearch(picker.querySelector('[data-team-search]'));
  picker.querySelectorAll<HTMLButtonElement>('[data-emblem-kind]').forEach(button => button.onclick = () => {
    teamPickerEmblemKind = button.dataset.emblemKind as typeof teamPickerEmblemKind;
    refreshEmblemUi(picker);
  });
  picker.querySelectorAll<HTMLButtonElement>('[data-emblem-option]').forEach(button => button.onclick = () => {
    const key = button.dataset.emblemOption!;
    teamPickerEmblem = emblemFromKey(key);
    refreshEmblemUi(picker);
  });
  picker.querySelector<HTMLButtonElement>('[data-save-team]')!.onclick = () => {
    try {
      const name = picker.querySelector<HTMLInputElement>('[data-team-name]')!.value.trim();
      const petIds = [...(teamPickerSelection ?? [])].sort();
      const teamId = editingTeamId;
      const emblem = teamPickerEmblem;
      const team = teamId ? teams().find(entry => entry.id === teamId) ?? null : null;
      saveTeam(name, petIds, teamId);
      if (teamId && emblem && emblemKey(emblem) !== emblemKey(team?.emblem)) setPetTeamEmblem(teamId, emblem);
      pendingTeamSave = { teamId, name, petIds, emblem: teamId ? null : emblem };
      toast(teamId ? 'Team update requested.' : 'Team save requested.', 'success');
      closeTeamPicker();
      panelActions.renderPanel();
    } catch (error) { toast((error as Error).message, 'error'); }
  };
}

function petPickerRows(selectedIds: Set<string>): string {
  return allPets().map(pet => {
    const abilityText = (pet.abilities || []).flatMap(ability => [ability, ABILITY_DETAILS[ability]?.name || humanize(ability)]).join(' ');
    const filterText = `${pet.name || ''} ${pet.petSpecies} ${PET_CATALOG[pet.petSpecies]?.name || ''} ${pet.location} ${abilityText}`.toLowerCase();
    const metrics = petMetrics(pet);
    const strength = metrics ? `<b class="gc-pet-str">${metrics.strength}<i>/${metrics.maxStrength}</i></b>` : '';
    return `<label data-filter-text="${escapeHtml(filterText)}"><input type="checkbox" data-pet-id="${escapeHtml(pet.id)}" ${selectedIds.has(pet.id) ? 'checked' : ''}>${petSprite(pet)}<span><b>${escapeHtml(pet.name || PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies))}</b><small>${escapeHtml(humanize(pet.petSpecies))} | ${escapeHtml(pet.location)}</small>${(pet.abilities || []).length ? abilityChips(pet.abilities || []) : '<span class="gc-team-abilities">No abilities</span>'}</span>${strength}</label>`;
  }).join('');
}

/**
 * Every team whose members are exactly the pets currently out. Teams are matched on their pets, so
 * two teams holding the same pets under different names are both "active" and cannot be told apart.
 */
export function activeTeamIds(): string[] {
  const activeIds = new Set(activePets().map(pet => pet.id));
  if (!activeIds.size) return [];
  return teams()
    .filter(team => team.members.length === activeIds.size && team.members.every(member => activeIds.has(member.petId)))
    .map(team => team.id);
}

export function activeTeamId(): string | null {
  return activeTeamIds()[0] ?? null;
}

function teamMemberTile(member: { petId: string; petSpecies: string; name?: string | null }, owned?: Pet): string {
  const sprite = petSprite(owned ?? { id: member.petId, petSpecies: member.petSpecies, hunger: 0 } as Pet);
  const label = member.name || PET_CATALOG[member.petSpecies]?.name || humanize(member.petSpecies);
  const abilities = (owned?.abilities || []).map(ability => ABILITY_DETAILS[ability]?.name || humanize(ability));
  const detail = owned ? abilities.join(' | ') || 'No abilities' : 'Pet not found in your inventory';
  const strength = petMetrics(owned)?.maxStrength;
  const meta = owned ? `${humanize(member.petSpecies)}${strength ? ` | STR ${strength}` : ''}` : 'Missing pet';
  return `<span class="gc-team-pet${owned ? '' : ' is-missing'}" title="${escapeHtml(`${label} - ${detail}`)}">${sprite}<span><b>${escapeHtml(label)}</b><small>${escapeHtml(meta)}</small>${abilityChips(owned?.abilities || [])}</span></span>`;
}

/**
 * Teams are ordered by their position in the game's own list, which is what the keybinds and the
 * cycle shortcut walk through, so the order is worth controlling rather than being whatever order
 * they happened to be saved in.
 */
export function moveTeam(teamId: string, offset: number): void {
  const order = teams();
  const index = order.findIndex(team => team.id === teamId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= order.length) return;
  pendingTeamOrder = order.map(team => team.id).join(',');
  send({ type: 'MovePetTeam', movePetTeamId: teamId, toPetTeamIndex: target });
}

export function renderTeams(): string {
  const full = teams().length >= MAX_PET_TEAMS;
  const active = activeTeamId();
  const owned = new Map(allPets().map(pet => [pet.id, pet]));
  const cards = teams().map((team, index, order) => {
    const isActive = team.id === active;
    const reorder = `<span class="gc-team-order"><button data-move-team="${escapeHtml(team.id)}" data-move-offset="-1" title="Move up" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>&#9650;</button><button data-move-team="${escapeHtml(team.id)}" data-move-offset="1" title="Move down" aria-label="Move down" ${index === order.length - 1 ? 'disabled' : ''}>&#9660;</button></span>`;
    const filled = team.members.map(member => teamMemberTile(member, owned.get(member.petId))).join('');
    const empty = Array.from({ length: Math.max(0, MAX_TEAM_PETS - team.members.length) },
      () => '<span class="gc-team-pet is-empty"><i>+</i><span><b>Empty slot</b></span></span>').join('');
    const deleteControls = confirmDeleteTeamId === team.id
      ? `<span class="gc-team-delete-confirm"><b>Delete this team?</b><button data-cancel-delete-team>Cancel</button><button class="gc-danger" data-confirm-delete-team="${escapeHtml(team.id)}">Delete team</button></span>`
      : `<button class="gc-danger" data-delete-team="${escapeHtml(team.id)}">Delete</button>`;
    const keybind = config.teamKeybinds[team.id];
    return `<article class="gc-card gc-team-card" data-team-card="${escapeHtml(team.id)}" data-active="${isActive}"><div class="gc-team-head">${team.emblem ? emblemChip(team.emblem) : '<span class="gc-team-emblem is-empty">--</span>'}<span class="gc-team-title"><h3>${escapeHtml(team.name)}</h3><small>${team.members.length} pet${team.members.length === 1 ? '' : 's'}${keybind ? ` | key ${escapeHtml(keybind)}` : ''}</small></span>${isActive ? '<span class="gc-team-active">Active</span>' : ''}<span class="gc-team-size">${team.members.length}/${MAX_TEAM_PETS}</span><div class="gc-team-actions">${reorder}<button data-edit-team="${escapeHtml(team.id)}">Edit</button><button class="gc-primary" data-apply-team="${escapeHtml(team.id)}" ${isActive ? 'disabled' : ''}>${isActive ? 'Activated' : 'Activate'}</button></div></div><div class="gc-team-pets">${filled}${empty}</div><div class="gc-team-foot">${deleteControls}</div></article>`;
  }).join('');
  const activeName = teams().find(team => team.id === active)?.name;
  const summary = teams().length
    ? `<span class="gc-team-summary-line"><b>${teams().length}</b> of ${MAX_PET_TEAMS} teams${activeName ? ` | running <b>${escapeHtml(activeName)}</b>` : ' | no saved team is active'}</span>`
    : '<span class="gc-team-summary-line">Save a team to swap your active pets in one click.</span>';
  return `<div class="gc-team-bar">${summary}<button class="gc-primary" data-open-team-picker ${full ? 'disabled' : ''}>Create team</button></div>${full ? `<p class="gc-note">The game allows ${MAX_PET_TEAMS} teams. Delete one to create another.</p>` : ''}<section class="gc-stack">${cards || '<p class="gc-empty">No saved teams yet. Create one to swap your active pets in a single click.</p>'}</section>`;
}

/** Redraw key for the Pet Teams tab, so a live refresh only rebuilds when something visible moved. */
export function teamsSignature(): string {
  // The array order is part of the key, so a reorder redraws even though nothing else changed.
  return JSON.stringify([confirmDeleteTeamId, teams().map(team =>
    [team.id, team.name, emblemKey(team.emblem), team.members.map(member => `${member.petId}:${member.name || ''}`)])]);
}

export function requestTeamDelete(teamId: string): void {
  pendingTeamDeleteId = teamId;
  confirmDeleteTeamId = null;
  send({ type: 'DeletePetTeam', teamId });
}

export function askDeleteConfirmation(teamId: string | null): void {
  confirmDeleteTeamId = teamId;
  panelActions.renderPanelPreservingScroll();
}

/** The save is only confirmed once the server reports a team matching what we asked for. */
export function refreshCompletedTeamSave(): void {
  if (!pendingTeamSave) return;
  const expected = pendingTeamSave;
  const saved = teams().find(team => {
    if (expected.teamId ? team.id !== expected.teamId : team.name !== expected.name) return false;
    const members = team.members.map(member => member.petId).sort();
    return members.length === expected.petIds.length && members.every((petId, index) => petId === expected.petIds[index]);
  });
  if (!saved) return;
  if (expected.emblem && emblemKey(expected.emblem) !== emblemKey(saved.emblem)) setPetTeamEmblem(saved.id, expected.emblem);
  pendingTeamSave = null;
  const panel = document.getElementById('gc-panel');
  if (panel && !panel.hidden && panelActions.activeTab() === 'teams') panelActions.renderPanel();
}

let pendingTeamOrder: string | null = null;

/**
 * A reorder is only real once the game sends the new order back, and by then the pointer is sitting
 * over the team list, which is exactly when the live refresh stands down so a scroll is not yanked.
 * So the redraw is forced here instead, when the order we asked for actually arrives.
 */
export function refreshCompletedTeamMove(): void {
  if (pendingTeamOrder === null) return;
  const order = teams().map(team => team.id).join(',');
  if (order === pendingTeamOrder) return;
  pendingTeamOrder = null;
  const panel = document.getElementById('gc-panel');
  if (panel && !panel.hidden && panelActions.activeTab() === 'teams') panelActions.renderPanelPreservingScroll();
}

export function refreshCompletedTeamDelete(): void {
  if (!pendingTeamDeleteId || teams().some(team => team.id === pendingTeamDeleteId)) return;
  const deletedTeamId = pendingTeamDeleteId;
  pendingTeamDeleteId = null;
  const panel = document.getElementById('gc-panel');
  if (!panel || panel.hidden || panelActions.activeTab() !== 'teams') return;
  const cards = [...panel.querySelectorAll<HTMLElement>('[data-team-card]')];
  const deletedCard = cards.find(card => card.dataset.teamCard === deletedTeamId);
  if (deletedCard && cards.length > 1) deletedCard.remove();
  else panelActions.renderPanelPreservingScroll();
}

/** Activating a team only changes which card is marked, so the tab is patched instead of rebuilt. */
export function refreshTeamActiveMarkers(): void {
  const panel = document.getElementById('gc-panel');
  if (!panel || panel.hidden || panelActions.activeTab() !== 'teams') return;
  const active = activeTeamId();
  panel.querySelectorAll<HTMLElement>('[data-team-card]').forEach(card => {
    const isActive = card.dataset.teamCard === active;
    const apply = card.querySelector<HTMLButtonElement>('[data-apply-team]');
    const label = isActive ? 'Activated' : 'Activate';
    if (apply && apply.textContent !== label) apply.textContent = label;
    if (apply && apply.disabled !== isActive) apply.disabled = isActive;
    if (card.dataset.active === String(isActive)) return;
    card.dataset.active = String(isActive);
    const head = card.querySelector('.gc-team-head');
    const pill = card.querySelector<HTMLElement>('.gc-team-active');
    if (isActive && !pill && head) {
      const badge = document.createElement('span');
      badge.className = 'gc-team-active';
      badge.textContent = 'Active';
      head.insertBefore(badge, head.querySelector('.gc-team-size'));
    } else if (!isActive && pill) pill.remove();
  });
}

export function bindPetTeamEvents(main: HTMLElement): void {
  main.querySelector('[data-open-team-picker]')?.addEventListener('click', () => openTeamPicker(null));
  main.querySelectorAll<HTMLButtonElement>('[data-edit-team]').forEach(button => button.onclick = () => openTeamPicker(button.dataset.editTeam));
  main.querySelectorAll<HTMLButtonElement>('[data-apply-team]').forEach(button => button.onclick = () => {
    send({ type: 'ApplyPetTeam', teamId: button.dataset.applyTeam });
    toast('Team activation requested.', 'success');
    button.disabled = true;
    button.textContent = 'Activating...';
  });
  main.querySelectorAll<HTMLButtonElement>('[data-move-team]').forEach(button => button.onclick = () => {
    // Disabled straight away: the reorder only lands when the game echoes the new order back, and
    // a second click before then would be measured against a list that has not moved yet.
    button.disabled = true;
    try { moveTeam(button.dataset.moveTeam!, Number(button.dataset.moveOffset)); }
    catch (error) { toast((error as Error).message, 'error'); }
  });
  main.querySelectorAll<HTMLButtonElement>('[data-delete-team]').forEach(button => button.onclick = () => askDeleteConfirmation(button.dataset.deleteTeam ?? null));
  main.querySelector('[data-cancel-delete-team]')?.addEventListener('click', () => askDeleteConfirmation(null));
  main.querySelector('[data-confirm-delete-team]')?.addEventListener('click', event => {
    const button = event.currentTarget as HTMLButtonElement;
    const teamId = button.dataset.confirmDeleteTeam;
    if (!teamId) return;
    button.disabled = true;
    button.textContent = 'Deleting...';
    requestTeamDelete(teamId);
    toast('Team deletion requested.', 'success');
  });
}
