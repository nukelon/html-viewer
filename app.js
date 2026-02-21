const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const clearBtn = document.getElementById('clearBtn');
const previewBtn = document.getElementById('previewBtn');
const entryInput = document.getElementById('entryInput');
const fileTree = document.getElementById('fileTree');
const filePanel = document.getElementById('filePanel');
const previewPanel = document.getElementById('previewPanel');
const previewFrame = document.getElementById('previewFrame');
const splitter = document.getElementById('splitter');
const workspace = document.getElementById('workspace');

const files = new Map();
const CACHE_NAME = 'html-viewer-vfs';
let swReady = null;

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

function enterPreviewMode() {
  filePanel.style.width = '33%';
  previewPanel.classList.remove('hidden');
  splitter.classList.remove('hidden');
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
  const minRatio = 1 / 8;
  const maxRatio = 3 / 2;

  splitter.addEventListener('mousedown', () => {
    dragging = true;
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.userSelect = '';
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragging || previewPanel.classList.contains('hidden')) return;

    const rect = workspace.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const sidebarRatio = x / rect.width;
    const currentRatio = sidebarRatio / Math.max(1 - sidebarRatio, 0.001);
    const clampedRatio = Math.max(minRatio, Math.min(maxRatio, currentRatio));
    const clampedSidebar = clampedRatio / (1 + clampedRatio);
    filePanel.style.width = `${clampedSidebar * 100}%`;
  });
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
  previewFrame.src = 'about:blank';
  previewPanel.classList.add('hidden');
  splitter.classList.add('hidden');
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  await Promise.all(keys.map((request) => cache.delete(request)));
});

previewBtn.addEventListener('click', onPreview);
setupResizableSidebar();
renderTree();
