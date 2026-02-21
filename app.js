const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const clearBtn = document.getElementById('clearBtn');
const downloadAllBtn = document.getElementById('downloadAllBtn');
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
const unsavedChangesModal = document.getElementById('unsavedChangesModal');
const unsavedChangesModalText = document.getElementById('unsavedChangesModalText');
const discardUnsavedBtn = document.getElementById('discardUnsavedBtn');
const cancelUnsavedBtn = document.getElementById('cancelUnsavedBtn');
const saveUnsavedBtn = document.getElementById('saveUnsavedBtn');
const filePreviewContainer = document.getElementById('filePreviewContainer');
const filePreviewMeta = document.getElementById('filePreviewMeta');
const imagePreview = document.getElementById('imagePreview');
const videoPreview = document.getElementById('videoPreview');
const audioPreview = document.getElementById('audioPreview');
const textPreviewWrap = document.getElementById('textPreviewWrap');
const textPreview = document.getElementById('textPreview');
const textPreviewCode = document.getElementById('textPreviewCode');
const textEditor = document.getElementById('textEditor');
const editToggleBtn = document.getElementById('editToggleBtn');
const saveTextBtn = document.getElementById('saveTextBtn');
const downloadTextBtn = document.getElementById('downloadTextBtn');

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
let previewMode = 'web';
let currentPreviewFilePath = '';
let isEditingText = false;
let textEditorOriginalValue = '';
let pendingUnsavedResolver = null;

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

function getObservedFrameUrl() {
  try {
    return previewFrame.contentWindow?.location?.href || previewFrame.src;
  } catch {
    return previewFrame.src;
  }
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
  const enabled = isPreviewing && previewMode === 'web';
  backBtn.disabled = !enabled || previewHistoryIndex <= 0;
  forwardBtn.disabled = !enabled || previewHistoryIndex >= previewHistory.length - 1;
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

function extOf(path) {
  return (path.split('.').pop() || '').toLowerCase();
}

function guessMimeType(path) {
  const ext = extOf(path);
  const table = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    jsx: 'text/javascript; charset=utf-8', ts: 'text/plain; charset=utf-8', tsx: 'text/plain; charset=utf-8',
    json: 'application/json; charset=utf-8', md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8',
    xml: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac'
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

function isTextFile(path, blob) {
  if (blob.type && blob.type.startsWith('text/')) return true;
  if (blob.type && /json|javascript|xml/.test(blob.type)) return true;
  const textExt = new Set(['txt', 'md', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'json', 'xml', 'svg', 'yaml', 'yml', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'php', 'sh']);
  return textExt.has(extOf(path));
}

function getFilePreviewKind(path, blob) {
  const mime = blob.type || guessMimeType(path);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (isTextFile(path, blob)) return 'text';
  return '';
}

function languageFromExtension(path) {
  const ext = extOf(path);
  const map = {
    js: 'javascript', mjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    html: 'xml', htm: 'xml', svg: 'xml',
    yml: 'yaml', md: 'markdown', py: 'python',
    sh: 'bash'
  };
  return map[ext] || ext || 'plaintext';
}

function highlightTextContent(text, path) {
  textPreviewCode.textContent = text;
  const lang = languageFromExtension(path);
  textPreviewCode.className = `hljs language-${lang}`;
  if (!window.hljs) return;
  try {
    if (window.hljs.getLanguage?.(lang)) {
      const highlighted = window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      textPreviewCode.innerHTML = highlighted;
      return;
    }
    const auto = window.hljs.highlightAuto(text);
    textPreviewCode.innerHTML = auto.value;
  } catch {
    // ignore highlighting failures
  }
}

window.addEventListener('hljs-ready', () => {
  if (textPreviewWrap.classList.contains('hidden')) return;
  const source = textEditor.classList.contains('hidden') ? textPreviewCode.textContent : textEditor.value;
  highlightTextContent(source || '', currentPreviewFilePath);
});

function renderTree() {
  fileTree.innerHTML = '';
  const list = [...files.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (!list.length) {
    fileTree.innerHTML = '<li>暂无文件</li>';
    return;
  }
  for (const path of list) {
    const li = document.createElement('li');
    li.dataset.path = path;
    const blob = files.get(path);
    const kind = blob ? getFilePreviewKind(path, blob) : '';
    if (kind) {
      li.innerHTML = `📄 <button type="button" class="file-link" data-path="${path}">${path}</button>`;
    } else {
      li.textContent = `📄 ${path}`;
    }
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

function showPreviewControls() { stopBtn.classList.remove('hidden'); fullscreenBtn.classList.remove('hidden'); }
function hidePreviewControls() { stopBtn.classList.add('hidden'); fullscreenBtn.classList.add('hidden'); }

function clearProgressTimer() { if (!progressTimer) return; clearInterval(progressTimer); progressTimer = null; }
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

function setPauseMaskVisible(visible) { createPauseMask().style.display = visible ? 'block' : 'none'; }

function setFrameRuntimePaused(frameWindow, paused) {
  if (!frameWindow) return;
  try { frameWindow.postMessage({ type: '__html_viewer_pause__', paused }, '*'); } catch {}
}

function collectPlayableState(doc) {
  mediaElements.clear();
  if (!doc) return;
  doc.querySelectorAll('audio, video').forEach((media) => { mediaStateMap.set(media, !media.paused && !media.ended); mediaElements.add(media); });
  const animations = typeof doc.getAnimations === 'function' ? doc.getAnimations({ subtree: true }) : [];
  animationMap.set(doc, animations);
}

function setPaused(paused) {
  if ((!isPreviewing || previewMode !== 'web') && paused) return;
  isPaused = paused;
  previewFrame.classList.toggle('paused', paused && !isLikelyUrl(currentPreviewTarget));
  setPauseMaskVisible(paused);
  pauseBtn.classList.toggle('is-resume', !isPreviewing || paused || previewMode !== 'web');

  if (!isPreviewing || previewMode !== 'web') { pauseBtn.textContent = '▶︎'; return; }

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

function hideAllFilePreviewParts() {
  [imagePreview, videoPreview, audioPreview, textPreviewWrap, textEditor, saveTextBtn].forEach((el) => el.classList.add('hidden'));
}

function hasUnsavedTextChanges() {
  return isEditingText && textEditor.value !== textEditorOriginalValue;
}

function setTextEditingMode(editing) {
  isEditingText = editing;
  textEditor.classList.toggle('hidden', !editing);
  textPreview.classList.toggle('hidden', editing);
  saveTextBtn.classList.toggle('hidden', !editing);
  editToggleBtn.textContent = editing ? '取消' : '编辑';
}

function showUnsavedChangesModal(message = '你正在编辑的文件有未保存内容，是否先保存？') {
  if (pendingUnsavedResolver) {
    pendingUnsavedResolver('cancel');
    pendingUnsavedResolver = null;
  }

  unsavedChangesModalText.textContent = message;
  unsavedChangesModal.classList.remove('hidden');

  return new Promise((resolve) => {
    pendingUnsavedResolver = (choice) => {
      unsavedChangesModal.classList.add('hidden');
      pendingUnsavedResolver = null;
      resolve(choice);
    };
  });
}

async function ensureTextChangesResolvedBeforeSwitch(nextPath = '') {
  if (!currentPreviewFilePath || currentPreviewFilePath === nextPath || !hasUnsavedTextChanges()) return true;

  const choice = await showUnsavedChangesModal('检测到未保存修改。切换文件前是否保存当前编辑内容？');
  if (choice === 'save') {
    await saveTextFile({ silent: true });
    return true;
  }

  return choice === 'discard';
}

function enterPreviewMode(mode = 'web') {
  previewMode = mode;
  filePanel.style.width = '25%';
  previewPanel.classList.remove('hidden');
  splitter.classList.remove('hidden');
  isPreviewing = true;
  previewFrame.classList.toggle('hidden', mode !== 'web');
  filePreviewContainer.classList.toggle('hidden', mode !== 'file');
  pauseBtn.disabled = false;
  setPaused(false);
  fullscreenBtn.textContent = '⛶';
  showPreviewControls();
  updateNavButtons();
}

function stopPreview() {
  isPreviewing = false;
  previewMode = 'web';
  setPaused(false);
  exitFullscreen(false);
  clearProgressTimer();
  progressTrack.classList.add('hidden');
  currentPreviewTarget = '';
  pendingNavigationUrl = '';
  suppressNextHistoryPush = false;
  lastKnownFrameUrl = '';
  currentPreviewFilePath = '';
  textEditorOriginalValue = '';
  setTextEditingMode(false);
  showFrameWarning('');
  previewFrame.src = 'about:blank';
  previewPanel.classList.add('hidden');
  splitter.classList.add('hidden');
  filePreviewContainer.classList.add('hidden');
  previewFrame.classList.remove('hidden');
  filePanel.style.width = '100%';
  hidePreviewControls();
  pauseBtn.textContent = '▶︎';
  pauseBtn.disabled = false;
  previewFrame.classList.remove('paused');
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

function applyCustomUserAgentHint() {
  const customUA = userAgentInput.value.trim();
  if (!customUA) return;
  try {
    const frameWindow = previewFrame.contentWindow;
    if (!frameWindow) return;
    Object.defineProperty(frameWindow.navigator, 'userAgent', { configurable: true, get: () => customUA });
  } catch {}
}

function resolvePreviewUrl(target) {
  if (isLikelyUrl(target)) return target;
  const entry = normalizePath(target);
  const base = `${location.pathname.replace(/[^/]*$/, '')}__vfs__/`;
  return new URL(`${base}${entry}`, location.href).href;
}

async function navigatePreview(rawTarget, options = {}) {
  const { fromHistory = false } = options;
  const target = rawTarget.trim() || 'index.html';

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

  enterPreviewMode('web');
  showFrameWarning('');
  const url = resolvePreviewUrl(target);
  navigateFrame(url, { fromHistory });
  pauseBtn.textContent = '⏸︎';
}

function attachFrameNavigationHooks() {
  const frameDoc = previewFrame.contentDocument;
  const frameWindow = previewFrame.contentWindow;
  if (!frameDoc || !frameWindow || hookedDocs.has(frameDoc)) return;

  frameDoc.querySelectorAll('a[target]').forEach((anchor) => {
    anchor.removeAttribute('target');
    anchor.rel = 'noopener noreferrer';
  });

  frameDoc.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const anchor = target?.closest('a[href]');
    if (!anchor) return;
    if (anchor.hasAttribute('download')) return;
    if (anchor.getAttribute('target') && anchor.getAttribute('target') !== '_self') return;

    const rawHref = (anchor.getAttribute('href') || '').trim();
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) return;

    let nextUrl;
    try {
      nextUrl = new URL(rawHref, frameWindow.location.href).href;
    } catch {
      return;
    }

    if (!/^https?:/i.test(nextUrl)) return;

    event.preventDefault();
    navigateFrame(nextUrl);
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

  splitter.addEventListener('pointermove', (event) => { if (dragging) onDrag(event.clientX); });

  const endDrag = (event) => {
    dragging = false;
    document.body.style.userSelect = '';
    if (event?.pointerId !== undefined && splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
  };

  splitter.addEventListener('pointerup', endDrag);
  splitter.addEventListener('pointercancel', endDrag);
}

async function previewFile(path) {
  const resolved = await ensureTextChangesResolvedBeforeSwitch(path);
  if (!resolved) return;

  const blob = files.get(path);
  if (!blob) return;
  if (isPreviewing && previewMode === 'web') {
    const ok = confirm('当前正在预览网页。预览文件将自动停止网页预览，并占用当前预览区域，是否继续？');
    if (!ok) return;
  }

  const kind = getFilePreviewKind(path, blob);
  if (!kind) {
    alert('该文件类型暂不支持预览。');
    return;
  }

  currentPreviewFilePath = path;
  setTextEditingMode(false);
  hideAllFilePreviewParts();
  filePreviewMeta.textContent = `预览：${path}`;

  const objectUrl = URL.createObjectURL(blob);

  if (kind === 'image') {
    imagePreview.src = objectUrl;
    imagePreview.classList.remove('hidden');
  } else if (kind === 'video') {
    videoPreview.src = objectUrl;
    videoPreview.classList.remove('hidden');
  } else if (kind === 'audio') {
    audioPreview.src = objectUrl;
    audioPreview.classList.remove('hidden');
  } else if (kind === 'text') {
    const text = await blob.text();
    textEditorOriginalValue = text;
    textPreviewWrap.classList.remove('hidden');
    textEditor.value = text;
    highlightTextContent(text, path);
    textPreview.classList.remove('hidden');
  } else {
    textEditorOriginalValue = '';
  }

  enterPreviewMode('file');
}

async function saveTextFile(options = {}) {
  const { silent = false } = options;
  if (!currentPreviewFilePath) return;
  const text = textEditor.value;
  const mime = guessMimeType(currentPreviewFilePath);
  const blob = new Blob([text], { type: mime });
  files.set(currentPreviewFilePath, blob);
  textEditorOriginalValue = text;
  renderTree();
  if (isPreviewing && previewMode === 'file') {
    highlightTextContent(text, currentPreviewFilePath);
  }
  if (!silent) alert('保存成功。');
}

function closeFilePreviewState() {
  currentPreviewFilePath = '';
  textEditorOriginalValue = '';
  setTextEditingMode(false);
}

async function prepareToRunFromCurrentState() {
  if (previewMode === 'file' && hasUnsavedTextChanges()) {
    const choice = await showUnsavedChangesModal('检测到未保存修改。运行前是否保存当前编辑内容？');
    if (choice === 'cancel') return false;
    if (choice === 'save') await saveTextFile({ silent: true });
  }

  closeFilePreviewState();
  return true;
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.split('/').pop() || name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 800);
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

downloadAllBtn.addEventListener('click', async () => {
  if (!files.size) {
    alert('暂无可下载文件。');
    return;
  }
  if (!window.JSZip) {
    alert('ZIP 库尚未加载完成，请稍后重试。');
    return;
  }
  const zip = new JSZip();
  for (const [path, blob] of files.entries()) {
    zip.file(path, blob);
  }
  const output = await zip.generateAsync({ type: 'blob' });
  downloadBlob('all-files.zip', output);
});

fileTree.addEventListener('click', async (event) => {
  const button = event.target.closest('.file-link');
  if (!button) return;
  await previewFile(button.dataset.path);
});

editToggleBtn.addEventListener('click', () => {
  setTextEditingMode(!isEditingText);
  if (!isEditingText) {
    highlightTextContent(textEditor.value, currentPreviewFilePath);
  }
});

saveTextBtn.addEventListener('click', saveTextFile);

textEditor.addEventListener('input', () => {
  if (!currentPreviewFilePath) return;
  highlightTextContent(textEditor.value, currentPreviewFilePath);
});

downloadTextBtn.addEventListener('click', () => {
  if (!currentPreviewFilePath) return;
  const blob = files.get(currentPreviewFilePath);
  if (!blob) return;
  downloadBlob(currentPreviewFilePath, blob);
});

discardUnsavedBtn.addEventListener('click', () => pendingUnsavedResolver?.('discard'));
cancelUnsavedBtn.addEventListener('click', () => pendingUnsavedResolver?.('cancel'));
saveUnsavedBtn.addEventListener('click', () => pendingUnsavedResolver?.('save'));
unsavedChangesModal.addEventListener('click', (event) => {
  if (event.target === unsavedChangesModal) pendingUnsavedResolver?.('cancel');
});

pauseBtn.addEventListener('click', async () => {
  if (!isPreviewing || previewMode !== 'web') {
    const ready = await prepareToRunFromCurrentState();
    if (!ready) return;
    navigatePreview(entryInput.value);
    return;
  }
  setPaused(!isPaused);
});

stopBtn.addEventListener('click', stopPreview);

fullscreenBtn.addEventListener('click', async () => {
  if (!isPreviewing) return;
  if (isFullscreen) { exitFullscreen(); return; }
  await enterFullscreen();
});

backBtn.addEventListener('click', () => {
  if (previewMode !== 'web' || previewHistoryIndex <= 0) return;
  previewHistoryIndex -= 1;
  const historyUrl = previewHistory[previewHistoryIndex];
  currentPreviewTarget = historyUrl;
  updateNavButtons();
  navigateFrame(historyUrl, { fromHistory: true });
});

forwardBtn.addEventListener('click', () => {
  if (previewMode !== 'web' || previewHistoryIndex >= previewHistory.length - 1) return;
  previewHistoryIndex += 1;
  const historyUrl = previewHistory[previewHistoryIndex];
  currentPreviewTarget = historyUrl;
  updateNavButtons();
  navigateFrame(historyUrl, { fromHistory: true });
});

settingsBtn.addEventListener('click', () => { settingsMenu.classList.toggle('hidden'); });

document.addEventListener('click', (event) => {
  if (settingsMenu.classList.contains('hidden')) return;
  if (settingsMenu.contains(event.target) || settingsBtn.contains(event.target)) return;
  settingsMenu.classList.add('hidden');
});

userAgentInput.addEventListener('input', () => { localStorage.setItem(USER_AGENT_KEY, userAgentInput.value); });

previewFrame.addEventListener('load', () => {
  applyCustomUserAgentHint();
  completeProgress();

  if (!isPreviewing || previewMode !== 'web') {
    pendingNavigationUrl = '';
    suppressNextHistoryPush = false;
    return;
  }

  attachFrameNavigationHooks();

  let loadedUrl = previewFrame.src;
  try { loadedUrl = previewFrame.contentWindow?.location?.href || previewFrame.src; } catch { loadedUrl = previewFrame.src; }
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
  if (!isPreviewing || previewMode !== 'web') return;
  const observed = getObservedFrameUrl();
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
