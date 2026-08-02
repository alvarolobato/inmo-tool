/**
 * options.js — Settings page logic.
 * Just the API URL: this extension talks to exactly one self-hosted
 * inmo-tool backend, no account/API-key model (see NOTICE.md).
 */

const $ = (sel) => document.querySelector(sel);

async function load() {
  const config = await chrome.storage.sync.get(['apiUrl']);
  $('#api-url').value = config.apiUrl || 'http://localhost:4000';
}

function showStatus(msg, kind) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status show ${kind}`;
  setTimeout(() => {
    el.className = 'status';
  }, 2000);
}

$('#save-btn').addEventListener('click', async () => {
  const apiUrl = ($('#api-url').value || '').trim().replace(/\/+$/, '');
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
  await chrome.storage.sync.set({ apiUrl });
  showStatus('Guardado', 'success');
});

load();
