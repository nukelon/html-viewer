const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const clearBtn = document.getElementById('clearBtn');
const previewBtn = document.getElementById('previewBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const entryInput = document.getElementById('entryInput');
const fileTree = document.getElementById('fileTree');
const filePanel = document.getElementById('filePanel');
const previewPanel = document.getElementById('previewPanel');
const previewFrame = document.getElementById('previewFrame');
const splitter = document.getElementById('splitter');
const workspace = document.getElementById('workspace');
const pauseMask = document.getElementById('pauseMask');
const fullscreenCorners = document.getElementById('fullscreenCorners');

const files = new Map();
const CACHE_NAME = 'html-viewer-vfs';
const FULLSCREEN_HINT_KEY = 'html-viewer-hide-fullscreen-hint';
let swReady = null;
let isPreviewing = false;
let isPaused = false;
let isFullscreen = false;

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

function appendFile(path, blob) {
  files.set(normalizePath(path), blob);
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
    puts.push(cache.put(url, new Response(blob)));
  }
  await Promise.all(puts);
}

function showPreviewControls() {
  pauseBtn.classList.remove('hidden');
  stopBtn.classList.remove('hidden');
  fullscreenBtn.classList.remove('hidden');
}

function hidePreviewControls() {
  pauseBtn.classList.add('hidden');
  stopBtn.classList.add('hidden');
  fullscreenBtn.classList.add('hidden');
}

function enterPreviewMode() {
  filePanel.style.width = '25%';
  previewPanel.classList.remove('hidden');
  splitter.classList.remove('hidden');
  isPreviewing = true;
  setPaused(false);
  showPreviewControls();
}

function stopPreview() {
  isPreviewing = false;
  setPaused(false);
  exitFullscreen(false);
  previewFrame.src = 'about:blank';
  previewPanel.classList.add('hidden');
  splitter.classList.add('hidden');
  filePanel.style.width = '100%';
  hidePreviewControls();
}

function setPaused(paused) {
  isPaused = paused;
  previewFrame.style.visibility = paused ? 'hidden' : 'visible';
  pauseMask.classList.toggle('hidden', !paused);
  pauseBtn.textContent = paused ? '继续' : '暂停';
}

function maybeShowFullscreenHint() {
  if (localStorage.getItem(FULLSCREEN_HINT_KEY) === '1') return;

  const disableHint = window.confirm('全屏模式已开启。\n连续点击屏幕任意角落（左上/右上/左下/右下）4次可退出全屏。\n点击“确定”下次不再显示该提示，点击“取消”保留提示。');
  if (disableHint) {
    localStorage.setItem(FULLSCREEN_HINT_KEY, '1');
  }
}

function exitFullscreen(restoreButtonLabel = true) {
  if (!isFullscreen) return;
  isFullscreen = false;
  document.body.classList.remove('app-fullscreen');
  fullscreenCorners.classList.add('hidden');
  fullscreenCorners.setAttribute('aria-hidden', 'true');
  fullscreenCorners.dataset.count = '0';
  if (restoreButtonLabel) {
    fullscreenBtn.textContent = '全屏';
  }
}

function enterFullscreen() {
  if (!isPreviewing) return;
  isFullscreen = true;
  document.body.classList.add('app-fullscreen');
  fullscreenCorners.classList.remove('hidden');
  fullscreenCorners.setAttribute('aria-hidden', 'false');
  fullscreenCorners.dataset.count = '0';
  fullscreenBtn.textContent = '退出全屏';
  maybeShowFullscreenHint();
}

async function onPreview() {
  const entry = normalizePath(`${entryInput.value.trim() || 'index'}.html`);
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
  previewFrame.src = `${base}${entry}`;
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

previewBtn.addEventListener('click', onPreview);

pauseBtn.addEventListener('click', () => {
  if (!isPreviewing) return;
  setPaused(!isPaused);
});

stopBtn.addEventListener('click', () => {
  stopPreview();
});

fullscreenBtn.addEventListener('click', () => {
  if (!isPreviewing) return;
  if (isFullscreen) {
    exitFullscreen();
    return;
  }
  enterFullscreen();
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

setupResizableSidebar();
renderTree();
