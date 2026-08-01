import { panelActions } from '../panel-actions.js';
import { escapeHtml } from '../utils.js';

/** The Rooms tab: a list of public rooms fetched from the community API, with Discord avatars. */

let roomRows = null, roomError = '', roomLoading = false;

function safeImageUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
  } catch { return ''; }
}

function roomAvatars(slots: Array<{ name?: string; avatar_url?: string }>): string {
  const faces = slots.map(slot => {
    const url = safeImageUrl(slot?.avatar_url);
    const name = String(slot?.name || '').trim();
    const initial = name.slice(0, 1).toUpperCase() || '?';
    const inner = url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : escapeHtml(initial);
    return `<span class="gc-room-face" title="${escapeHtml(name || 'Unknown player')}">${inner}</span>`;
  }).join('');
  return faces ? `<div class="gc-room-faces">${faces}</div>` : '';
}

export function renderRooms() {
  if (!roomRows && !roomLoading && !roomError) void reloadRooms();
  const body = roomLoading ? '<p class="gc-empty">Loading rooms...</p>' : roomError ? `<p class="gc-empty">${escapeHtml(roomError)}</p>` : (roomRows || []).map(room => {
    const slots = Array.isArray(room.user_slots) ? room.user_slots : [];
    const names = slots.map(slot => escapeHtml(slot.name)).filter(Boolean).join(', ') || 'No visible players';
    return `<article class="gc-card gc-room"><div><h3>${escapeHtml(room.id)}</h3>${roomAvatars(slots)}<p>${names}</p></div><span class="gc-pill">${Number(room.players_count || 0)}/6</span><button data-join-room="${escapeHtml(room.id)}">Join</button></article>`;
  }).join('') || '<p class="gc-empty">No joinable rooms found.</p>';
  return `<div class="gc-row"><p class="gc-note">Public rooms with one or two open slots.</p><button data-refresh-rooms>Refresh</button></div><section class="gc-stack">${body}</section>`;
}

function requestJson(url) {
  return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'GET', url, onload: response => { try { response.status >= 200 && response.status < 300 ? resolve(JSON.parse(response.responseText)) : reject(new Error(`Request failed (${response.status})`)); } catch (error) { reject(error); } }, onerror: () => reject(new Error('Network request failed')) }));
}

export async function reloadRooms() {
  roomRows = null; roomLoading = true; roomError = ''; panelActions.refreshOpenPanel();
  try {
    const rows = await requestJson('https://ariesmod-api.ariedam.fr/rooms?limit=200');
    roomRows = Array.isArray(rows) ? rows
      .filter(room => !room.is_private && [4, 5].includes(Number(room.players_count)))
      .sort((left, right) => Number(right.players_count) - Number(left.players_count)) : [];
  } catch (error) { roomError = error.message; roomRows = []; }
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
