// Theme Management
function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
}

// Initialize theme on load
initTheme();

// State
const state = {
  apiKey: localStorage.getItem('pollinations_api_key') || '',
  history: JSON.parse(localStorage.getItem('pollinations_history') || '[]'),
  isGenerating: false,
  // Batch generation state
  batchMode: false,
  batchCount: 4,
  batchResults: [],
  batchProgress: { current: 0, total: 0 }
};

// Default config
const defaults = {
  model: 'z-image-turbo',
  width: 512,
  height: 512,
  seed: -1,
  enhance: false,
  nologo: true,
  safe: false,
  quality: 'medium'
};

const KAGGLE_CONFIG = {
  apiUrl: 'https://unified-silly-finalist.ngrok-free.dev', // ← update when ngrok URL changes
  apiKey: localStorage.getItem('kaggle_api_key') || 'YOUR_KAGGLE_API_KEY_HERE', // Set via localStorage or replace with your key
  modelId: 'z-image-turbo-kaggle'
};

// Available models (image only) - fetched dynamically from API
let imageModels = [];
let imageModelDetails = [];

// Fallback models in case API fails
const fallbackModels = [
  'z-image-turbo', 'z-image', 'zimage', 'flux', 'klein', 'klein-large', 'turbo',
  'gptimage', 'gptimage-large', 'kontext',
  'seedream', 'seedream-pro', 'nanobanana', 'nanobanana-pro',
  'z-image-turbo-kaggle'
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
    // Inject Kaggle model as a selectable option
    imageModels.push(KAGGLE_CONFIG.modelId);
    imageModelDetails.push({
        name: KAGGLE_CONFIG.modelId,
        description: '🖥️ Self-hosted on Kaggle GPU (fallback)'
    });
  } catch (e) {
    console.warn('Failed to fetch models, using fallback:', e);
    imageModels = fallbackModels;
    imageModelDetails = [];
  }
}

// Quality options
const qualityOptions = ['low', 'medium', 'high', 'hd'];

// Model pricing tier (lower number = cheaper/free)
const modelPricingTier = {
  'flux': 1,
  'zimage': 2,
  'z-image-turbo-kaggle': 0,
  'z-image': 2,
  'nanobanana': 2,
  'z-image-turbo': 3,
  'turbo': 3,
  'gptimage': 3,
  'kontext': 3,
  'seedream': 3,
  'klein': 4,
  'gptimage-large': 4,
  'seedream-pro': 4,
  'nanobanana-pro': 4,
  'klein-large': 5
};

// Blob to Base64
function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// Modal functions
function openModal() {
  document.getElementById('apiModal').classList.add('show');
  document.getElementById('apiKey').value = state.apiKey;
  document.getElementById('kaggleApiKey').value = localStorage.getItem('kaggle_api_key') || '';
}

function closeModal() {
  document.getElementById('apiModal').classList.remove('show');
}

// Render params panel
function renderParamsPanel() {
  // Sort models by pricing tier (cheapest first)
  const sortedModels = [...imageModels].sort((a, b) => {
    const tierA = modelPricingTier[a] || 99;
    const tierB = modelPricingTier[b] || 99;
    return tierA - tierB;
  });

  const modelOpts = sortedModels.map(m => {
    const detail = imageModelDetails.find(d => d.name === m);
    const label = detail ? `${m} - ${detail.description}` : m;
    const selected = m === defaults.model ? 'selected' : '';
    return `<option value="${m}" ${selected}>${label}</option>`;
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
}

// Render result panel
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
    content = `
      <div class="result-container">
        <img src="${imageUrl}" alt="Generated">
      </div>
      <div class="result-actions">
        <a href="${imageUrl}" download class="btn btn-secondary" style="text-decoration:none;">Download Image</a>
        <button class="btn btn-secondary" onclick="copyUrl('${imageUrl}')">Copy URL</button>
      </div>`;
  } else {
    content = `
      <div class="result-container">
        <p style="color:var(--text-muted);">Generated image will appear here</p>
      </div>`;
  }
  document.getElementById('result-panel').innerHTML = content;
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

// Render history panel
function renderHistoryPanel() {
  let content = '';
  let footer = '';
  if (state.history.length === 0) {
    content = `
      <div class="history-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
        <p>No history yet</p>
      </div>`;
  } else {
    content = `
      <div class="history-list">
        ${state.history.map((item, i) => `
          <div class="history-item" onclick="loadFromHistory(${i})">
            <img src="${item.url}" alt="History image">
            <div class="history-prompt">${item.prompt}</div>
            <button class="history-delete-btn" onclick="event.stopPropagation(); deleteFromHistory(${i})" title="Delete">✕</button>
          </div>
        `).join('')}
      </div>
    `;
    footer = `
      <div class="sidebar-footer">
        <button class="btn btn-secondary" style="width:100%;" onclick="clearHistory()">Clear History</button>
      </div>`;
  }
  document.getElementById('history-panel').innerHTML = `
    <div class="sidebar-header"><h2>History (${state.history.length})</h2></div>
    <div class="sidebar-content">${content}</div>
    ${footer}
  `;
}

// Save API key
function saveApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  const kaggleKey = document.getElementById('kaggleApiKey').value.trim();

  state.apiKey = key;
  localStorage.setItem('pollinations_api_key', key);

  if (kaggleKey) {
    localStorage.setItem('kaggle_api_key', kaggleKey);
  } else {
    localStorage.removeItem('kaggle_api_key');
  }

  closeModal();
  alert('API keys saved!');
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
      localStorage.setItem('pollinations_api_key', apiKey);
      // Clean URL
      history.replaceState(null, '', window.location.pathname + window.location.search);
      alert('Pollinations account connected!');
    }
  }
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

  const params = new URLSearchParams();
  params.set('model', document.getElementById('model').value);
  params.set('width', document.getElementById('width').value);
  params.set('height', document.getElementById('height').value);
  params.set('seed', document.getElementById('seed').value);
  params.set('quality', document.getElementById('quality').value);

  const negPrompt = document.getElementById('negativePrompt').value.trim();
  if (negPrompt) params.set('negative_prompt', negPrompt);

  const guidance = document.getElementById('guidanceScale').value;
  if (guidance) params.set('guidance_scale', guidance);

  const imageUrl = document.getElementById('imageUrl').value.trim();
  if (imageUrl) params.set('image', imageUrl);

  if (document.getElementById('enhance').checked) params.set('enhance', 'true');
  if (document.getElementById('nologo').checked) params.set('nologo', 'true');
  if (document.getElementById('safe').checked) params.set('safe', 'true');
  if (document.getElementById('transparent').checked) params.set('transparent', 'true');

  // Add API key to params if available (for OAuth tokens)
  if (state.apiKey) {
    params.set('key', state.apiKey);
  }

const selectedModel = document.getElementById('model').value;

if (selectedModel === KAGGLE_CONFIG.modelId) {
    // ── Kaggle / Z-Image-Turbo backend ──
    const width = document.getElementById('width').value;
    const height = document.getElementById('height').value;
    try {
        const resp = await fetch(`${KAGGLE_CONFIG.apiUrl}/v1/images/generations`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${KAGGLE_CONFIG.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'z-image-turbo',
                prompt,
                size: `${width}x${height}`,
                response_format: 'b64_json'
            })
        });
        if (!resp.ok) throw new Error('Kaggle generation failed');
        const data = await resp.json();
        const base64 = `data:image/png;base64,${data.data[0].b64_json}`;
        addToHistory({ prompt, url: base64 });
        renderResultPanel(base64);
    } catch (err) {
        alert('Error: ' + err.message);
        renderResultPanel();
    } finally {
        state.isGenerating = false;
        document.getElementById('generateBtn').disabled = false;
    }
} else {
    // ── Original Pollinations backend ──
    const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?${params}`
    try {
        const fetchOptions = {}
        const response = await fetch(url, fetchOptions)
        if (!response.ok) throw new Error('Generation failed')
        const blob = await response.blob()
        const base64 = await blobToBase64(blob)
        addToHistory(prompt, url, base64)
        renderResultPanel(base64)
    } catch (err) {
        alert('Error: ' + err.message)
        renderResultPanel()
    }
  }

  state.isGenerating = false;
  document.getElementById('generateBtn').disabled = false;
}

// Add to history
function addToHistory(item) {
  state.history.unshift(item);
  if (state.history.length > 20) state.history.pop();
  localStorage.setItem('pollinations_history', JSON.stringify(state.history));
  renderHistoryPanel();
}

// Load from history
function loadFromHistory(index) {
  const item = state.history[index];
  if (item) {
    document.getElementById('prompt').value = item.prompt;
    renderResultPanel(item.url);
  }
}

// Delete single history item
function deleteFromHistory(index) {
  state.history.splice(index, 1);
  localStorage.setItem('pollinations_history', JSON.stringify(state.history));
  renderHistoryPanel();
}

// Clear history
function clearHistory() {
  if (confirm('Clear all history?')) {
    state.history = [];
    localStorage.removeItem('pollinations_history');
    renderHistoryPanel();
  }
}

// Copy URL
function copyUrl(url) {
  navigator.clipboard.writeText(url).then(() => {
    alert('URL copied!');
  });
}

// Show batch image in modal/fullscreen
function showBatchImage(index) {
  const result = state.batchResults[index];
  if (result && result.success) {
    renderResultPanel(result.url);
  }
}

// Download all batch images
function downloadAllBatch() {
  state.batchResults.forEach((result, i) => {
    if (result && result.success) {
      const link = document.createElement('a');
      link.href = result.url;
      link.download = `generated_${i + 1}.png`;
      link.click();
    }
  });
}

// Clear batch results
function clearBatchResults() {
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

// Build generation URL with params
function buildGenerationUrl(prompt, customSeed = null) {
  const params = new URLSearchParams();
  params.set('model', document.getElementById('model').value);
  params.set('width', document.getElementById('width').value);
  params.set('height', document.getElementById('height').value);
  params.set('quality', document.getElementById('quality').value);

  // Use custom seed or random for batch
  const seed = customSeed !== null ? customSeed : Math.floor(Math.random() * 999999);
  params.set('seed', seed);

  const negPrompt = document.getElementById('negativePrompt').value.trim();
  if (negPrompt) params.set('negative_prompt', negPrompt);

  const guidance = document.getElementById('guidanceScale').value;
  if (guidance) params.set('guidance_scale', guidance);

  const imageUrl = document.getElementById('imageUrl').value.trim();
  if (imageUrl) params.set('image', imageUrl);

  if (document.getElementById('enhance').checked) params.set('enhance', 'true');
  if (document.getElementById('nologo').checked) params.set('nologo', 'true');
  if (document.getElementById('safe').checked) params.set('safe', 'true');
  if (document.getElementById('transparent').checked) params.set('transparent', 'true');

  // Add API key to params if available (for OAuth tokens)
  if (state.apiKey) {
    params.set('key', state.apiKey);
  }

  // Kaggle model: return a marker object so generateSingleForBatch can route correctly
  if (document.getElementById('model').value === KAGGLE_CONFIG.modelId) {
    return {
      __kaggle: true,
      prompt,
      width: document.getElementById('width').value,
      height: document.getElementById('height').value
    };
  }
  return `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?${params}`;
}

// Generate single image for batch
async function generateSingleForBatch(prompt, index) {
  const urlOrMarker = buildGenerationUrl(prompt);

  if (urlOrMarker && urlOrMarker.__kaggle) {
    const { width, height } = urlOrMarker;
    try {
      const resp = await fetch(`${KAGGLE_CONFIG.apiUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${KAGGLE_CONFIG.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'z-image-turbo', prompt, size: `${width}x${height}`, response_format: 'b64_json' })
      });
      if (!resp.ok) throw new Error(`Kaggle error: ${resp.status}`);
      const data = await resp.json();
      const base64 = `data:image/png;base64,${data.data[0].b64_json}`;
      return { success: true, url: base64, prompt, index };
    } catch (err) {
      return { success: false, error: err.message, prompt, index };
    }
  }

  try {
    const response = await fetch(url, fetchOptions);
    if (!response.ok) throw new Error('Generation failed');
    const blob = await response.blob();
    const base64 = await blobToBase64(blob);
    return { success: true, url: base64, prompt, index };
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
  state.batchResults = [];
  state.batchProgress = { current: 0, total: state.batchCount };
  document.getElementById('generateBtn').disabled = true;

  renderBatchResultPanel();

  // Generate images concurrently (max 9 at a time)
  const concurrency = 9;
  const results = [];

  for (let i = 0; i < state.batchCount; i += concurrency) {
    const batch = [];
    for (let j = i; j < Math.min(i + concurrency, state.batchCount); j++) {
      batch.push(generateSingleForBatch(prompt, j));
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
      addToHistory({ prompt, url: result.url });
    }
  }

  state.isGenerating = false;
  document.getElementById('generateBtn').disabled = false;
}

// Initialize
async function init() {
  checkAuthCallback();
  renderResultPanel();
  renderHistoryPanel();

  // Fetch models from API, then render params panel
  await fetchImageModels();
  renderParamsPanel();

  // Close modal on overlay click
  document.getElementById('apiModal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) closeModal();
  });
}

document.addEventListener('DOMContentLoaded', init);
