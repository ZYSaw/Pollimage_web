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

// Small SVG icon from the sprite in index.html
function icon(name) {
  return `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

// Short floating message at the top of the screen (tap to dismiss)
function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  if (!box) return;
  while (box.children.length >= 3) box.firstChild.remove();
  const node = el('div', kind ? `toast ${kind}` : 'toast', message);
  node.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  box.appendChild(node);
  const timer = setTimeout(() => node.remove(), kind === 'err' ? 6000 : 2600);
  node.addEventListener('click', () => { clearTimeout(timer); node.remove(); });
}

function promptRequired() {
  toast('Enter a prompt first.', 'err');
  const box = document.getElementById('prompt');
  if (box) box.focus();
}

// Bottom sheets (options, history, settings)
function openSheet(id) {
  const sheet = document.getElementById(id);
  if (sheet) sheet.classList.add('show');
}

function closeSheet(id) {
  const sheet = document.getElementById(id);
  if (sheet) sheet.classList.remove('show');
}

function closeAllSheets() {
  document.querySelectorAll('.modal-overlay.show').forEach((sheet) => sheet.classList.remove('show'));
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
  providers: [],        // custom OpenAI-compatible providers (loaded in init)
  history: [],          // entries loaded from IndexedDB (newest first)
  isGenerating: false,
  current: null,        // { prompt, blob } for the image shown in the result panel
  currentUrl: null,     // object URL for that image
  // Batch generation state
  batchCount: 1,
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
  safe: false,
  quality: 'high'
};

// Every model belongs to a provider: the built-in Pollinations API or a custom one.
// Dropdown values look like "providerId::modelName".
const POLLINATIONS_ID = 'pollinations';
const PROVIDERS_KEY = 'pollimage_providers';

// Fallback models in case the Pollinations model list cannot be loaded
const fallbackModels = [
  'z-image-turbo', 'z-image', 'zimage', 'flux', 'klein', 'klein-large', 'turbo',
  'gptimage', 'gptimage-large', 'kontext',
  'seedream', 'seedream-pro', 'nanobanana', 'nanobanana-pro'
];

// Pollinations image models: [{ name, description }]. Starts with the fallback list so
// the page is usable immediately; the real list replaces it when it arrives.
let pollinationsModels = fallbackModels.map((name) => ({ name, description: '' }));

function modelValue(providerId, name) {
  return `${providerId}::${name}`;
}

function splitModelValue(value) {
  const i = String(value || '').indexOf('::');
  if (i < 0) return { providerId: POLLINATIONS_ID, model: String(value || '') };
  return { providerId: value.slice(0, i), model: value.slice(i + 2) };
}

// Fetch Pollinations models from the API
async function fetchImageModels() {
  try {
    const res = await fetch('https://gen.pollinations.ai/image/models');
    if (!res.ok) throw new Error('Failed to fetch models');
    const models = await res.json();
    // Filter for image output models only
    const found = models
      .filter((m) => m.output_modalities && m.output_modalities.includes('image'))
      .map((m) => ({
        name: m.name,
        description: m.description || '',
        inputs: Array.isArray(m.input_modalities) ? m.input_modalities : null
      }));
    if (found.length) pollinationsModels = found;
  } catch (e) {
    console.warn('Failed to fetch models, using fallback:', e);
  }
}

function loadProviders() {
  try {
    const parsed = JSON.parse(storage.get(PROVIDERS_KEY, '[]'));
    if (Array.isArray(parsed)) return parsed.filter((p) => p && p.id && p.baseUrl);
  } catch (_) {}
  return [];
}

function saveProviders() {
  return storage.set(PROVIDERS_KEY, JSON.stringify(state.providers));
}

function providerModelList(provider) {
  return [...new Set([...(provider.fetchedModels || []), ...(provider.manualModels || [])])];
}

// <optgroup> markup for every provider that has models
function buildModelOptions(selectedValue) {
  const groups = [{ id: POLLINATIONS_ID, label: 'Pollinations', models: pollinationsModels }]
    .concat(state.providers.map((p) => ({
      id: p.id,
      label: p.name,
      models: providerModelList(p).map((name) => ({ name, description: '' }))
    })));
  return groups
    .filter((g) => g.models.length)
    .map((g) => `<optgroup label="${esc(g.label)}">` + g.models.map((m) => {
      const value = modelValue(g.id, m.name);
      return `<option value="${esc(value)}" title="${esc(m.description || '')}" ${value === selectedValue ? 'selected' : ''}>${esc(m.name)}</option>`;
    }).join('') + '</optgroup>')
    .join('');
}

// Rebuild only the model dropdown, keeping the selection and everything else in the form
function refreshModelSelect() {
  const select = document.getElementById('model');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = buildModelOptions(previous);
  if (![...select.options].some((o) => o.value === previous)) {
    select.value = modelValue(POLLINATIONS_ID, defaults.model);
  }
  if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0;
  updateParamVisibility();
}

// What each Pollinations model accepts (per the API docs). Whether a model takes a reference
// image comes from the live model list when available, otherwise from its name.
function pollinationsCaps(name) {
  const entry = pollinationsModels.find((m) => m.name === name);
  const imageInput = entry && Array.isArray(entry.inputs)
    ? entry.inputs.includes('image')
    : /^(kontext|nanobanana|seedream5|gptimage|klein|flux-2-dev|p-image-edit)/.test(name);
  return {
    seed: /^(flux|z-?image|seedream|klein|seedance)/.test(name),
    negativePrompt: /^(flux|z-?image)/.test(name),
    quality: /^gptimage/.test(name),
    transparent: /^gptimage/.test(name),
    image: imageInput
  };
}

// Show only the options the selected model can use: custom providers get none of the
// Pollinations-specific ones, and each Pollinations model gets the ones it supports
function updateParamVisibility() {
  const select = document.getElementById('model');
  if (!select) return;
  const { providerId, model } = splitModelValue(select.value);
  const custom = providerId !== POLLINATIONS_ID;
  const caps = custom ? {} : pollinationsCaps(model);
  document.querySelectorAll('[data-pol-only]').forEach((node) => { node.hidden = custom; });
  document.querySelectorAll('[data-cap]').forEach((node) => { node.hidden = custom || !caps[node.dataset.cap]; });
  // A row whose fields are all hidden would leave an empty gap
  document.querySelectorAll('#options-body .row').forEach((row) => {
    row.hidden = [...row.children].every((child) => child.hidden);
  });
  // The model's own description (the dropdown only has room for its name)
  const desc = document.getElementById('modelDesc');
  if (desc) {
    const entry = custom ? null : pollinationsModels.find((m) => m.name === model);
    desc.textContent = entry ? entry.description : '';
    desc.hidden = !desc.textContent;
  }
  const note = document.getElementById('providerNote');
  if (note) {
    const provider = state.providers.find((p) => p.id === providerId);
    note.hidden = !custom;
    note.textContent = custom
      ? `${provider ? provider.name : 'This provider'} receives the prompt, model and size. Seed, quality, negative prompt and the other Pollinations options are not sent.`
      : '';
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

// Guess the image type from the first bytes (providers do not always send a content type)
function sniffImageType(bytes) {
  const startsWith = (...sig) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (startsWith(0xff, 0xd8)) return 'image/jpeg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return 'image/png';
}

function b64ToBlob(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: sniffImageType(bytes) });
}

// Turn a failed response into a readable message (understands OpenAI-style and Pollinations errors)
async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch (_) {}
  try {
    const json = JSON.parse(text);
    const err = json && (json.error || json.errors);
    const message = err && (err.message || err);
    if (message) return `HTTP ${res.status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`;
  } catch (_) {}
  return text ? `HTTP ${res.status}: ${text.slice(0, 300)}` : `HTTP ${res.status}`;
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
    provider: p.providerId, model: p.model, width: p.width, height: p.height,
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
  fitPrompt();
  const p = entry.params || {};
  if (p.model) setField('model', modelValue(p.provider || POLLINATIONS_ID, p.model));
  setField('width', p.width);
  setField('height', p.height);
  setField('seed', p.seed);
  setField('quality', p.quality);
  setField('negativePrompt', p.negativePrompt);
  syncAspectFromSize();
  updateParamVisibility();
  if (entry.image) showImage(entry.image, entry.prompt);
}

// Modal functions
function openModal() {
  openSheet('apiModal');
  document.getElementById('apiKey').value = state.apiKey;
  renderProviderList();
  closeProviderForm();
}

function closeModal() {
  closeSheet('apiModal');
}

// ---------------------------------------------------------------------------
// Prompt dock, options sheet, result stage and history sheet
// ---------------------------------------------------------------------------
const ASPECTS = [
  ['1:1', 1024, 1024], ['3:4', 768, 1024], ['4:3', 1024, 768], ['2:3', 640, 960],
  ['3:2', 960, 640], ['9:16', 576, 1024], ['16:9', 1024, 576]
];

const EXAMPLE_PROMPTS = [
  'A lighthouse in a storm, oil painting',
  'Tiny ramen shop, isometric, soft morning light',
  'Macro photo of a dewdrop on a fern leaf'
];

// Choosing a ratio fills in the width and height; typing a size updates the ratio
function applyAspect() {
  const select = document.getElementById('aspect');
  const preset = ASPECTS.find((a) => a[0] === select.value);
  if (!preset) return;
  document.getElementById('width').value = preset[1];
  document.getElementById('height').value = preset[2];
}

function syncAspectFromSize() {
  const select = document.getElementById('aspect');
  const width = Number(document.getElementById('width').value);
  const height = Number(document.getElementById('height').value);
  const preset = ASPECTS.find((a) => a[1] === width && a[2] === height);
  select.value = preset ? preset[0] : 'custom';
}

// Grow the prompt box with its text (up to about five lines)
function fitPrompt() {
  const box = document.getElementById('prompt');
  if (!box) return;
  box.style.height = 'auto';
  box.style.height = Math.min(box.scrollHeight, 132) + 'px';
}

function useExample(text) {
  const box = document.getElementById('prompt');
  box.value = text;
  fitPrompt();
  box.focus();
}

// Render the prompt dock and the options sheet
function renderParamsPanel() {
  const defaultModelValue = modelValue(POLLINATIONS_ID, defaults.model);
  const modelOpts = buildModelOptions(defaultModelValue);
  const aspectOpts = ASPECTS.map(([label, w, h]) =>
    `<option value="${label}" ${w === defaults.width && h === defaults.height ? 'selected' : ''}>${label}</option>`
  ).join('') + '<option value="custom" hidden>Custom</option>';
  const countOpts = [1, 2, 4, 6, 9].map((n) =>
    `<option value="${n}">${n === 1 ? '1 image' : `${n} images`}</option>`
  ).join('');
  const qualityOpts = qualityOptions.map((q) =>
    `<option value="${q}" ${q === defaults.quality ? 'selected' : ''}>${q}</option>`
  ).join('');

  document.getElementById('params-panel').innerHTML = `
    <div class="prompt-row">
      <textarea id="prompt" rows="1" placeholder="Describe an image" aria-label="Prompt" oninput="fitPrompt()"></textarea>
      <button class="generate-btn" id="generateBtn" onclick="handleGenerate()" aria-label="Generate">${icon('arrow-up')}</button>
    </div>
    <div class="chips">
      <select class="chip" id="model" aria-label="Model" onchange="updateParamVisibility()">${modelOpts}</select>
      <select class="chip" id="aspect" aria-label="Aspect ratio" onchange="applyAspect()">${aspectOpts}</select>
      <select class="chip" id="batchCount" aria-label="Number of images">${countOpts}</select>
      <button class="chip chip-icon" onclick="openSheet('optionsSheet')" aria-label="More options">${icon('sliders')}</button>
    </div>`;

  document.getElementById('options-body').innerHTML = `
    <p class="hint" id="modelDesc" hidden></p>
    <p class="provider-note" id="providerNote" hidden></p>
    <div class="row">
      <div class="form-group">
        <label for="width">Width</label>
        <input type="number" id="width" value="${defaults.width}" min="64" max="2048" inputmode="numeric" oninput="syncAspectFromSize()">
      </div>
      <div class="form-group">
        <label for="height">Height</label>
        <input type="number" id="height" value="${defaults.height}" min="64" max="2048" inputmode="numeric" oninput="syncAspectFromSize()">
      </div>
    </div>
    <div class="form-group" data-cap="negativePrompt">
      <label for="negativePrompt">Negative prompt</label>
      <input type="text" id="negativePrompt" value="worst quality, blurry" placeholder="Things to leave out">
    </div>
    <div class="row">
      <div class="form-group" data-cap="seed">
        <label for="seed">Seed</label>
        <input type="number" id="seed" value="${defaults.seed}" min="-1" placeholder="-1 for random" inputmode="numeric">
      </div>
      <div class="form-group" data-cap="quality">
        <label for="quality">Quality</label>
        <select class="field" id="quality">${qualityOpts}</select>
      </div>
    </div>
    <div class="form-group" data-cap="image">
      <label for="imageUrl">Reference image URL(s)</label>
      <input type="text" id="imageUrl" placeholder="https://... (separate several with |)" inputmode="url" autocapitalize="off" autocorrect="off">
    </div>
    <div class="checkbox-group" data-pol-only>
      <label class="checkbox-label"><input type="checkbox" id="enhance">Enhance prompt</label>
      <label class="checkbox-label"><input type="checkbox" id="safe">Safe mode</label>
      <label class="checkbox-label" data-cap="transparent"><input type="checkbox" id="transparent">Transparent background</label>
    </div>
    <button class="btn btn-secondary btn-block" style="margin-top:12px" onclick="closeSheet('optionsSheet')">Done</button>`;

  const modelSelect = document.getElementById('model');
  if (modelSelect) modelSelect.value = defaultModelValue;
  document.getElementById('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleGenerate();
    }
  });
  updateParamVisibility();
}

// Count up the seconds while an image is being made
function startElapsedTimer() {
  const label = document.getElementById('elapsed');
  if (!label) return;
  const started = Date.now();
  const timer = setInterval(() => {
    if (!label.isConnected) { clearInterval(timer); return; }
    label.textContent = `${Math.floor((Date.now() - started) / 1000)}s`;
  }, 1000);
}

function canShareImage() {
  try {
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function' || !state.current) return false;
    const blob = state.current.blob;
    return navigator.canShare({ files: [new File([blob], `pollimage.${extFromType(blob.type)}`, { type: blob.type })] });
  } catch (_) {
    return false;
  }
}

async function shareImage() {
  if (!state.current) return;
  const { blob, prompt } = state.current;
  try {
    const file = new File([blob], `pollimage.${extFromType(blob.type)}`, { type: blob.type });
    await navigator.share({ files: [file], text: prompt });
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('Could not share the image.', 'err');
  }
}

// Render the result stage. `imageUrl` is always an object URL created by showImage().
function renderResultPanel(imageUrl = null, loading = false, error = null) {
  const panel = document.getElementById('result-panel');

  if (loading) {
    panel.innerHTML = `
      <div class="frame">
        <div class="pending" role="status"><p>Generating <span id="elapsed">0s</span></p></div>
      </div>`;
    startElapsedTimer();
    return;
  }

  if (error) {
    const needsKey = /API key/i.test(error);
    panel.innerHTML = `
      <div class="stage-note result-error" role="alert">
        <h2 class="display">Generation failed</h2>
        <p id="errorText"></p>
        <div class="actions">
          <button class="btn btn-primary" onclick="handleGenerate()">Try again</button>
          ${needsKey ? '<button class="btn btn-secondary" onclick="openModal()">Open settings</button>' : ''}
        </div>
      </div>`;
    document.getElementById('errorText').textContent = error;
    return;
  }

  if (imageUrl) {
    const ext = extFromType(state.current && state.current.blob ? state.current.blob.type : '');
    const hasBatch = state.batchResults.some((r) => r && r.success);
    panel.innerHTML = `
      <div class="frame"><img class="develop" src="${imageUrl}" alt="Generated image"></div>
      <p class="caption" id="caption"></p>
      <div class="actions">
        <a class="btn btn-secondary" href="${imageUrl}" download="pollimage-${Date.now()}.${ext}">${icon('download')}Download</a>
        <button class="btn btn-secondary" onclick="copyPrompt()">${icon('copy')}Copy prompt</button>
        ${canShareImage() ? `<button class="btn btn-secondary" onclick="shareImage()">${icon('share')}Share</button>` : ''}
        ${hasBatch ? '<button class="btn btn-secondary" onclick="renderBatchResultPanel()">All images</button>' : ''}
      </div>`;
    document.getElementById('caption').textContent = state.current ? state.current.prompt : '';
    return;
  }

  panel.innerHTML = `
    <div class="stage-note">
      <h2 class="display">Describe an image to start.</h2>
      <div class="examples">
        ${EXAMPLE_PROMPTS.map((t) => `<button class="example" onclick="useExample(this.textContent)">${esc(t)}</button>`).join('')}
      </div>
    </div>`;
}

// Show a blob in the result stage (creates and manages its own object URL)
function showImage(blob, prompt) {
  if (state.currentUrl) URL.revokeObjectURL(state.currentUrl);
  state.currentUrl = URL.createObjectURL(blob);
  state.current = { prompt, blob };
  renderResultPanel(state.currentUrl);
}

// Render the batch results (a grid of everything generated for one prompt)
function renderBatchResultPanel() {
  const { current, total } = state.batchProgress;
  const results = state.batchResults;
  const done = current === total;
  const failed = results.filter((r) => r && !r.success);

  let statusText = `Generating ${current} of ${total}`;
  if (done) statusText = failed.length ? `${total - failed.length} of ${total} images made` : `${total} images`;

  let gridHtml = '<div class="batch-grid">';
  for (let i = 0; i < total; i++) {
    const result = results[i];
    if (result && result.success) {
      gridHtml += `
        <div class="batch-item" onclick="showBatchImage(${i})">
          <img src="${result.url}" alt="Generated image ${i + 1}">
        </div>`;
    } else if (result && !result.success) {
      gridHtml += '<div class="batch-item batch-item-error">Failed</div>';
    } else {
      gridHtml += '<div class="batch-item batch-item-loading"></div>';
    }
  }
  gridHtml += '</div>';

  const actionsHtml = done && results.some((r) => r && r.success)
    ? `<div class="actions">
         <button class="btn btn-secondary" onclick="downloadAllBatch()">${icon('download')}Download all</button>
         <button class="btn btn-secondary" onclick="clearBatchResults()">Clear</button>
       </div>`
    : '';

  document.getElementById('result-panel').innerHTML = `
    <div class="batch-status">
      <span>${statusText}</span>
      ${done ? '' : `<div class="bar"><div class="bar-fill" style="width:${total ? (current / total) * 100 : 0}%"></div></div>`}
    </div>
    ${gridHtml}
    <p class="batch-note" id="batchNote" hidden></p>
    ${actionsHtml}`;

  if (done && failed.length) {
    const note = document.getElementById('batchNote');
    note.textContent = failed[0].error;
    note.hidden = false;
  }
}

// Render the history sheet (built with DOM calls so prompts are never parsed as HTML)
let historyUrls = [];

function renderHistoryPanel() {
  historyUrls.forEach((url) => URL.revokeObjectURL(url));
  historyUrls = [];

  const badge = document.getElementById('historyCount');
  if (badge) {
    badge.textContent = state.history.length ? String(state.history.length) : '';
    badge.hidden = !state.history.length;
  }

  const panel = document.getElementById('history-panel');
  panel.replaceChildren();

  const head = el('header', 'sheet-head');
  head.appendChild(el('h2', 'display', 'History'));
  if (state.history.length) {
    const clearBtn = el('button', 'btn-text', 'Clear all');
    clearBtn.addEventListener('click', clearHistory);
    head.appendChild(clearBtn);
  }
  const closeBtn = el('button', 'icon-btn');
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = icon('close');
  closeBtn.addEventListener('click', () => closeSheet('historySheet'));
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const body = el('div', 'sheet-body');
  panel.appendChild(body);

  if (state.history.length === 0) {
    body.appendChild(el('p', 'history-empty', 'Images you make will show up here.'));
    return;
  }

  const grid = el('div', 'history-grid');
  state.history.forEach((entry) => {
    const item = el('div', 'history-item');
    item.dataset.id = String(entry.id);
    item.tabIndex = 0;
    item.setAttribute('role', 'button');

    const thumbBlob = entry.thumb || entry.image;
    if (thumbBlob) {
      const img = document.createElement('img');
      const url = URL.createObjectURL(thumbBlob);
      historyUrls.push(url);
      img.src = url;
      img.alt = '';
      item.appendChild(img);
    } else {
      item.classList.add('no-image');
      item.appendChild(el('div', 'history-thumb-empty'));
      item.title = 'Saved prompt only (the image is no longer available)';
    }

    item.appendChild(el('div', 'history-prompt', entry.prompt));

    const del = el('button', 'history-delete-btn', '✕');
    del.setAttribute('aria-label', 'Delete');
    item.appendChild(del);
    grid.appendChild(item);
  });

  const open = (target) => {
    const item = target.closest('.history-item');
    const entry = item && state.history.find((h) => String(h.id) === item.dataset.id);
    if (!entry) return;
    if (target.closest('.history-delete-btn')) {
      deleteFromHistory(entry);
    } else {
      loadFromHistory(entry);
      closeSheet('historySheet');
    }
  };
  grid.addEventListener('click', (e) => open(e.target));
  grid.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('history-item')) {
      e.preventDefault();
      open(e.target);
    }
  });
  body.appendChild(grid);
}

// Save API key
function saveApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  state.apiKey = key;
  const saved = storage.set('pollinations_api_key', key);
  closeModal();
  toast(saved ? 'API key saved!' : 'Key applied for this session only (browser storage is unavailable).', saved ? '' : 'err');
}

// ---------------------------------------------------------------------------
// Custom providers (OpenAI-compatible image APIs such as Logfare)
// ---------------------------------------------------------------------------
const PROVIDER_PRESETS = {
  logfare: { name: 'Logfare', baseUrl: 'https://logfare.ai/v1', parallel: 2 },
  // ModelScope's image API is asynchronous (submit a task, then poll it). Tokens only work on the site they were made on (.ai or .cn).
  modelscope: {
    name: 'ModelScope', baseUrl: 'https://api-inference.modelscope.ai/v1', parallel: 2, type: 'modelscope',
    models: ['Qwen/Qwen-Image-2.1', 'Qwen/Qwen-Image', 'Qwen/Qwen-Image-2512', 'Tongyi-MAI/Z-Image-Turbo', 'black-forest-labs/FLUX.1-Kontext-dev']
  }
};
let editingProviderId = null;
let editingProviderType = 'openai';

// ModelScope providers use a task-based API. Detected by type, or by address for providers added by hand.
function isModelScope(provider) {
  if (provider.type === 'modelscope') return true;
  try { return /(^|\.)modelscope\.(cn|ai)$/.test(new URL(provider.baseUrl).hostname); } catch (_) { return false; }
}

function newProviderId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function providerHeaders(provider, json = false) {
  const headers = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  return { ...headers, ...(provider.headers || {}) };
}

async function providerFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (_) {
    throw new Error('Could not reach the server. It may be offline, or it may not allow requests from this website (CORS).');
  }
}

// GET {baseUrl}/models and keep the image-generation models
async function fetchProviderModels(provider) {
  const res = await providerFetch(`${provider.baseUrl}/models`, { headers: providerHeaders(provider) });
  if (!res.ok) throw new Error(await readError(res));
  // ModelScope's list is mostly chat models and misses its image models, so it is only used to check the token
  if (isModelScope(provider)) return [];
  const json = await res.json();
  const list = Array.isArray(json) ? json : (json.data || json.models || []);
  const entries = list
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && (m.id || m.name || m.model));
  const idOf = (m) => String(m.id || m.name || m.model);

  let images = entries;
  if (entries.some((m) => m.endpoints !== undefined)) {
    images = entries.filter((m) => JSON.stringify(m.endpoints || '').includes('images/generations'));
  } else if (entries.some((m) => Array.isArray(m.output_modalities))) {
    images = entries.filter((m) => Array.isArray(m.output_modalities) && m.output_modalities.includes('image'));
  }
  return [...new Set(images.map(idOf))];
}

// Refresh one provider's model list; keeps the old list if the request fails
async function refreshProviderModels(provider) {
  try {
    provider.fetchedModels = await fetchProviderModels(provider);
  } catch (e) {
    console.warn(`Could not load models for ${provider.name}:`, e);
  }
}

async function refreshAllProviders() {
  if (!state.providers.length) return;
  await Promise.all(state.providers.map(refreshProviderModels));
  saveProviders();
  renderProviderList();
}

function renderProviderList() {
  const box = document.getElementById('providerList');
  if (!box) return;
  box.replaceChildren();
  if (!state.providers.length) {
    box.appendChild(el('p', 'provider-empty', 'No custom providers yet.'));
    return;
  }
  state.providers.forEach((p) => {
    const row = el('div', 'provider-row');
    const info = el('div', 'provider-info');
    info.appendChild(el('div', 'provider-name', p.name));
    let host = p.baseUrl;
    try { host = new URL(p.baseUrl).host; } catch (_) {}
    const count = providerModelList(p).length;
    const models = count ? `${count} image model${count === 1 ? '' : 's'}` : 'no models found';
    info.appendChild(el('div', 'provider-meta', `${host} · ${models}${p.apiKey ? '' : ' · no key'}`));
    row.appendChild(info);

    const edit = el('button', 'btn btn-secondary provider-btn', 'Edit');
    edit.dataset.action = 'edit';
    edit.dataset.id = p.id;
    const remove = el('button', 'btn btn-secondary provider-btn', 'Remove');
    remove.dataset.action = 'remove';
    remove.dataset.id = p.id;
    row.append(edit, remove);
    box.appendChild(row);
  });
}

function onProviderListClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'edit') openProviderForm(null, btn.dataset.id);
  if (btn.dataset.action === 'remove') removeProvider(btn.dataset.id);
}

function setProviderStatus(text, kind = '') {
  const status = document.getElementById('pfStatus');
  if (!status) return;
  status.textContent = text;
  status.className = `provider-status ${kind}`.trim();
}

function openProviderForm(presetKey, id) {
  const existing = id ? state.providers.find((p) => p.id === id) : null;
  const preset = presetKey ? PROVIDER_PRESETS[presetKey] : null;
  const src = existing || preset || {};
  editingProviderId = existing ? existing.id : null;
  editingProviderType = (existing && existing.type) || (preset && preset.type) || 'openai';

  const set = (fieldId, value) => { document.getElementById(fieldId).value = value; };
  set('pfName', src.name || '');
  set('pfBaseUrl', src.baseUrl || '');
  set('pfKey', existing ? (existing.apiKey || '') : '');
  set('pfModels', existing ? (existing.manualModels || []).join(', ') : ((preset && preset.models) || []).join(', '));
  set('pfHeaders', existing && existing.headers && Object.keys(existing.headers).length
    ? JSON.stringify(existing.headers) : '');
  set('pfParallel', src.parallel || 2);
  document.getElementById('pfB64').checked = !!(existing && existing.b64);
  setProviderStatus('');
  document.getElementById('providerForm').hidden = false;
  document.getElementById('providerAddRow').hidden = true;
}

function closeProviderForm() {
  editingProviderId = null;
  const form = document.getElementById('providerForm');
  const addRow = document.getElementById('providerAddRow');
  if (form) form.hidden = true;
  if (addRow) addRow.hidden = false;
}

// Validate the form and build a provider object ({ error } when something is wrong)
function readProviderForm() {
  const value = (fieldId) => document.getElementById(fieldId).value;
  const name = value('pfName').trim();
  const baseUrl = value('pfBaseUrl').trim().replace(/\/+$/, '');
  if (!name) return { error: 'Enter a name.' };

  let url;
  try { url = new URL(baseUrl); } catch (_) {
    return { error: 'Enter the full base URL, for example https://logfare.ai/v1' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'The URL must start with https:// (or http:// for a local server).' };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && window.location.protocol === 'https:' && !local) {
    return { error: 'This page is on https, so browsers block plain http:// endpoints. Use an https:// URL.' };
  }

  let headers = {};
  const rawHeaders = value('pfHeaders').trim();
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch (_) {
      return { error: 'Extra headers must be JSON, for example {"ngrok-skip-browser-warning": "1"}' };
    }
  }

  const parallel = Math.min(6, Math.max(1, parseInt(value('pfParallel'), 10) || 2));
  const manualModels = value('pfModels').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    provider: {
      id: editingProviderId || newProviderId(),
      type: editingProviderType,
      name,
      baseUrl,
      apiKey: value('pfKey').trim(),
      headers,
      parallel,
      b64: document.getElementById('pfB64').checked,
      manualModels
    }
  };
}

async function testProvider() {
  const { provider, error } = readProviderForm();
  if (error) { setProviderStatus(error, 'err'); return; }
  setProviderStatus('Testing...');
  try {
    const models = await fetchProviderModels(provider);
    if (isModelScope(provider)) {
      setProviderStatus('Connected. Your token works. Add the image models you want to use in "Models".', 'ok');
      return;
    }
    setProviderStatus(
      models.length
        ? `Connected. Found ${models.length} image model${models.length === 1 ? '' : 's'}.`
        : 'Connected, but no image models were listed. Type the model names into "Models" yourself.',
      models.length ? 'ok' : 'err'
    );
  } catch (e) {
    setProviderStatus(e.message, 'err');
  }
}

async function saveProvider() {
  const { provider, error } = readProviderForm();
  if (error) { setProviderStatus(error, 'err'); return; }
  setProviderStatus('Saving...');

  const index = state.providers.findIndex((p) => p.id === provider.id);
  const previous = index >= 0 ? state.providers[index] : null;
  // Keep the old model list only if the address did not change
  provider.fetchedModels = previous && previous.baseUrl === provider.baseUrl ? (previous.fetchedModels || []) : [];
  await refreshProviderModels(provider);

  if (index >= 0) state.providers[index] = provider;
  else state.providers.push(provider);
  const saved = saveProviders();

  closeProviderForm();
  renderProviderList();
  refreshModelSelect();
  if (!saved) toast('Provider applied for this session only (browser storage is unavailable).', 'err');
}

function removeProvider(id) {
  const provider = state.providers.find((p) => p.id === id);
  if (!provider || !confirm(`Remove ${provider.name}?`)) return;
  state.providers = state.providers.filter((p) => p.id !== id);
  saveProviders();
  renderProviderList();
  refreshModelSelect();
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
      toast('Pollinations account connected!');
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
  const { providerId, model } = splitModelValue(val('model'));
  return {
    providerId,
    model,
    width: val('width'),
    height: val('height'),
    seed: Number.isFinite(seed) && seed >= 0 ? seed : randomSeed(),
    quality: val('quality'),
    negativePrompt: val('negativePrompt').trim(),
    imageUrl: val('imageUrl').trim(),
    enhance: checked('enhance'),
    safe: checked('safe'),
    transparent: checked('transparent')
  };
}

// Pollinations request. The key goes in the Authorization header, not in the URL.
function buildPollinationsRequest(prompt, p) {
  const params = new URLSearchParams();
  // Only send what the selected model supports, the same rules that decide which fields are shown
  const caps = pollinationsCaps(p.model);
  params.set('model', p.model);
  params.set('width', p.width);
  params.set('height', p.height);
  if (caps.seed) params.set('seed', p.seed);
  if (caps.quality) params.set('quality', p.quality);
  if (caps.negativePrompt && p.negativePrompt) params.set('negative_prompt', p.negativePrompt);
  if (caps.image && p.imageUrl) params.set('image', p.imageUrl);
  if (p.enhance) params.set('enhance', 'true');
  if (p.safe) params.set('safe', 'true');
  if (caps.transparent && p.transparent) params.set('transparent', 'true');

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

// How long to wait after an HTTP 429 (Retry-After header, between 1 and 15 seconds)
function retryAfterMs(res) {
  const seconds = Number(res.headers && res.headers.get && res.headers.get('Retry-After'));
  return Math.min(15, Math.max(1, seconds || 3)) * 1000;
}

// Plain-language message for a failed Pollinations request, with the server's own detail after it
async function pollinationsError(res) {
  const detail = await readError(res);
  const hints = {
    400: 'Pollinations rejected these settings.',
    401: 'No valid Pollinations API key. Add yours in Settings (image generation needs one).',
    402: 'Your Pollinations balance is too low for this request.',
    403: 'Your key is not allowed to do this, for example use this model.',
    429: 'Too many requests right now. Wait a moment and try again.'
  };
  const hint = hints[res.status] || (res.status >= 500 ? 'Pollinations had a server problem. Try again in a moment.' : '');
  return hint ? `${hint}\n(${detail})` : detail;
}

async function generatePollinationsBlob(prompt, p, attempt = 0) {
  const response = await fetchPollinations(prompt, p);
  // Rate limited: wait and try once more
  if (response.status === 429 && attempt < 1) {
    await sleep(retryAfterMs(response));
    return generatePollinationsBlob(prompt, p, attempt + 1);
  }
  if (!response.ok) throw new Error(await pollinationsError(response));
  const blob = await response.blob();
  if (!blob.type || !blob.type.startsWith('image/')) {
    throw new Error(`Unexpected response type: ${blob.type || 'unknown'}`);
  }
  return blob;
}

// OpenAI-compatible image generation (Logfare and other custom providers)
async function generateOpenAIBlob(provider, prompt, p, attempt = 0) {
  const body = { model: p.model, prompt, size: `${p.width}x${p.height}` };
  if (provider.b64) body.response_format = 'b64_json';

  const res = await providerFetch(`${provider.baseUrl}/images/generations`, {
    method: 'POST',
    headers: providerHeaders(provider, true),
    body: JSON.stringify(body)
  });

  // Rate limited: wait for Retry-After (at most 15 s) and try once more
  if (res.status === 429 && attempt < 1) {
    await sleep(retryAfterMs(res));
    return generateOpenAIBlob(provider, prompt, p, attempt + 1);
  }
  if (!res.ok) throw new Error(await readError(res));

  const data = await res.json();
  const item = data && data.data && data.data[0];
  if (item && item.b64_json) return b64ToBlob(item.b64_json);
  if (item && item.url) {
    // Plain request on purpose: the image link may be on another host, so no key is sent to it
    let imageRes;
    try {
      imageRes = await fetch(item.url);
    } catch (_) {
      throw new Error('The image was generated, but the browser could not download it (the image host blocks this site). Try turning on "Ask for base64 images" for this provider.');
    }
    if (!imageRes.ok) throw new Error(`Could not download the generated image (HTTP ${imageRes.status}).`);
    const bytes = new Uint8Array(await imageRes.arrayBuffer());
    return new Blob([bytes], { type: sniffImageType(bytes) });
  }
  throw new Error('The provider returned no image.');
}

// ModelScope: submit a task, then poll it until the image is ready
async function generateModelScopeBlob(provider, prompt, p) {
  const submit = await providerFetch(`${provider.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { ...providerHeaders(provider, true), 'X-ModelScope-Async-Mode': 'true' },
    body: JSON.stringify({ model: p.model, prompt, size: `${p.width}x${p.height}` })
  });
  if (!submit.ok) {
    throw new Error(await readError(submit));
  }
  const task = await submit.json();
  const taskId = task && (task.task_id || (task.data && task.data.task_id));
  if (!taskId) throw new Error('ModelScope did not return a task id.');

  const headers = providerHeaders(provider);
  headers['X-ModelScope-Task-Type'] = 'image_generation';
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(MODELSCOPE_POLL_MS);
    const res = await providerFetch(`${provider.baseUrl}/tasks/${encodeURIComponent(taskId)}`, { headers });
    if (!res.ok) throw new Error(await readError(res));
    const data = await res.json();
    const status = String(data.task_status || '').toUpperCase();
    if (status === 'SUCCEED' || status === 'SUCCEEDED') {
      const url = data.output_images && data.output_images[0];
      if (!url) throw new Error('ModelScope finished but returned no image.');
      let imageRes;
      try {
        imageRes = await fetch(url);
      } catch (_) {
        throw new Error('The image was generated, but the browser could not download it (the image host blocks this site).');
      }
      if (!imageRes.ok) throw new Error(`Could not download the generated image (HTTP ${imageRes.status}).`);
      const bytes = new Uint8Array(await imageRes.arrayBuffer());
      return new Blob([bytes], { type: sniffImageType(bytes) });
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
      const reason = data.errors && (data.errors.message || data.errors);
      throw new Error(`ModelScope could not make the image${reason ? `: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}` : '.'}`);
    }
  }
  throw new Error('ModelScope took too long (over 3 minutes). Try again.');
}
let MODELSCOPE_POLL_MS = 2000;

// One entry point for image generation; always returns an image Blob
async function generateBlob(prompt, p) {
  if (p.providerId === POLLINATIONS_ID) return generatePollinationsBlob(prompt, p);
  const provider = state.providers.find((x) => x.id === p.providerId);
  if (!provider) throw new Error('That provider was removed. Pick another model.');
  if (isModelScope(provider)) return generateModelScopeBlob(provider, prompt, p);
  return generateOpenAIBlob(provider, prompt, p);
}

// How many images to request at once
function providerConcurrency(providerId) {
  if (providerId === POLLINATIONS_ID) return 3;
  const provider = state.providers.find((x) => x.id === providerId);
  return Math.min(6, Math.max(1, (provider && provider.parallel) || 2));
}

// Generate image
async function generateImage() {
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) {
    promptRequired();
    return;
  }

  // A new single image replaces any batch on screen
  revokeBatchUrls();
  state.batchResults = [];
  state.batchProgress = { current: 0, total: 0 };
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
    renderResultPanel(null, false, err.message);
  } finally {
    state.isGenerating = false;
    document.getElementById('generateBtn').disabled = false;
  }
}

// Copy the prompt of the image on screen
function copyPrompt() {
  if (!state.current) return;
  navigator.clipboard.writeText(state.current.prompt)
    .then(() => toast('Prompt copied!'))
    .catch(() => toast('Could not copy the prompt.', 'err'));
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

// Generate button: one image, or a batch when the image count is above 1
function handleGenerate() {
  if (state.isGenerating) return;
  const count = parseInt(document.getElementById('batchCount').value, 10) || 1;
  if (count > 1) {
    state.batchCount = count;
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
    promptRequired();
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

    // Generate images concurrently, a few at a time (providers can have request limits)
    const concurrency = providerConcurrency(baseParams.providerId);
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

  // Close a sheet by tapping the dimmed area around it, or with Escape
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSheet(overlay.id);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllSheets();
  });

  state.providers = loadProviders();
  document.getElementById('providerList').addEventListener('click', onProviderListClick);
  renderProviderList();

  renderResultPanel();
  renderHistoryPanel();
  renderParamsPanel(); // usable immediately with the built-in model list
  const historyReady = initHistory();

  // Refresh model lists in the background; the prompt box and selection are kept
  await Promise.all([fetchImageModels(), refreshAllProviders()]);
  refreshModelSelect();
  await historyReady;
}

document.addEventListener('DOMContentLoaded', init);
