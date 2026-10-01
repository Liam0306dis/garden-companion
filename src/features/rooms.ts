import { panelActions } from '../panel-actions.js';
import { escapeHtml } from '../utils.js';

/** The Rooms tab: a list of public rooms fetched from the community API, with Discord avatars. */

interface RoomSlot { name?: string; avatar_url?: string }
interface RoomRow { id?: string; is_private?: boolean; players_count?: number; user_slots?: RoomSlot[] }

let roomRows: RoomRow[] | null = null, roomError = '', roomLoading = false;

/**
 * The Discord activity serves the game from its own origin with no room in the path, and there is
 * no command to move between rooms - joining is a navigation the activity cannot make. Listing
 * rooms nobody can join would only be a row of dead buttons, so the tab says so instead.
 */
function inDiscordActivity(): boolean {
  try { return location.hostname.endsWith('discordsays.com'); } catch { return false; }
}

function safeImageUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
  } catch { return ''; }
}

const ROOM_CAPACITY = 6;

/** A player chip: avatar (or initial) beside the name, so faces and names read as one unit. */
function roomPlayer(slot: RoomSlot): string {
  const url = safeImageUrl(slot?.avatar_url);
  const name = String(slot?.name || '').trim();
  const initial = name.slice(0, 1).toUpperCase() || '?';
  const face = url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : escapeHtml(initial);
  return `<span class="gc-room-player"><i class="gc-room-face">${face}</i><span>${escapeHtml(name || 'Unknown')}</span></span>`;
}

/**
 * Rooms opened from a Discord server carry ids like `I-<instance>-GC-<guild>-<channel>`: long,
 * unreadable, and alike at a glance. Those get a friendly title with the raw id kept underneath;
 * rooms with a hand-picked name show that name alone.
 */
function roomTitle(id: string): string {
  if (/^I-\d+-GC-\d+-\d+$/.test(id)) return `<h3>Discord room</h3><code title="${escapeHtml(id)}">${escapeHtml(id)}</code>`;
  return `<h3 class="gc-room-named">${escapeHtml(id)}</h3>`;
}

/** Six seat dots, filled for taken seats, plus a green "N open" label. */
function roomSeats(count: number): string {
  const taken = Math.max(0, Math.min(ROOM_CAPACITY, count));
  const open = ROOM_CAPACITY - taken;
  const dots = Array.from({ length: ROOM_CAPACITY }, (_, index) => `<i${index < taken ? ' class="on"' : ''}></i>`).join('');
  return `<div class="gc-room-seats" title="${taken}/${ROOM_CAPACITY} players"><span class="gc-room-dots">${dots}</span><b>${open} open</b></div>`;
}

export function renderRooms(): string {
  if (inDiscordActivity()) {
    return '<p class="gc-note">Room browsing is not available in the Discord activity: it has no way to move between rooms. Open the game in a browser to join another room.</p>';
  }
  if (!roomRows && !roomLoading && !roomError) void reloadRooms();
  const body = roomLoading ? '<p class="gc-empty">Loading rooms...</p>' : roomError ? `<p class="gc-empty">${escapeHtml(roomError)}</p>` : (roomRows || []).map(room => {
    const id = String(room.id || '');
    const slots = Array.isArray(room.user_slots) ? room.user_slots : [];
    const players = slots.map(roomPlayer).join('') || '<span class="gc-room-none">No visible players</span>';
    return `<article class="gc-card gc-room"><header><div class="gc-room-title">${roomTitle(id)}</div>${roomSeats(Number(room.players_count || 0))}<button class="gc-primary" data-join-room="${escapeHtml(id)}">Join</button></header><div class="gc-room-players">${players}</div></article>`;
  }).join('') || '<p class="gc-empty">No joinable rooms found.</p>';
  const count = roomRows && !roomLoading && !roomError ? `<b>${roomRows.length}</b> ${roomRows.length === 1 ? 'room' : 'rooms'} · ` : '';
  return `<div class="gc-row"><p class="gc-note">${count}Public rooms with one or two open slots.</p><button data-refresh-rooms>Refresh</button></div><section class="gc-stack">${body}</section>`;
}

function requestJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'GET', url, onload: response => { try { response.status >= 200 && response.status < 300 ? resolve(JSON.parse(response.responseText)) : reject(new Error(`Request failed (${response.status})`)); } catch (error) { reject(error); } }, onerror: () => reject(new Error('Network request failed')) }));
}

export async function reloadRooms(): Promise<void> {
  roomRows = null; roomLoading = true; roomError = ''; panelActions.refreshOpenPanel();
  try {
    const rows = await requestJson('https://ariesmod-api.ariedam.fr/rooms?limit=200');
    roomRows = Array.isArray(rows) ? rows
      .filter(room => !room.is_private && [4, 5].includes(Number(room.players_count)))
      .sort((left, right) => Number(right.players_count) - Number(left.players_count)) : [];
  } catch (error) { roomError = (error as Error).message; roomRows = []; }
  roomLoading = false;
  const panel = document.getElementById('gc-panel');
  if (panel && !panel.hidden && panelActions.activeTab() === 'rooms') panelActions.renderPanel();
}

export function bindRoomEvents(main: HTMLElement): void {
  main.querySelector('[data-refresh-rooms]')?.addEventListener('click', () => void reloadRooms());
  main.querySelectorAll<HTMLButtonElement>('[data-join-room]').forEach(button => button.onclick = () => {
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(button.dataset.joinRoom || '')) location.href = `/r/${button.dataset.joinRoom}`;
  });
}
