const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const clearBtn = document.getElementById('clearBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsMenu = document.getElementById('settingsMenu');
const userAgentInput = document.getElementById('userAgentInput');
const entryInput = document.getElementById('entryInput');
const backBtn = document.getElementById('backBtn');
const forwardBtn = document.getElementById('forwardBtn');
const fileTree = document.getElementById('fileTree');
const filePanel = document.getElementById('filePanel');
const previewPanel = document.getElementById('previewPanel');
const previewFrame = document.getElementById('previewFrame');
const progressTrack = document.getElementById('progressTrack');
const progressBar = document.getElementById('progressBar');
const frameWarning = document.getElementById('frameWarning');
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
let swReady = null;
let isPreviewing = false;
let isPaused = false;
let isFullscreen = false;
let currentPreviewTarget = '';
let pendingNavigationUrl = '';
let suppressNextHistoryPush = false;
let lastKnownFrameUrl = '';

let progressTimer = null;
let progressValue = 0;
let pauseMask = null;
const hookedDocs = new WeakSet();

const mediaElements = new Set();
const mediaStateMap = new WeakMap();
const animationMap = new WeakMap();

const previewHistory = [];
let previewHistoryIndex = -1;

function showFrameWarning(message) {
  if (!message) {
    frameWarning.textContent = '';
    frameWarning.classList.add('hidden');
    return;
  }
  frameWarning.textContent = message;
  frameWarning.classList.remove('hidden');
}

function isFrameLikelyBlocked(url) {
  return Boolean(url && /^(chrome-error:\/\/|about:blank$|data:text\/html,chromewebdata)/i.test(url));
}

function getDisplayTarget(url) {
  if (!url) return '';
  const base = new URL(`${location.pathname.replace(/[^/]*$/, '')}__vfs__/`, location.href).href;
  if (url.startsWith(base)) return decodeURIComponent(url.slice(base.length));
  return url;
}

function updateEntryInput(url) {
  entryInput.value = getDisplayTarget(url);
}

function navigateFrame(url, options = {}) {
  const { fromHistory = false, replaceHistory = false } = options;
  currentPreviewTarget = url;
  pendingNavigationUrl = url;
  suppressNextHistoryPush = fromHistory;
  updateEntryInput(url);
  startProgress();
  if (!fromHistory) {
    if (replaceHistory && previewHistoryIndex >= 0) {
      previewHistory[previewHistoryIndex] = url;
      updateNavButtons();
    } else {
      pushHistory(url);
    }
  }
  previewFrame.src = url;
}

function updateNavButtons() {
  backBtn.disabled = !isPreviewing || previewHistoryIndex <= 0;
  forwardBtn.disabled = !isPreviewing || previewHistoryIndex >= previewHistory.length - 1;
}

function pushHistory(url) {
  if (previewHistory[previewHistoryIndex] === url) {
    updateNavButtons();
    return;
  }
  previewHistory.splice(previewHistoryIndex + 1);
  previewHistory.push(url);
  previewHistoryIndex = previewHistory.length - 1;
  updateNavButtons();
}

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
  if (!('serviceWorker' in navigator)) throw new Error('当前浏览器不支持 Service Worker，无法进行完整预览。');
  if (!swReady) {
    swReady = navigator.serviceWorker.register('./sw.js').then(async () => {
      await navigator.serviceWorker.ready;
    });
  }
  return swReady;
}

function normalizePath(path) {
  return path.replace(/^\/+/, '').replace(/\\/g, '/').replace(/\/+$/g, '').replace(/\/+/g, '/');
}

function shouldIgnorePath(path) {
  return normalizePath(path).split('/').includes('__MACOSX');
}

function appendFile(path, blob) {
  const normalized = normalizePath(path);
  if (shouldIgnorePath(normalized)) return;
  files.set(normalized, blob);
}

function stripTopLevelFolder(path) {
  const normalized = normalizePath(path);
  const parts = normalized.split('/');
  if (parts.length <= 1) return normalized;
  return parts.slice(1).join('/');
}

async function handleUpload(fileList, options = {}) {
  const { flattenFolderToRoot = false } = options;
  const selected = Array.from(fileList || []);
  if (!selected.length) return;

  const onlyZipInEmpty = files.size === 0 && selected.length === 1 && selected[0].name.toLowerCase().endsWith('.zip');
  if (onlyZipInEmpty) {
    await unzipIntoRoot(selected[0]);
  } else {
    for (const file of selected) {
      const rawPath = file.webkitRelativePath || file.name;
      const path = flattenFolderToRoot ? stripTopLevelFolder(rawPath) : normalizePath(rawPath);
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

function showPreviewControls() {
  stopBtn.classList.remove('hidden');
  fullscreenBtn.classList.remove('hidden');
}

function hidePreviewControls() {
  stopBtn.classList.add('hidden');
  fullscreenBtn.classList.add('hidden');
}

function clearProgressTimer() {
  if (!progressTimer) return;
  clearInterval(progressTimer);
  progressTimer = null;
}

function startProgress() {
  clearProgressTimer();
  progressValue = 0.08;
  progressTrack.classList.remove('hidden');
  progressBar.style.opacity = '1';
  progressBar.style.width = `${progressValue * 100}%`;
  progressTimer = setInterval(() => {
    progressValue = Math.min(0.9, progressValue + Math.max(0.01, (1 - progressValue) * 0.06));
    progressBar.style.width = `${progressValue * 100}%`;
  }, 120);
}

function completeProgress() {
  clearProgressTimer();
  progressValue = 1;
  progressBar.style.width = '100%';
  setTimeout(() => {
    progressBar.style.opacity = '0';
    setTimeout(() => {
      progressTrack.classList.add('hidden');
      progressBar.style.width = '0';
      progressBar.style.opacity = '1';
    }, 180);
  }, 120);
}

function createPauseMask() {
  if (pauseMask) return pauseMask;
  pauseMask = document.createElement('div');
  pauseMask.className = 'pause-mask';
  pauseMask.style.display = 'none';
  previewPanel.appendChild(pauseMask);
  return pauseMask;
}

function setPauseMaskVisible(visible) {
  createPauseMask().style.display = visible ? 'block' : 'none';
}

function setFrameRuntimePaused(frameWindow, paused) {
  if (!frameWindow) return;
  try {
    frameWindow.postMessage({ type: '__html_viewer_pause__', paused }, '*');
  } catch {
    // ignore cross-origin message issues
  }
}

function collectPlayableState(doc) {
  mediaElements.clear();
  if (!doc) return;
  doc.querySelectorAll('audio, video').forEach((media) => {
    mediaStateMap.set(media, !media.paused && !media.ended);
    mediaElements.add(media);
  });
  const animations = typeof doc.getAnimations === 'function' ? doc.getAnimations({ subtree: true }) : [];
  animationMap.set(doc, animations);
}

function setPaused(paused) {
  if (!isPreviewing && paused) return;
  isPaused = paused;
  previewFrame.classList.toggle('paused', paused && !isLikelyUrl(currentPreviewTarget));
  setPauseMaskVisible(paused);
  pauseBtn.classList.toggle('is-resume', !isPreviewing || paused);

  if (!isPreviewing) {
    pauseBtn.textContent = '▶︎';
    return;
  }

  const frameDoc = previewFrame.contentDocument;
  if (!frameDoc) {
    pauseBtn.textContent = paused ? '▶︎' : '⏸︎';
    setFrameRuntimePaused(previewFrame.contentWindow, paused);
    return;
  }

  if (paused) {
    collectPlayableState(frameDoc);
    mediaElements.forEach((media) => { try { media.pause(); } catch {} });
    (animationMap.get(frameDoc) || []).forEach((animation) => { try { animation.pause(); } catch {} });
    frameDoc.documentElement.classList.add('preview-paused');
    setFrameRuntimePaused(previewFrame.contentWindow, true);
    pauseBtn.textContent = '▶︎';
    return;
  }

  frameDoc.documentElement.classList.remove('preview-paused');
  setFrameRuntimePaused(previewFrame.contentWindow, false);
  pauseBtn.textContent = '⏸︎';
  mediaElements.forEach((media) => {
    if (!mediaStateMap.get(media)) return;
    const playResult = media.play();
    if (playResult?.catch) playResult.catch(() => {});
  });
  (animationMap.get(frameDoc) || []).forEach((animation) => { try { animation.play(); } catch {} });
}

function enterPreviewMode() {
  filePanel.style.width = '25%';
  previewPanel.classList.remove('hidden');
  splitter.classList.remove('hidden');
  isPreviewing = true;
  setPaused(false);
  fullscreenBtn.textContent = '⛶';
  showPreviewControls();
  updateNavButtons();
}

function stopPreview() {
  isPreviewing = false;
  setPaused(false);
  exitFullscreen(false);
  clearProgressTimer();
  progressTrack.classList.add('hidden');
  currentPreviewTarget = '';
  updateEntryInput('');
  pendingNavigationUrl = '';
  suppressNextHistoryPush = false;
  lastKnownFrameUrl = '';
  showFrameWarning('');
  previewFrame.src = 'about:blank';
  previewPanel.classList.add('hidden');
  splitter.classList.add('hidden');
  filePanel.style.width = '100%';
  hidePreviewControls();
  pauseBtn.textContent = '▶︎';
  previewFrame.classList.remove('paused');
  previewHistory.length = 0;
  previewHistoryIndex = -1;
  updateNavButtons();
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
  if (dontRemind) localStorage.setItem(FULLSCREEN_HINT_KEY, '1');
  return confirmed;
}

function exitFullscreen(restoreButtonLabel = true) {
  if (!isFullscreen) return;
  isFullscreen = false;
  document.body.classList.remove('app-fullscreen');
  fullscreenCorners.classList.add('hidden');
  fullscreenCorners.setAttribute('aria-hidden', 'true');
  fullscreenCorners.dataset.count = '0';
  if (restoreButtonLabel) fullscreenBtn.textContent = '⛶';
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

function isLikelyUrl(rawValue) {
  try {
    const parsed = new URL(rawValue);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function looksLikeDomain(rawValue) {
  if (!rawValue || /\s/.test(rawValue) || rawValue.includes('/')) return false;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(rawValue);
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
    // blocked by browser policy
  }
}

function resolvePreviewUrl(target) {
  if (isLikelyUrl(target)) return target;
  const entry = normalizePath(target);
  const base = `${location.pathname.replace(/[^/]*$/, '')}__vfs__/`;
  return new URL(`${base}${entry}`, location.href).href;
}

async function navigatePreview(rawTarget, options = {}) {
  const { fromHistory = false } = options;
  const inputValue = rawTarget.trim();
  const normalizedInput = looksLikeDomain(inputValue) ? `https://${inputValue}` : inputValue;
  const target = normalizedInput || 'index.html';

  if (!isLikelyUrl(target)) {
    const entry = normalizePath(target);
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
    currentPreviewTarget = entry;
  } else {
    currentPreviewTarget = target;
  }

  enterPreviewMode();
  showFrameWarning('');
  const url = resolvePreviewUrl(target);
  navigateFrame(url, { fromHistory });
  pauseBtn.textContent = '⏸︎';
}

function attachFrameNavigationHooks() {
  const frameDoc = previewFrame.contentDocument;
  if (!frameDoc || hookedDocs.has(frameDoc)) return;

  frameDoc.querySelectorAll('a[target]').forEach((anchor) => {
    anchor.removeAttribute('target');
    anchor.rel = 'noopener noreferrer';
  });

  hookedDocs.add(frameDoc);
}

function setupResizableSidebar() {
  let dragging = false;
  const minSidebarRatio = 1 / 8;
  const maxSidebarRatio = 3 / 4;

  const onDrag = (clientX) => {
    if (!isPreviewing) return;
    const rect = workspace.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    const ratio = x / rect.width;
    const clamped = Math.min(maxSidebarRatio, Math.max(minSidebarRatio, ratio));
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
    if (dragging) onDrag(event.clientX);
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
  await handleUpload(event.target.files, { flattenFolderToRoot: files.size === 0 });
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
    navigatePreview(entryInput.value);
    return;
  }
  setPaused(!isPaused);
});

stopBtn.addEventListener('click', stopPreview);

fullscreenBtn.addEventListener('click', async () => {
  if (!isPreviewing) return;
  if (isFullscreen) {
    exitFullscreen();
    return;
  }
  await enterFullscreen();
});

backBtn.addEventListener('click', () => {
  if (previewHistoryIndex <= 0) return;
  previewHistoryIndex -= 1;
  const historyUrl = previewHistory[previewHistoryIndex];
  currentPreviewTarget = historyUrl;
  updateNavButtons();
  navigateFrame(historyUrl, { fromHistory: true });
});

forwardBtn.addEventListener('click', () => {
  if (previewHistoryIndex >= previewHistory.length - 1) return;
  previewHistoryIndex += 1;
  const historyUrl = previewHistory[previewHistoryIndex];
  currentPreviewTarget = historyUrl;
  updateNavButtons();
  navigateFrame(historyUrl, { fromHistory: true });
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

previewFrame.addEventListener('load', () => {
  applyCustomUserAgentHint();
  completeProgress();
  attachFrameNavigationHooks();

  let loadedUrl = previewFrame.src;
  try {
    loadedUrl = previewFrame.contentWindow?.location?.href || previewFrame.src;
  } catch {
    loadedUrl = previewFrame.src;
  }
  const expectedUrl = pendingNavigationUrl;
  pendingNavigationUrl = '';

  lastKnownFrameUrl = loadedUrl || expectedUrl || lastKnownFrameUrl;
  if (lastKnownFrameUrl) {
    currentPreviewTarget = lastKnownFrameUrl;
    updateEntryInput(lastKnownFrameUrl);
  }

  if (isFrameLikelyBlocked(loadedUrl) && isLikelyUrl(currentPreviewTarget || expectedUrl)) {
    showFrameWarning('⚠️ 该网站可能禁止在 iframe 中加载（X-Frame-Options / CSP）。请改为在浏览器新标签中打开。');
  } else {
    showFrameWarning('');
  }

  if (!suppressNextHistoryPush && isPreviewing) {
    if (!previewHistory.length) {
      pushHistory(loadedUrl);
    } else if (loadedUrl && loadedUrl !== previewHistory[previewHistoryIndex]) {
      pushHistory(loadedUrl);
    }
  }
  suppressNextHistoryPush = false;

  updateNavButtons();
  if (isPaused) setPaused(true);
});

fullscreenCorners.addEventListener('click', (event) => {
  const target = event.target.closest('.corner');
  if (!target || !isFullscreen) return;
  const count = Number(fullscreenCorners.dataset.count || '0') + 1;
  fullscreenCorners.dataset.count = String(count);
  if (count >= 4) exitFullscreen();
});

const savedUA = localStorage.getItem(USER_AGENT_KEY);
if (savedUA) userAgentInput.value = savedUA;

setInterval(() => {
  if (!isPreviewing) return;
  const observed = previewFrame.src;
  if (!observed || observed === 'about:blank' || observed === lastKnownFrameUrl) return;
  lastKnownFrameUrl = observed;
  currentPreviewTarget = observed;
  updateEntryInput(observed);
  if (observed !== previewHistory[previewHistoryIndex]) pushHistory(observed);
}, 900);

setupResizableSidebar();
pauseBtn.textContent = '▶︎';
pauseBtn.classList.add('is-resume');
stopBtn.textContent = '⏹︎';
renderTree();
updateNavButtons();
