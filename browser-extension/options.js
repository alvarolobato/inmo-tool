/**
 * options.js — Settings page logic.
 * API URL + admin key: this extension talks to exactly one self-hosted
 * inmo-tool backend (see NOTICE.md), authenticated with the same
 * ADMIN_API_KEY the dashboard's other admin surfaces use (Opus review,
 * PR #87 — the capture endpoint was previously unauthenticated).
 */

const $ = (sel) => document.querySelector(sel);

// batch.js (loaded before this script in options.html) publishes its pure
// scheduler API — including the defaults and the same clamp helpers the service
// worker uses — on `self.InmoBatch`. Using them here means the options page and
// the background loop validate the capture-tuning knobs identically (issue #410).
const IB = self.InmoBatch || {};

async function load() {
  const config = await chrome.storage.sync.get([
    'apiUrl',
    'apiKey',
    'autoCaptureEnabled',
    'batchConcurrency',
    'batchPaceBaseMs',
    'batchPaceSpreadMs',
    'batchBackgroundTabs',
    'autoBatchSize',
    'autoBatchTimeoutSec',
    'observeMode',
  ]);
  $('#api-url').value = config.apiUrl || 'http://localhost:4000';
  $('#api-key').value = config.apiKey || '';
  // Auto-capture defaults ON (issue #254): the human already installed a
  // capture extension and deliberately opened a listing-detail page, so
  // capturing it without a click is the intended flow. `undefined` (never
  // saved) therefore means checked.
  $('#auto-capture').checked = config.autoCaptureEnabled === undefined
    ? true
    : !!config.autoCaptureEnabled;

  // Capture-tuning knobs (issue #410). Show the clamped value (or the default
  // when never saved) so the field always reflects what the loop will actually
  // use.
  $('#batch-concurrency').value = IB.clampConcurrency
    ? IB.clampConcurrency(config.batchConcurrency)
    : (config.batchConcurrency || 3);
  $('#batch-pace-base').value = IB.clampPaceBase
    ? IB.clampPaceBase(config.batchPaceBaseMs)
    : (config.batchPaceBaseMs || 2000);
  $('#batch-pace-spread').value = IB.clampSpread
    ? IB.clampSpread(config.batchPaceSpreadMs)
    : (config.batchPaceSpreadMs ?? 5000);
  // Background-tab mode is opt-in: default OFF (safe active mode).
  $('#batch-background-tabs').checked = config.batchBackgroundTabs === true;

  // Passive search-URL observation (issue #488) defaults ON: an absent stored
  // value reads as enabled (mirrors content-script.js OBSERVE_DEFAULT / popup).
  $('#observe-mode').checked = config.observeMode === undefined
    ? true
    : !!config.observeMode;

  // Auto-mode knobs (issue #424) — clamped through the same batch.js helpers the
  // driver uses, so the field always reflects what the loop will actually use.
  $('#auto-batch-size').value = IB.clampAutoBatchSize
    ? IB.clampAutoBatchSize(config.autoBatchSize)
    : (config.autoBatchSize || 100);
  $('#auto-batch-timeout').value = IB.clampAutoTimeoutSec
    ? IB.clampAutoTimeoutSec(config.autoBatchTimeoutSec)
    : (config.autoBatchTimeoutSec || 60);
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

// The auto-capture toggle is independent of the API URL/key (no host-permission
// prompt to gate it on), so persist it immediately on change rather than making
// the user hit "Guardar".
$('#auto-capture').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ autoCaptureEnabled: e.target.checked });
  showStatus(e.target.checked ? 'Captura automática activada' : 'Captura automática desactivada', 'success');
});

// Passive search-URL observation (issue #488) — like auto-capture, independent
// of the API URL/key, so persist immediately on change. The content-script
// observer reads this on the next page it loads.
$('#observe-mode').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ observeMode: e.target.checked });
  showStatus(e.target.checked ? 'Modo observación activado' : 'Modo observación desactivado', 'success');
});

// ── Capture-tuning knobs (issue #410) ──────────────────────────────────────
// Like auto-capture, these need no host-permission prompt, so persist on
// change. Each value is CLAMPED through the same batch.js helper the loop uses
// (so a hostile/garbage input can never burst tabs or remove the WAF stagger),
// and the field is written back to the clamped value so the UI never lies about
// what will run.
$('#batch-concurrency').addEventListener('change', async (e) => {
  const clamped = IB.clampConcurrency
    ? IB.clampConcurrency(Number(e.target.value))
    : Number(e.target.value);
  e.target.value = clamped;
  await chrome.storage.sync.set({ batchConcurrency: clamped });
  showStatus(`Concurrencia: ${clamped}`, 'success');
});

$('#batch-pace-base').addEventListener('change', async (e) => {
  const clamped = IB.clampPaceBase
    ? IB.clampPaceBase(Number(e.target.value))
    : Number(e.target.value);
  e.target.value = clamped;
  await chrome.storage.sync.set({ batchPaceBaseMs: clamped });
  showStatus(`Espera base: ${clamped} ms`, 'success');
});

$('#batch-pace-spread').addEventListener('change', async (e) => {
  const clamped = IB.clampSpread
    ? IB.clampSpread(Number(e.target.value))
    : Number(e.target.value);
  e.target.value = clamped;
  await chrome.storage.sync.set({ batchPaceSpreadMs: clamped });
  showStatus(`Aleatoriedad: ${clamped} ms`, 'success');
});

$('#batch-background-tabs').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ batchBackgroundTabs: e.target.checked });
  showStatus(
    e.target.checked
      ? 'Modo segundo plano activado (experimental)'
      : 'Modo segundo plano desactivado',
    'success',
  );
});

// ── Auto-mode knobs (issue #424) ────────────────────────────────────────────
// Clamped through the same batch.js helpers the driver uses (a value below the
// 30 s alarm floor or above the caps can never take effect), and written back so
// the UI never lies about what will run.
$('#auto-batch-size').addEventListener('change', async (e) => {
  const clamped = IB.clampAutoBatchSize
    ? IB.clampAutoBatchSize(Number(e.target.value))
    : Number(e.target.value);
  e.target.value = clamped;
  await chrome.storage.sync.set({ autoBatchSize: clamped });
  showStatus(`Anuncios por lote: ${clamped}`, 'success');
});

$('#auto-batch-timeout').addEventListener('change', async (e) => {
  const clamped = IB.clampAutoTimeoutSec
    ? IB.clampAutoTimeoutSec(Number(e.target.value))
    : Number(e.target.value);
  e.target.value = clamped;
  await chrome.storage.sync.set({ autoBatchTimeoutSec: clamped });
  showStatus(`Espera entre lotes: ${clamped} s`, 'success');
});

load();
