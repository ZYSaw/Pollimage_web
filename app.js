// ---------------------------------------------------------------------------
// Safe localStorage helpers (storage can be blocked, full, or unavailable)
// ---------------------------------------------------------------------------
const storage = {
  get(key, fallback = '') {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (_) {}
  }
};

// Escape text that comes from outside (model names, descriptions) before putting it in HTML
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Small DOM helper: builds elements with textContent so user text is never parsed as HTML
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Theme Management
function initTheme() {
  const savedTheme = storage.get('theme', '');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  storage.set('theme', next);
}

// Initialize theme on load
initTheme();

// State
const state = {
  apiKey: storage.get('pollinations_api_key'),
  history: [],          // entries loaded from IndexedDB (newest first)
  isGenerating: false,
  current: null,        // { prompt, blob } for the image shown in the result panel
  currentUrl: null,     // object URL for that image
  // Batch generation state
  batchMode: false,
  batchCount: 4,
  batchResults: [],
  batchProgress: { current: 0, total: 0 }
};

// Default config
const defaults = {
  model: 'zimage',
  width: 1024,
  height: 1024,
  seed: -1,
  enhance: false,
  nologo: true,
  safe: false,
  quality: 'high'
};

// Available models (image only) - fetched dynamically from API
let imageModels = [];
let imageModelDetails = [];

// Fallback models in case API fails
const fallbackModels = [
  'z-image-turbo', 'z-image', 'zimage', 'flux', 'klein', 'klein-large', 'turbo',
  'gptimage', 'gptimage-large', 'kontext',
  'seedream', 'seedream-pro', 'nanobanana', 'nanobanana-pro'
];

// Fetch models from API
async function fetchImageModels() {
  try {
    const res = await fetch('https://gen.pollinations.ai/image/models');
    if (!res.ok) throw new Error('Failed to fetch models');
    const models = await res.json();
    // Filter for image output models only
    imageModelDetails = models.filter(m =>
      m.output_modalities && m.output_modalities.includes('image')
    );
    imageModels = imageModelDetails.map(m => m.name);
  } catch (e) {
    console.warn('Failed to fetch models, using fallback:', e);
    imageModels = fallbackModels;
    imageModelDetails = [];
  }
}

// Quality options
const qualityOptions = ['low', 'medium', 'high', 'hd'];

// Blob to Base64
function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function extFromType(type) {
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  return map[type] || 'png';
}

function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// History storage (IndexedDB). Stores the real image, a small thumbnail and the
// settings used, so history survives expired keys and never has to regenerate.
// ---------------------------------------------------------------------------
const DB_NAME = 'pollimage';
const DB_STORE = 'history';
const HISTORY_LIMIT = 50;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // Allow a retry on the next call if opening failed
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

// Runs `run(store)` in a transaction; resolves with the request result (if run returns a request)
async function dbTx(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    let result;
    const req = run(tx.objectStore(DB_STORE));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function dbTrim() {
  const keys = await dbTx('readonly', (s) => s.getAllKeys());
  const extra = keys.length - HISTORY_LIMIT;
  if (extra > 0) {
    const oldest = keys.slice().sort((a, b) => a - b).slice(0, extra);
    await dbTx('readwrite', (s) => { oldest.forEach((k) => s.delete(k)); });
  }
}

async function loadHistory() {
  const all = await dbTx('readonly', (s) => s.getAll());
  state.history = (all || []).sort((a, b) => b.id - a.id);
}

// Old versions kept history in localStorage as { prompt, url } with the API key inside the URL.
// Keep the prompts (without the keyed URLs) and remove the old storage entry.
async function migrateLegacyHistory() {
  const raw = storage.get('pollinations_history', null);
  if (raw === null) return;
  let items = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) items = parsed;
  } catch (_) {}
  const prompts = items
    .map((item) => item && item.prompt)
    .filter((prompt) => typeof prompt === 'string' && prompt);
  // Oldest first, so newer entries get higher ids
  for (const prompt of prompts.slice().reverse()) {
    await dbTx('readwrite', (s) => s.add({
      prompt, legacy: true, createdAt: Date.now(), image: null, thumb: null, params: null
    }));
  }
  await dbTrim();
  storage.remove('pollinations_history');
}

async function makeThumbnail(blob, size = 192) {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } catch (_) {
    return null; // the full image is used as the thumbnail instead
  }
}

function pickParams(p) {
  return {
    model: p.model, width: p.width, height: p.height,
    seed: p.seed, quality: p.quality, negativePrompt: p.negativePrompt
  };
}

// Adds an entry to history. If IndexedDB fails the entry still lives in memory for this session.
async function saveToHistory(prompt, params, blob) {
  const entry = {
    prompt,
    params: pickParams(params),
    createdAt: Date.now(),
    image: blob,
    thumb: await makeThumbnail(blob)
  };
  try {
    entry.id = await dbTx('readwrite', (s) => s.add(entry));
    await dbTrim();
  } catch (e) {
    console.warn('History could not be saved to IndexedDB:', e);
    entry.id = `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  state.history.unshift(entry);
  state.history = state.history.slice(0, HISTORY_LIMIT);
}

async function deleteFromHistory(entry) {
  state.history = state.history.filter((h) => h !== entry);
  renderHistoryPanel();
  try {
    await dbTx('readwrite', (s) => s.delete(entry.id));
  } catch (e) {
    console.warn('Could not delete history entry:', e);
  }
}

async function clearHistory() {
  if (!confirm('Clear all history?')) return;
  state.history = [];
  renderHistoryPanel();
  try {
    await dbTx('readwrite', (s) => s.clear());
  } catch (e) {
    console.warn('Could not clear history:', e);
  }
}

// Load an entry back into the form and show its image
function loadFromHistory(entry) {
  const setField = (id, value) => {
    const field = document.getElementById(id);
    if (!field || value === undefined || value === null) return;
    if (field.tagName === 'SELECT' && ![...field.options].some((o) => o.value === String(value))) return;
    field.value = value;
  };
  setField('prompt', entry.prompt);
  const p = entry.params || {};
  setField('model', p.model);
  setField('width', p.width);
  setField('height', p.height);
  setField('seed', p.seed);
  setField('quality', p.quality);
  setField('negativePrompt', p.negativePrompt);
  if (entry.image) showImage(entry.image, entry.prompt);
}

// Modal functions
function openModal() {
  document.getElementById('apiModal').classList.add('show');
  document.getElementById('apiKey').value = state.apiKey;
}

function closeModal() {
  document.getElementById('apiModal').classList.remove('show');
}

// Render params panel
function renderParamsPanel() {
  const modelOpts = imageModels.map(m => {
    const detail = imageModelDetails.find(d => d.name === m);
    const label = detail ? `${m} - ${detail.description}` : m;
    const selected = m === defaults.model ? 'selected' : '';
    return `<option value="${esc(m)}" ${selected}>${esc(label)}</option>`;
  }).join('');
  const qualityOpts = qualityOptions.map(q =>
    `<option value="${q}" ${q === defaults.quality ? 'selected' : ''}>${q}</option>`
  ).join('');

  document.getElementById('params-panel').innerHTML = `
    <div class="sidebar-header"><h2>Parameters</h2></div>
    <div class="sidebar-content">
      <div class="form-section">
        <div class="form-group">
          <label>Prompt</label>
          <textarea id="prompt" placeholder="Describe the image you want to generate..."></textarea>
        </div>
        <div class="form-group">
          <label>Negative Prompt</label>
          <input type="text" id="negativePrompt" value="worst quality, blurry" placeholder="Things to avoid...">
        </div>
      </div>
      <div class="form-section">
        <div class="form-group">
          <label>Model</label>
          <select id="model">${modelOpts}</select>
        </div>
        <button class="btn btn-primary" id="generateBtn" onclick="handleGenerate()" style="margin-bottom: 10px;">✦ Generate</button>
        <div class="row">
          <div class="form-group">
            <label>Width</label>
            <input type="number" id="width" value="${defaults.width}" min="64" max="2048">
          </div>
          <div class="form-group">
            <label>Height</label>
            <input type="number" id="height" value="${defaults.height}" min="64" max="2048">
          </div>
        </div>
        <div class="row">
          <div class="form-group">
            <label>Seed</label>
            <input type="number" id="seed" value="${defaults.seed}" min="-1" placeholder="-1 for random">
          </div>
          <div class="form-group">
            <label>Quality</label>
            <select id="quality">${qualityOpts}</select>
          </div>
        </div>
      </div>
      <div class="form-section">
        <div class="row">
          <div class="form-group">
            <label>Guidance Scale</label>
            <input type="number" id="guidanceScale" value="" step="0.5" min="1" max="20" placeholder="1–20">
          </div>
          <div class="form-group">
            <label>Reference Image</label>
            <input type="text" id="imageUrl" placeholder="URL">
          </div>
        </div>
        <div class="checkbox-group">
          <label class="checkbox-label"><input type="checkbox" id="enhance">Enhance Prompt</label>
          <label class="checkbox-label"><input type="checkbox" id="nologo" checked>No Watermark</label>
          <label class="checkbox-label"><input type="checkbox" id="safe">Safe Mode</label>
          <label class="checkbox-label"><input type="checkbox" id="transparent">Transparent BG</label>
        </div>
      </div>
      <div class="form-section">
        <div class="batch-toggle">
          <label class="checkbox-label" style="flex:1;">
            <input type="checkbox" id="batchMode" onchange="toggleBatchMode()">Batch Mode
          </label>
          <select id="batchCount" style="width:90px;" ${state.batchMode ? '' : 'disabled'}>
            <option value="2">2 images</option>
            <option value="4" selected>4 images</option>
            <option value="6">6 images</option>
            <option value="9">9 images</option>
          </select>
        </div>
      </div>
    </div>
  `;
  const modelSelect = document.getElementById('model');
  if (modelSelect) modelSelect.value = defaults.model;
}

// Render result panel. `imageUrl` is always an object URL created by showImage().
function renderResultPanel(imageUrl = null, loading = false) {
  let content = '';
  if (loading) {
    content = `
      <div class="result-container">
        <div style="text-align:center;">
          <div class="spinner"></div>
          <p style="margin-top:16px;color:var(--text-muted);">Generating image...</p>
        </div>
      </div>`;
  } else if (imageUrl) {
    const ext = extFromType(state.current && state.current.blob ? state.current.blob.type : '');
    content = `
      <div class="result-container">
        <img src="${imageUrl}" alt="Generated">
      </div>
      <div class="result-actions">
        <a href="${imageUrl}" download="pollimage-${Date.now()}.${ext}" class="btn btn-secondary" style="text-decoration:none;">Download Image</a>
        <button class="btn btn-secondary" onclick="copyPrompt()">Copy Prompt</button>
      </div>`;
  } else {
    content = `
      <div class="result-container">
        <p style="color:var(--text-muted);">Generated image will appear here</p>
      </div>`;
  }
  document.getElementById('result-panel').innerHTML = content;
}

// Show a blob in the result panel (creates and manages its own object URL)
function showImage(blob, prompt) {
  if (state.currentUrl) URL.revokeObjectURL(state.currentUrl);
  state.currentUrl = URL.createObjectURL(blob);
  state.current = { prompt, blob };
  renderResultPanel(state.currentUrl);
}

// Render batch result panel
function renderBatchResultPanel() {
  const { current, total } = state.batchProgress;
  const results = state.batchResults;

  let progressHtml = `
    <div class="batch-progress">
      <div class="progress-text">Progress: ${current}/${total}</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${(current/total)*100}%"></div>
      </div>
    </div>`;

  let gridHtml = '<div class="batch-grid">';
  for (let i = 0; i < total; i++) {
    const result = results[i];
    if (result && result.success) {
      gridHtml += `
        <div class="batch-item" onclick="showBatchImage(${i})">
          <img src="${result.url}" alt="Generated ${i+1}">
          <div class="batch-item-overlay">
            <span class="batch-item-number">${i+1}</span>
          </div>
        </div>`;
    } else if (result && !result.success) {
      gridHtml += `
        <div class="batch-item batch-item-error">
          <div class="batch-error-icon">✕</div>
          <div class="batch-error-text">Failed</div>
        </div>`;
    } else {
      gridHtml += `
        <div class="batch-item batch-item-loading">
          <div class="spinner-small"></div>
        </div>`;
    }
  }
  gridHtml += '</div>';

  let actionsHtml = '';
  if (current === total && results.some(r => r && r.success)) {
    actionsHtml = `
      <div class="result-actions">
        <button class="btn btn-secondary" onclick="downloadAllBatch()">Download All</button>
        <button class="btn btn-secondary" onclick="clearBatchResults()">Clear Results</button>
      </div>`;
  }

  document.getElementById('result-panel').innerHTML = progressHtml + gridHtml + actionsHtml;
}

// Render history panel (built with DOM calls so prompts are never parsed as HTML)
let historyUrls = [];

function renderHistoryPanel() {
  historyUrls.forEach((url) => URL.revokeObjectURL(url));
  historyUrls = [];

  const panel = document.getElementById('history-panel');
  panel.replaceChildren();

  const header = el('div', 'sidebar-header');
  header.appendChild(el('h2', '', `History (${state.history.length})`));
  panel.appendChild(header);

  const content = el('div', 'sidebar-content');
  panel.appendChild(content);

  if (state.history.length === 0) {
    const empty = el('div', 'history-empty');
    empty.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
        <path d="M21 15l-5-5L5 21"/>
      </svg>`;
    empty.appendChild(el('p', '', 'No history yet'));
    content.appendChild(empty);
    return;
  }

  const list = el('div', 'history-list');
  state.history.forEach((entry) => {
    const item = el('div', 'history-item');
    item.dataset.id = String(entry.id);

    const thumbBlob = entry.thumb || entry.image;
    if (thumbBlob) {
      const img = document.createElement('img');
      const url = URL.createObjectURL(thumbBlob);
      historyUrls.push(url);
      img.src = url;
      img.alt = 'History image';
      item.appendChild(img);
    } else {
      const placeholder = el('div', 'history-thumb-empty', 'Aa');
      placeholder.title = 'Saved prompt only (image not available)';
      item.appendChild(placeholder);
    }

    item.appendChild(el('div', 'history-prompt', entry.prompt));

    const del = el('button', 'history-delete-btn', '✕');
    del.title = 'Delete';
    item.appendChild(del);

    list.appendChild(item);
  });
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.history-item');
    if (!item) return;
    const entry = state.history.find((h) => String(h.id) === item.dataset.id);
    if (!entry) return;
    if (e.target.closest('.history-delete-btn')) deleteFromHistory(entry);
    else loadFromHistory(entry);
  });
  content.appendChild(list);

  const footer = el('div', 'sidebar-footer');
  const clearBtn = el('button', 'btn btn-secondary', 'Clear History');
  clearBtn.style.width = '100%';
  clearBtn.addEventListener('click', clearHistory);
  footer.appendChild(clearBtn);
  panel.appendChild(footer);
}

// Save API key
function saveApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  state.apiKey = key;
  const saved = storage.set('pollinations_api_key', key);
  closeModal();
  alert(saved ? 'API key saved!' : 'Key applied for this session only (browser storage is unavailable).');
}

// Connect with Pollinations (BYOP)
function connectPollinations() {
  const redirectUrl = encodeURIComponent(window.location.href.split('#')[0]);
  window.location.href = `https://enter.pollinations.ai/authorize?redirect_url=${redirectUrl}`;
}

// Check for API key in URL hash (BYOP callback)
function checkAuthCallback() {
  if (window.location.hash) {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const apiKey = params.get('api_key');
    if (apiKey) {
      state.apiKey = apiKey;
      storage.set('pollinations_api_key', apiKey);
      // Clean URL
      history.replaceState(null, '', window.location.pathname + window.location.search);
      alert('Pollinations account connected!');
    }
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

// Read the form once. A negative or empty seed becomes a real random seed so the
// image can be reproduced later from the saved settings.
function readParams() {
  const val = (id) => {
    const field = document.getElementById(id);
    return field ? field.value : '';
  };
  const checked = (id) => {
    const field = document.getElementById(id);
    return !!(field && field.checked);
  };
  const seed = parseInt(val('seed'), 10);
  return {
    model: val('model'),
    width: val('width'),
    height: val('height'),
    seed: Number.isFinite(seed) && seed >= 0 ? seed : randomSeed(),
    quality: val('quality'),
    negativePrompt: val('negativePrompt').trim(),
    guidanceScale: val('guidanceScale'),
    imageUrl: val('imageUrl').trim(),
    enhance: checked('enhance'),
    nologo: checked('nologo'),
    safe: checked('safe'),
    transparent: checked('transparent')
  };
}

// Pollinations request. The key goes in the Authorization header, not in the URL.
function buildPollinationsRequest(prompt, p) {
  const params = new URLSearchParams();
  params.set('model', p.model);
  params.set('width', p.width);
  params.set('height', p.height);
  params.set('seed', p.seed);
  params.set('quality', p.quality);
  if (p.negativePrompt) params.set('negative_prompt', p.negativePrompt);
  if (p.guidanceScale) params.set('guidance_scale', p.guidanceScale);
  if (p.imageUrl) params.set('image', p.imageUrl);
  if (p.enhance) params.set('enhance', 'true');
  if (p.nologo) params.set('nologo', 'true');
  if (p.safe) params.set('safe', 'true');
  if (p.transparent) params.set('transparent', 'true');

  const headers = state.apiKey ? { Authorization: `Bearer ${state.apiKey}` } : {};
  return {
    url: `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?${params}`,
    headers
  };
}

async function fetchPollinations(prompt, p) {
  const { url, headers } = buildPollinationsRequest(prompt, p);
  try {
    return await fetch(url, { headers });
  } catch (err) {
    // A network/CORS failure can mean the browser blocked the Authorization header.
    // Retry once with the key in the query string. This URL is only used for this
    // request: it is never shown, copied or stored.
    if (!state.apiKey) throw err;
    const retry = new URL(url);
    retry.searchParams.set('key', state.apiKey);
    return await fetch(retry.toString());
  }
}

async function generatePollinationsBlob(prompt, p) {
  const response = await fetchPollinations(prompt, p);
  if (!response.ok) {
    let errMsg = `HTTP ${response.status}`;
    try { const t = await response.text(); if (t) errMsg = t; } catch (_) {}
    throw new Error(errMsg);
  }
  const blob = await response.blob();
  if (!blob.type || !blob.type.startsWith('image/')) {
    throw new Error(`Unexpected response type: ${blob.type || 'unknown'}`);
  }
  return blob;
}

// One entry point for image generation; always returns an image Blob
async function generateBlob(prompt, p) {
  return generatePollinationsBlob(prompt, p);
}

// Generate image
async function generateImage() {
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) {
    alert('Please enter a prompt');
    return;
  }

  state.isGenerating = true;
  document.getElementById('generateBtn').disabled = true;
  renderResultPanel(null, true);

  try {
    const params = readParams();
    const blob = await generateBlob(prompt, params);
    showImage(blob, prompt);
    await saveToHistory(prompt, params, blob);
    renderHistoryPanel();
  } catch (err) {
    alert('Error: ' + err.message);
    renderResultPanel();
  } finally {
    state.isGenerating = false;
    document.getElementById('generateBtn').disabled = false;
  }
}

// Copy the prompt of the image on screen
function copyPrompt() {
  if (!state.current) return;
  navigator.clipboard.writeText(state.current.prompt)
    .then(() => alert('Prompt copied!'))
    .catch(() => alert('Could not copy the prompt.'));
}

// Show batch image in the result panel
function showBatchImage(index) {
  const result = state.batchResults[index];
  if (result && result.success) {
    showImage(result.blob, result.prompt);
  }
}

// Download all batch images (spaced out so the browser does not block the downloads)
async function downloadAllBatch() {
  for (let i = 0; i < state.batchResults.length; i++) {
    const result = state.batchResults[i];
    if (result && result.success) {
      const link = document.createElement('a');
      link.href = result.url;
      link.download = `generated_${i + 1}.${extFromType(result.blob.type)}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      await sleep(200);
    }
  }
}

function revokeBatchUrls() {
  state.batchResults.forEach((r) => {
    if (r && r.url) URL.revokeObjectURL(r.url);
  });
}

// Clear batch results
function clearBatchResults() {
  revokeBatchUrls();
  state.batchResults = [];
  state.batchProgress = { current: 0, total: 0 };
  renderResultPanel();
}

// Toggle batch mode
function toggleBatchMode() {
  state.batchMode = document.getElementById('batchMode').checked;
  document.getElementById('batchCount').disabled = !state.batchMode;
}

// Handle generate button click
function handleGenerate() {
  if (state.batchMode) {
    state.batchCount = parseInt(document.getElementById('batchCount').value);
    generateBatch();
  } else {
    generateImage();
  }
}

// Generate single image for batch (each image gets its own random seed)
async function generateSingleForBatch(prompt, index, baseParams) {
  try {
    const p = { ...baseParams, seed: randomSeed() };
    const blob = await generateBlob(prompt, p);
    return { success: true, blob, url: URL.createObjectURL(blob), prompt, index, params: p };
  } catch (err) {
    return { success: false, error: err.message, prompt, index };
  }
}

// Batch generate images
async function generateBatch() {
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) {
    alert('Please enter a prompt');
    return;
  }

  state.isGenerating = true;
  revokeBatchUrls();
  state.batchResults = [];
  state.batchProgress = { current: 0, total: state.batchCount };
  document.getElementById('generateBtn').disabled = true;

  renderBatchResultPanel();

  try {
    // Read the form once so changes mid-batch do not affect it
    const baseParams = readParams();

    // Generate images concurrently, a few at a time
    const concurrency = 3;
    const results = [];

    for (let i = 0; i < state.batchCount; i += concurrency) {
      const batch = [];
      for (let j = i; j < Math.min(i + concurrency, state.batchCount); j++) {
        batch.push(generateSingleForBatch(prompt, j, baseParams));
      }

      const batchResults = await Promise.all(batch);

      for (const result of batchResults) {
        results.push(result);
        state.batchProgress.current++;
        state.batchResults = results;
        renderBatchResultPanel();
      }
    }

    // Add successful results to history
    for (const result of results) {
      if (result.success) {
        await saveToHistory(result.prompt, result.params, result.blob);
      }
    }
    renderHistoryPanel();
  } finally {
    state.isGenerating = false;
    document.getElementById('generateBtn').disabled = false;
  }
}

// History setup runs alongside the model fetch so neither waits on the other
async function initHistory() {
  try {
    await migrateLegacyHistory();
    await loadHistory();
  } catch (e) {
    console.warn('History is unavailable:', e);
  }
  renderHistoryPanel();
}

// Initialize
async function init() {
  checkAuthCallback();

  // Kaggle support was removed; clear any key or URL saved by older versions
  storage.remove('kaggle_api_key');
  storage.remove('kaggle_api_url');

  // Close modal on overlay click
  document.getElementById('apiModal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) closeModal();
  });

  renderResultPanel();
  renderHistoryPanel();
  const historyReady = initHistory();

  // Fetch models from API, then render params panel
  await fetchImageModels();
  renderParamsPanel();
  await historyReady;
}

document.addEventListener('DOMContentLoaded', init);
