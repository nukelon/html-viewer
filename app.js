const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const clearBtn = document.getElementById('clearBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsMenu = document.getElementById('settingsMenu');
const userAgentInput = document.getElementById('userAgentInput');
const proxyInput = document.getElementById('proxyInput');
const entryInput = document.getElementById('entryInput');
const fileTree = document.getElementById('fileTree');
const filePanel = document.getElementById('filePanel');
const previewPanel = document.getElementById('previewPanel');
const previewFrame = document.getElementById('previewFrame');
const progressBar = document.getElementById('progressBar');
const splitter = document.getElementById('splitter');
const workspace = document.getElementById('workspace');
const fullscreenCorners = document.getElementById('fullscreenCorners');
const fullscreenModal = document.getElementById('fullscreenModal');
const dontRemindCheckbox = document.getElementById('dontRemindCheckbox');
const cancelFullscreenHintBtn = document.getElementById('cancelFullscreenHintBtn');
const confirmFullscreenHintBtn = document.getElementById('confirmFullscreenHintBtn');

const files = new Map();
const CACHE_NAME = 'html-viewer-vfs';
const FULLSCREEN_HINT_KEY = 'html-viewer-hide-fullscreen-hint';
const USER_AGENT_KEY = 'html-viewer-custom-user-agent';
const PROXY_TEMPLATE_KEY = 'html-viewer-proxy-template';
const DEFAULT_PROXY_TEMPLATE = 'https://corsproxy.io/?{url}';
let swReady = null;
let isPreviewing = false;
let isPaused = false;
let isFullscreen = false;
let pauseTimerId = null;
let progressTimerId = null;

const mediaElements = new Set();
const mediaStateMap = new WeakMap();
const animationMap = new WeakMap();

function guessMimeType(path) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const table = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon'
  };
  return table[ext] || 'application/octet-stream';
}

async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('当前浏览器不支持 Service Worker，无法进行完整预览。');
  }
  if (!swReady) {
    swReady = navigator.serviceWorker.register('./sw.js').then(async () => {
      await navigator.serviceWorker.ready;
    });
  }
  return swReady;
}

function normalizePath(path) {
  return path.replace(/^\/+/, '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

function shouldIgnorePath(path) {
  const normalized = normalizePath(path);
  return normalized.split('/').includes('__MACOSX');
}

function appendFile(path, blob) {
  const normalized = normalizePath(path);
  if (shouldIgnorePath(normalized)) return;
  files.set(normalized, blob);
}

async function handleUpload(fileList) {
  const selected = Array.from(fileList || []);
  if (!selected.length) return;

  const onlyZipInEmpty = files.size === 0 && selected.length === 1 && selected[0].name.toLowerCase().endsWith('.zip');

  if (onlyZipInEmpty) {
    await unzipIntoRoot(selected[0]);
  } else {
    for (const file of selected) {
      const path = normalizePath(file.webkitRelativePath || file.name);
      appendFile(path, file);
    }
  }

  renderTree();
}

async function unzipIntoRoot(zipFile) {
  if (!window.JSZip) throw new Error('ZIP 解析库尚未加载完成，请稍后重试。');

  const zip = await JSZip.loadAsync(zipFile);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);

  for (const entry of entries) {
    const content = await entry.async('blob');
    appendFile(entry.name, content);
  }
}

function renderTree() {
  fileTree.innerHTML = '';
  const list = [...files.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (!list.length) {
    fileTree.innerHTML = '<li>暂无文件</li>';
    return;
  }
  for (const path of list) {
    const li = document.createElement('li');
    li.textContent = `📄 ${path}`;
    fileTree.appendChild(li);
  }
}

async function syncCache() {
  await ensureServiceWorker();
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  await Promise.all(keys.map((request) => cache.delete(request)));

  const puts = [];
  for (const [path, blob] of files.entries()) {
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}__vfs__/${path}`;
    const mime = blob.type || guessMimeType(path);
    puts.push(cache.put(url, new Response(blob, { headers: { 'Content-Type': mime } })));
  }
  await Promise.all(puts);
}


function startLoadingProgress() {
  if (progressTimerId) clearInterval(progressTimerId);
  let value = 0;
  progressBar.classList.add('is-loading');
  progressBar.style.width = '0%';
  progressTimerId = setInterval(() => {
    value = Math.min(92, value + Math.max(1, (92 - value) * 0.12));
    progressBar.style.width = `${value}%`;
  }, 120);
}

function finishLoadingProgress() {
  if (progressTimerId) {
    clearInterval(progressTimerId);
    progressTimerId = null;
  }
  progressBar.style.width = '100%';
  setTimeout(() => {
    progressBar.classList.remove('is-loading');
    progressBar.style.width = '0%';
  }, 220);
}

function showPreviewControls() {
  stopBtn.classList.remove('hidden');
  fullscreenBtn.classList.remove('hidden');
}

function hidePreviewControls() {
  stopBtn.classList.add('hidden');
  fullscreenBtn.classList.add('hidden');
}

function enterPreviewMode() {
  filePanel.style.width = '25%';
  previewPanel.classList.remove('hidden');
  splitter.classList.remove('hidden');
  isPreviewing = true;
  setPaused(false);
  fullscreenBtn.textContent = '⛶';
  showPreviewControls();
}

function stopPreview() {
  isPreviewing = false;
  setPaused(false);
  exitFullscreen(false);
  previewFrame.src = 'about:blank';
  finishLoadingProgress();
  previewPanel.classList.add('hidden');
  splitter.classList.add('hidden');
  filePanel.style.width = '100%';
  hidePreviewControls();
  pauseBtn.textContent = '▶︎';
  previewFrame.classList.remove('paused');
}

function collectPlayableState(doc) {
  mediaElements.clear();
  if (!doc) return;

  const mediaList = doc.querySelectorAll('audio, video');
  for (const media of mediaList) {
    const wasPlaying = !media.paused && !media.ended;
    mediaStateMap.set(media, wasPlaying);
    mediaElements.add(media);
  }

  const animations = typeof doc.getAnimations === 'function' ? doc.getAnimations({ subtree: true }) : [];
  animationMap.set(doc, animations);
}

function pauseWholeFrame() {
  const frameWindow = previewFrame.contentWindow;
  const frameDoc = previewFrame.contentDocument;
  if (!frameWindow || !frameDoc) return;

  collectPlayableState(frameDoc);

  mediaElements.forEach((media) => {
    try { media.pause(); } catch {}
  });

  const animations = animationMap.get(frameDoc) || [];
  animations.forEach((animation) => {
    try { animation.pause(); } catch {}
  });

  frameDoc.documentElement.classList.add('preview-paused');
  frameDoc.querySelectorAll('*').forEach((el) => {
    if (el && el.style) {
      el.style.animationPlayState = 'paused';
      el.style.transitionProperty = 'none';
      el.style.caretColor = 'transparent';
    }
  });

  try {
    frameWindow.stop();
  } catch {}
}

function resumeWholeFrame() {
  const frameDoc = previewFrame.contentDocument;
  if (!frameDoc) return;

  frameDoc.documentElement.classList.remove('preview-paused');
  frameDoc.querySelectorAll('*').forEach((el) => {
    if (el && el.style) {
      el.style.removeProperty('animation-play-state');
      el.style.removeProperty('transition-property');
      el.style.removeProperty('caret-color');
    }
  });

  mediaElements.forEach((media) => {
    if (!mediaStateMap.get(media)) return;
    const playResult = media.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => {});
    }
  });

  const animations = animationMap.get(frameDoc) || [];
  animations.forEach((animation) => {
    try { animation.play(); } catch {}
  });
}

function setPaused(paused) {
  if (!isPreviewing && paused) return;
  isPaused = paused;
  previewFrame.classList.toggle('paused', paused);
  pauseBtn.classList.toggle('is-resume', !isPreviewing || paused);

  if (pauseTimerId) {
    clearInterval(pauseTimerId);
    pauseTimerId = null;
  }

  if (!isPreviewing) {
    pauseBtn.textContent = '▶︎';
    return;
  }

  if (paused) {
    pauseWholeFrame();
    pauseTimerId = setInterval(() => {
      if (!isPaused) return;
      pauseWholeFrame();
    }, 120);
    pauseBtn.textContent = '▶︎';
    return;
  }

  resumeWholeFrame();
  pauseBtn.textContent = '⏸︎';
}

function showFullscreenHintModal() {
  fullscreenModal.classList.remove('hidden');
  dontRemindCheckbox.checked = false;
  return new Promise((resolve) => {
    const close = (confirmed) => {
      fullscreenModal.classList.add('hidden');
      cancelFullscreenHintBtn.removeEventListener('click', onCancel);
      confirmFullscreenHintBtn.removeEventListener('click', onConfirm);
      resolve({ confirmed, dontRemind: dontRemindCheckbox.checked });
    };

    const onCancel = () => close(false);
    const onConfirm = () => close(true);

    cancelFullscreenHintBtn.addEventListener('click', onCancel);
    confirmFullscreenHintBtn.addEventListener('click', onConfirm);
  });
}

async function maybeShowFullscreenHint() {
  if (localStorage.getItem(FULLSCREEN_HINT_KEY) === '1') return true;
  const { confirmed, dontRemind } = await showFullscreenHintModal();
  if (dontRemind) {
    localStorage.setItem(FULLSCREEN_HINT_KEY, '1');
  }
  return confirmed;
}

function exitFullscreen(restoreButtonLabel = true) {
  if (!isFullscreen) return;
  isFullscreen = false;
  document.body.classList.remove('app-fullscreen');
  fullscreenCorners.classList.add('hidden');
  fullscreenCorners.setAttribute('aria-hidden', 'true');
  fullscreenCorners.dataset.count = '0';
  if (restoreButtonLabel) {
    fullscreenBtn.textContent = '⛶';
  }
}

async function enterFullscreen() {
  if (!isPreviewing) return;
  const confirmed = await maybeShowFullscreenHint();
  if (!confirmed) return;
  isFullscreen = true;
  document.body.classList.add('app-fullscreen');
  fullscreenCorners.classList.remove('hidden');
  fullscreenCorners.setAttribute('aria-hidden', 'false');
  fullscreenCorners.dataset.count = '0';
  fullscreenBtn.textContent = '退出';
}

function getProxyTemplate() {
  const template = proxyInput.value.trim();
  return template || DEFAULT_PROXY_TEMPLATE;
}

function wrapWithProxy(rawUrl) {
  const template = getProxyTemplate();
  if (!template) return rawUrl;
  const encoded = encodeURIComponent(rawUrl);
  return template.includes('{url}') ? template.replaceAll('{url}', encoded) : `${template}${encoded}`;
}

function isLikelyUrl(rawValue) {
  try {
    const parsed = new URL(rawValue);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function applyCustomUserAgentHint() {
  const customUA = userAgentInput.value.trim();
  if (!customUA) return;

  try {
    const frameWindow = previewFrame.contentWindow;
    if (!frameWindow) return;
    Object.defineProperty(frameWindow.navigator, 'userAgent', {
      configurable: true,
      get: () => customUA
    });
  } catch {
    // Browsers may block this operation.
  }
}

async function onPreview() {
  const inputValue = entryInput.value.trim();
  const resolvedInput = inputValue || 'index.html';

  if (isLikelyUrl(resolvedInput)) {
    enterPreviewMode();
    startLoadingProgress();
    previewFrame.src = wrapWithProxy(resolvedInput);
    pauseBtn.textContent = '⏸︎';
    return;
  }

  const entry = normalizePath(resolvedInput);
  if (!files.has(entry)) {
    alert(`未找到文件：${entry}`);
    return;
  }

  try {
    await syncCache();
  } catch (error) {
    alert(error.message);
    return;
  }

  enterPreviewMode();
  const base = `${location.pathname.replace(/[^/]*$/, '')}__vfs__/`;
  startLoadingProgress();
  previewFrame.src = `${base}${entry}`;
  pauseBtn.textContent = '⏸︎';
}

function setupResizableSidebar() {
  let dragging = false;
  const minSidebarRatio = 1 / 8;
  const maxSidebarRatio = 3 / 4;

  const onDrag = (clientX) => {
    if (!isPreviewing) return;
    const rect = workspace.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    const sidebarRatio = x / rect.width;
    const clamped = Math.min(maxSidebarRatio, Math.max(minSidebarRatio, sidebarRatio));
    filePanel.style.width = `${clamped * 100}%`;
  };

  splitter.addEventListener('pointerdown', (event) => {
    if (!isPreviewing) return;
    dragging = true;
    splitter.setPointerCapture(event.pointerId);
    document.body.style.userSelect = 'none';
    onDrag(event.clientX);
  });

  splitter.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    onDrag(event.clientX);
  });

  const endDrag = (event) => {
    dragging = false;
    document.body.style.userSelect = '';
    if (event?.pointerId !== undefined && splitter.hasPointerCapture(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
  };

  splitter.addEventListener('pointerup', endDrag);
  splitter.addEventListener('pointercancel', endDrag);
}

fileInput.addEventListener('change', async (event) => {
  await handleUpload(event.target.files);
  fileInput.value = '';
});

folderInput.addEventListener('change', async (event) => {
  const selected = Array.from(event.target.files || []);
  if (files.size === 0 && selected.length) {
    const firstSegments = selected.map((file) => normalizePath(file.webkitRelativePath || file.name).split('/')[0]);
    const root = firstSegments[0];
    const shouldFlatten = root && firstSegments.every((segment) => segment === root);
    if (shouldFlatten) {
      for (const file of selected) {
        const full = normalizePath(file.webkitRelativePath || file.name);
        const flattened = normalizePath(full.split('/').slice(1).join('/'));
        appendFile(flattened || file.name, file);
      }
      renderTree();
      folderInput.value = '';
      return;
    }
  }

  await handleUpload(event.target.files);
  folderInput.value = '';
});

clearBtn.addEventListener('click', async () => {
  files.clear();
  renderTree();
  stopPreview();
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  await Promise.all(keys.map((request) => cache.delete(request)));
});

pauseBtn.addEventListener('click', () => {
  if (!isPreviewing) {
    onPreview();
    return;
  }
  setPaused(!isPaused);
});

stopBtn.addEventListener('click', () => {
  stopPreview();
});

fullscreenBtn.addEventListener('click', async () => {
  if (!isPreviewing) return;
  if (isFullscreen) {
    exitFullscreen();
    return;
  }
  await enterFullscreen();
});

settingsBtn.addEventListener('click', () => {
  settingsMenu.classList.toggle('hidden');
});

document.addEventListener('click', (event) => {
  if (settingsMenu.classList.contains('hidden')) return;
  if (settingsMenu.contains(event.target) || settingsBtn.contains(event.target)) return;
  settingsMenu.classList.add('hidden');
});

userAgentInput.addEventListener('input', () => {
  localStorage.setItem(USER_AGENT_KEY, userAgentInput.value);
});

proxyInput.addEventListener('input', () => {
  localStorage.setItem(PROXY_TEMPLATE_KEY, proxyInput.value);
});

previewFrame.addEventListener('load', () => {
  finishLoadingProgress();
  applyCustomUserAgentHint();
  if (!isPaused) return;
  setPaused(true);
});

fullscreenCorners.addEventListener('click', (event) => {
  const target = event.target.closest('.corner');
  if (!target || !isFullscreen) return;
  const count = Number(fullscreenCorners.dataset.count || '0') + 1;
  fullscreenCorners.dataset.count = String(count);
  if (count >= 4) {
    exitFullscreen();
  }
});

const savedUA = localStorage.getItem(USER_AGENT_KEY);
if (savedUA) {
  userAgentInput.value = savedUA;
}

const savedProxyTemplate = localStorage.getItem(PROXY_TEMPLATE_KEY);
proxyInput.value = savedProxyTemplate || DEFAULT_PROXY_TEMPLATE;

setupResizableSidebar();
pauseBtn.textContent = '▶︎';
stopBtn.textContent = '⏹︎';
renderTree();
