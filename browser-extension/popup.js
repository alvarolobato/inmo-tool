/**
 * popup.js — Main popup logic.
 * Captures HTML → sends to inmo-tool's capture endpoint → displays result.
 *
 * Forked from property_web_scraper's popup.js — see NOTICE.md. Haul
 * creation/history/limit-reached/no-key states are removed: there is
 * exactly one backend, always configured, no account model.
 */

const $ = (sel) => document.querySelector(sel);

const states = {
  loading: $('#state-loading'),
  unsupported: $('#state-unsupported'),
  error: $('#state-error'),
  results: $('#state-results'),
};

let extractedData = null;

// Processing happens in a separate backend service on its own poll cycle
// (etl/capture.py, ~10s interval, see the capture API route's docstring)
// — a human waiting in this popup shouldn't wait unboundedly for it.
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 20000;

function showState(name) {
  Object.entries(states).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function init() {
  showState('loading');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    showError('No se pudo acceder a la pestaña actual');
    return;
  }

  if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) {
    showState('unsupported');
    return;
  }

  let captured;
  try {
    captured = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_HTML' });
  } catch {
    // Content script not loaded (e.g. extension just installed) — inject it.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-script.js'],
      });
      captured = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_HTML' });
    } catch {
      showError('No se pudo capturar la página. Recarga y vuelve a intentarlo.');
      return;
    }
  }

  if (!captured?.html) {
    showError('No se recibió contenido HTML de la página');
    return;
  }

  let submitResult;
  try {
    submitResult = await chrome.runtime.sendMessage({
      type: 'EXTRACT',
      url: captured.url,
      html: captured.html,
    });
  } catch (err) {
    showError(err.message || 'La llamada a la API falló');
    return;
  }

  if (!submitResult?.success || !submitResult.capture_id) {
    showError(submitResult?.error?.message || 'No se pudo enviar la captura');
    return;
  }

  await pollForResult(submitResult.capture_id);
}

async function pollForResult(captureId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let status;
    try {
      status = await chrome.runtime.sendMessage({
        type: 'CHECK_CAPTURE_STATUS',
        captureId,
      });
    } catch (err) {
      showError(err.message || 'No se pudo consultar el estado');
      return;
    }

    if (!status?.success && status?.status !== 'failed') {
      showError(status?.error?.message || 'No se pudo consultar el estado');
      return;
    }

    if (status.status === 'failed') {
      showError(status.error?.message || 'La extracción falló');
      return;
    }

    if (status.status === 'done') {
      extractedData = status;
      renderResults(status);
      return;
    }

    // Still 'pending' — wait and check again.
    await sleep(POLL_INTERVAL_MS);
  }

  showError(
    'Todavía procesando — puede tardar unos segundos más de lo normal. ' +
      'Revisa el dashboard de Inmo-Tool en breve.',
  );
}

function showError(msg) {
  $('#error-message').textContent = msg;
  showState('error');
}

$('#retry-btn').addEventListener('click', init);

function renderResults(data) {
  const title = data.title || 'Anuncio de propiedad';
  $('#result-title').textContent = title.length > 60 ? title.slice(0, 57) + '…' : title;

  $('#result-price').textContent = data.price || 'Precio no disponible';

  const extracted = data.fields_extracted || 0;
  const available = data.fields_available || 0;
  const ratePercent = available > 0 ? Math.round((extracted / available) * 100) : 0;
  $('#result-rate').textContent = `${extracted}/${available} campos extraídos (${ratePercent}%)`;

  const link = $('#view-property-link');
  if (data.property_url) {
    link.href = data.property_url;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }

  showState('results');
}

$('#copy-json-btn').addEventListener('click', async () => {
  if (!extractedData) return;
  await navigator.clipboard.writeText(JSON.stringify(extractedData, null, 2));
  const btn = $('#copy-json-btn');
  const original = btn.innerHTML;
  btn.innerHTML = '✓ Copiado';
  setTimeout(() => {
    btn.innerHTML = original;
  }, 2000);
});

init();
