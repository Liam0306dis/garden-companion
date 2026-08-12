import { abilityChips } from '../ability-chips.js';
import { EGG_CATALOG, MUTATION_CATALOG, PET_CATALOG, PLANT_CATALOG, plantName, RARITY_ORDER, rarityRank } from '../constants.js';
import { bindListSearch } from '../list-search.js';
import { page } from '../page.js';
import { panelActions } from '../panel-actions.js';
import { produceSprite } from '../pets.js';
import { state } from '../state.js';
import { escapeHtml, humanize, NUMBER_LOCALE } from '../utils.js';

/**
 * A flat view of the game's own journal. The game stores which variants of each species you have
 * logged and when, but only one species at a time is visible in its modal; this lays every species
 * out at once so gaps are obvious without clicking through.
 *
 * The game records first sightings only, so nothing here is a count.
 */

/** Variant ids as the game stores them. Normal and Max Weight are not mutations, so they have no sprite. */
const KNOWN_PRODUCE_VARIANTS = [
  'Normal', 'Wet', 'Chilled', 'Frozen', 'Dawnlit', 'Ambershine', 'Thunderstruck',
  'Gold', 'Rainbow', 'Dawncharged', 'Ambercharged', 'Thundercharged', 'Max Weight',
];
const PET_VARIANTS = ['Normal', 'Gold', 'Rainbow', 'Max Weight'];

/**
 * Read fresh each render: a mutation the game adds arrives in the catalog while we are running, and
 * it should get a column rather than being silently absent. Max Weight stays last.
 */
function produceVariants(): string[] {
  const known = new Set(KNOWN_PRODUCE_VARIANTS);
  const extra = Object.keys(MUTATION_CATALOG).filter(id => !known.has(id));
  if (!extra.length) return KNOWN_PRODUCE_VARIANTS;
  return [...KNOWN_PRODUCE_VARIANTS.slice(0, -1), ...extra, 'Max Weight'];
}

type Kind = 'plants' | 'pets';

let journalTab: Kind = 'plants';
let incompleteOnly = false;
let journalSearch = '';

export function setJournalTab(tab: string): void {
  if (tab === 'plants' || tab === 'pets') journalTab = tab;
}

export function toggleIncompleteOnly(): void {
  incompleteOnly = !incompleteOnly;
}

/** Redraw only when the visible journal source changes. */
export function journalSignature(): string {
  return JSON.stringify([journalTab, state.slot?.data?.journal ?? null]);
}

/**
 * The game shows a mutation's display name, which differs from the id it stores it under. The two
 * non-mutation variants read differently per tab: a plant is measured by size, a pet by strength.
 */
function variantLabel(variant: string, kind: Kind): string {
  if (variant === 'Max Weight') return kind === 'pets' ? 'Max Strength' : 'Max Size';
  return MUTATION_CATALOG[variant]?.name || variant;
}

function variantChip(variant: string, kind: Kind, logged: boolean, at?: number): string {
  const label = variantLabel(variant, kind);
  const sprite = page.__gardenCompanionMutationSprites?.[variant];
  const seen = logged && at ? `\nFound at ${new Date(at).toLocaleDateString()}` : '';
  const title = `${label}${logged ? '' : ' - not logged'}${seen}`;
  const inner = sprite
    ? `<img src="${escapeHtml(sprite)}" alt="">`
    : `<b>${escapeHtml(variant === 'Max Weight' ? 'MAX' : label.slice(0, 1))}</b>`;
  return `<span class="gc-journal-chip" data-logged="${logged}" title="${escapeHtml(title)}">${inner}</span>`;
}

interface LoggedVariant { variant?: string; createdAt?: number }
interface JournalEntry { variantsLogged?: LoggedVariant[]; abilitiesLogged?: Array<{ ability?: string; createdAt?: number }> }

function journalSection(kind: 'produce' | 'pets'): Record<string, JournalEntry> {
  return (state.slot?.data?.journal?.[kind] || {}) as Record<string, JournalEntry>;
}

function loggedAt(entry: JournalEntry | undefined): Map<string, number> {
  const found = new Map<string, number>();
  for (const row of entry?.variantsLogged || []) {
    if (row?.variant && !found.has(row.variant)) found.set(row.variant, Number(row.createdAt) || 0);
  }
  return found;
}

function speciesRow(options: {
  id: string;
  name: string;
  sprite: string;
  variants: string[];
  logged: Map<string, number>;
  rarity: string;
  kind: Kind;
  extra?: string;
}): string {
  const { id, name, sprite, variants, logged, rarity, kind, extra = '' } = options;
  const have = variants.filter(variant => logged.has(variant)).length;
  const complete = have === variants.length;
  const chips = variants.map(variant => variantChip(variant, kind, logged.has(variant), logged.get(variant))).join('');
  return `<article class="gc-journal-row" data-complete="${complete}" data-rarity="${escapeHtml(rarity)}" data-filter-text="${escapeHtml(`${name} ${id} ${rarity}`.toLowerCase())}">
<span class="gc-journal-head"><span class="gc-shop-sprite">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}</span><span><b>${escapeHtml(name)}</b><small>${have}/${variants.length}${complete ? ' complete' : ''}</small></span></span>
<span class="gc-journal-chips">${chips}</span>${extra}</article>`;
}

/**
 * A titled block of species. The group repeats its own members in the filter text so searching for
 * one species keeps the heading it sits under.
 */
function speciesGroup(label: string, sprite: string, members: string[], rows: string): string {
  if (!rows) return '';
  return `<div class="gc-journal-group" data-filter-text="${escapeHtml(`${label} ${members.join(' ')}`.toLowerCase())}">
<h4 class="gc-journal-group-head">${sprite ? `<span class="gc-shop-sprite"><img src="${escapeHtml(sprite)}" alt=""></span>` : ''}${escapeHtml(label)}</h4>
${rows}</div>`;
}

function plantRows(): { rows: string; have: number; total: number } {
  const journal = journalSection('produce');
  const PRODUCE_VARIANTS = produceVariants();
  // Component species (stormcaps) only grow inside another plant, so they get no journal entry.
  const species = Object.keys(PLANT_CATALOG).filter(name => !PLANT_CATALOG[name]?.component);
  let have = 0;

  const rows = RARITY_ORDER.map(rarity => {
    // Catalog order inside a rarity, which is the order the game itself lists crops in.
    const inRarity = species.filter(name => (PLANT_CATALOG[name]?.rarity || 'Common') === rarity);
    const markup = inRarity.map(name => {
      const logged = loggedAt(journal[name]);
      have += PRODUCE_VARIANTS.filter(variant => logged.has(variant)).length;
      return speciesRow({
        id: name,
        name: plantName(name),
        sprite: produceSprite(name),
        variants: PRODUCE_VARIANTS,
        logged,
        rarity,
        kind: 'plants',
      });
    }).join('');
    return speciesGroup(rarity, '', inRarity.map(name => plantName(name)).concat(inRarity), markup);
  }).join('');

  return { rows, have, total: species.length * PRODUCE_VARIANTS.length };
}

/**
 * Pets are grouped by the egg they hatch from, in the order the game lists them. A species can
 * appear in more than one egg (Horse is in both the Dawn and Horse eggs), so the first egg in this
 * order claims it. WinterEgg is the old name for what is now SnowEgg, so only SnowEgg is listed.
 */
const EGG_ORDER = ['CommonEgg', 'UncommonEgg', 'RareEgg', 'LegendaryEgg', 'SnowEgg', 'DawnEgg', 'HorseEgg', 'MythicalEgg', 'ThunderEgg'];

function petRows(): { rows: string; have: number; total: number } {
  const journal = journalSection('pets');
  const claimed = new Set<string>();
  let have = 0;
  let counted = 0;

  const renderSpecies = (name: string) => {
    const entry = journal[name];
    const logged = loggedAt(entry);
    have += PET_VARIANTS.filter(variant => logged.has(variant)).length;
    counted += 1;
    const abilities = [...new Set((entry?.abilitiesLogged || []).map(row => row?.ability).filter(Boolean) as string[])];
    const extra = `<span class="gc-journal-abilities">${abilities.length
      ? abilityChips(abilities)
      : '<small>No abilities logged</small>'}</span>`;
    return speciesRow({
      id: name,
      name: PET_CATALOG[name]?.name || humanize(name),
      sprite: page.__gardenCompanionPetSprites?.[name] || '',
      variants: PET_VARIANTS,
      logged,
      rarity: PET_CATALOG[name]?.rarity || 'Common',
      kind: 'pets',
      extra,
    });
  };

  const group = (label: string, eggId: string, species: string[]) => speciesGroup(
    label,
    eggId ? page.__gardenCompanionShopSprites?.[eggId] || '' : '',
    species.map(name => PET_CATALOG[name]?.name || humanize(name)).concat(species),
    species.map(renderSpecies).join(''),
  );

  const groups = EGG_ORDER.map(eggId => {
    const weights = EGG_CATALOG[eggId]?.spawnWeights || {};
    // Most likely first, which is the order the game shows a hatch table in.
    const species = Object.keys(weights)
      .filter(name => PET_CATALOG[name] && !claimed.has(name))
      .sort((left, right) => (weights[right] || 0) - (weights[left] || 0));
    for (const name of species) claimed.add(name);
    return group(EGG_CATALOG[eggId]?.name || humanize(eggId), eggId, species);
  }).join('');

  const rest = Object.keys(PET_CATALOG)
    .filter(name => !claimed.has(name))
    .sort((left, right) => rarityRank(PET_CATALOG[left]?.rarity) - rarityRank(PET_CATALOG[right]?.rarity) || (PET_CATALOG[left]?.name || left).localeCompare(PET_CATALOG[right]?.name || right));

  const rows = groups + group('Other', '', rest);
  return { rows, have, total: counted * PET_VARIANTS.length };
}

export function renderJournal(): string {
  const { rows, have, total } = journalTab === 'pets' ? petRows() : plantRows();
  const percent = total ? Math.round(have / total * 100) : 0;
  const tabs = [['plants', 'Plants'], ['pets', 'Pets']]
    .map(([id, label]) => `<button data-journal-tab="${id}" class="${id === journalTab ? 'active' : ''}">${label}</button>`).join('');
  return `<p class="gc-note">Every variant the game has logged for you, laid out at once. Hover a chip for its name and the date it was found.</p>
<div class="gc-shop-tabs">${tabs}</div>
<section class="gc-card gc-journal-summary"><span><b>${have.toLocaleString(NUMBER_LOCALE)}</b> of ${total.toLocaleString(NUMBER_LOCALE)} logged</span><span class="gc-pill">${percent}%</span></section>
<div class="gc-row"><input class="gc-search" data-journal-search placeholder="Search ${journalTab === 'pets' ? 'pets' : 'plants'}" value="${escapeHtml(journalSearch)}"><button data-journal-incomplete data-active="${incompleteOnly}" title="${incompleteOnly ? 'Show every species again' : 'Hide species you have already completed'}">${incompleteOnly ? 'All' : 'Missing'}</button></div>
<div class="gc-journal-list gc-filter-list" data-incomplete-only="${incompleteOnly}">${rows || '<p class="gc-empty">No journal data yet.</p>'}</div>`;
}

export function bindJournalEvents(main: HTMLElement): void {
  main.querySelectorAll<HTMLButtonElement>('[data-journal-tab]').forEach(button => button.onclick = () => {
    setJournalTab(button.dataset.journalTab || '');
    panelActions.renderPanel();
  });
  main.querySelector('[data-journal-incomplete]')?.addEventListener('click', () => {
    toggleIncompleteOnly();
    panelActions.renderPanelPreservingScroll();
  });
  const search = main.querySelector<HTMLInputElement>('[data-journal-search]');
  bindListSearch(search);
  search?.addEventListener('input', () => { journalSearch = search.value; });
}
