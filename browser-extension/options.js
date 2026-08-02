/**
 * options.js — Settings page logic.
 * API URL + admin key: this extension talks to exactly one self-hosted
 * inmo-tool backend (see NOTICE.md), authenticated with the same
 * ADMIN_API_KEY the dashboard's other admin surfaces use (Opus review,
 * PR #87 — the capture endpoint was previously unauthenticated).
 */

const $ = (sel) => document.querySelector(sel);

async function load() {
  const config = await chrome.storage.sync.get(['apiUrl', 'apiKey']);
  $('#api-url').value = config.apiUrl || 'http://localhost:4000';
  $('#api-key').value = config.apiKey || '';
}

function showStatus(msg, kind) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status show ${kind}`;
  setTimeout(() => {
    el.className = 'status';
  }, 2500);
}

/**
 * `host_permissions` only ever pre-declares localhost/127.0.0.1 + the
 * supported portals — a real LAN address (e.g. 192.168.1.x) isn't covered,
 * and manifest.json can't express every possible LAN range statically.
 * Rather than fail silently on the first capture attempt (the previous
 * behavior — Opus review, PR #87), request the specific origin via the
 * `optional_host_permissions` declared in manifest.json at save time, and
 * tell the user plainly if they decline.
 */
async function ensureHostPermission(apiUrl) {
  const origin = new URL(apiUrl).origin + '/*';
  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return true;
  return chrome.permissions.request({ origins: [origin] });
}

$('#save-btn').addEventListener('click', async () => {
  const apiUrl = ($('#api-url').value || '').trim().replace(/\/+$/, '');
  const apiKey = ($('#api-key').value || '').trim();
  if (!apiUrl) {
    showStatus('La URL no puede estar vacía', 'error');
    return;
  }
  try {
    new URL(apiUrl);
  } catch {
    showStatus('URL inválida', 'error');
    return;
  }

  let granted;
  try {
    granted = await ensureHostPermission(apiUrl);
  } catch {
    showStatus('No se pudo comprobar el permiso para esa dirección', 'error');
    return;
  }
  if (!granted) {
    showStatus('Permiso denegado para esa dirección — no se ha guardado', 'error');
    return;
  }

  await chrome.storage.sync.set({ apiUrl, apiKey });
  showStatus('Guardado', 'success');
});

load();
