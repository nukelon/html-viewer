const CACHE_NAME = 'html-viewer-vfs';
const APP_SHELL_FILES = new Set(['', 'index.html', 'app.js', 'styles.css', 'sw.js']);
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'cross-origin-isolated=(self)'
};

const PAUSE_RUNTIME_SNIPPET = `<script>(function(){
  var paused=false;
  var styleId='__html_viewer_pause_style__';
  var queuedTimeouts=[];
  var queuedAnimationFrames=[];

  var originalSetTimeout=window.setTimeout.bind(window);
  var originalSetInterval=window.setInterval.bind(window);
  var originalRequestAnimationFrame=window.requestAnimationFrame?window.requestAnimationFrame.bind(window):null;

  function ensureStyle(){
    var style=document.getElementById(styleId);
    if(style) return style;
    style=document.createElement('style');
    style.id=styleId;
    style.textContent='*,:before,:after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}html,body{pointer-events:none!important;cursor:default!important;overscroll-behavior:none!important}';
    return style;
  }

  window.setTimeout=function(callback,delay){
    var args=[].slice.call(arguments,2);
    if(typeof callback!=='function'){
      return originalSetTimeout(callback,delay);
    }
    return originalSetTimeout(function(){
      if(paused){
        queuedTimeouts.push(function(){ callback.apply(window,args); });
        return;
      }
      callback.apply(window,args);
    },delay);
  };

  window.setInterval=function(callback,delay){
    var args=[].slice.call(arguments,2);
    if(typeof callback!=='function'){
      return originalSetInterval(callback,delay);
    }
    return originalSetInterval(function(){
      if(paused) return;
      callback.apply(window,args);
    },delay);
  };

  if(originalRequestAnimationFrame){
    window.requestAnimationFrame=function(callback){
      return originalRequestAnimationFrame(function(ts){
        if(paused){
          queuedAnimationFrames.push(function(){ callback(ts); });
          return;
        }
        callback(ts);
      });
    };
  }

  function flushQueues(){
    if(paused) return;
    var timeouts=queuedTimeouts.slice();
    queuedTimeouts.length=0;
    timeouts.forEach(function(run){ try{run();}catch(e){} });
    var rafs=queuedAnimationFrames.slice();
    queuedAnimationFrames.length=0;
    rafs.forEach(function(run){ try{run();}catch(e){} });
  }

  function setPaused(next){
    paused=!!next;
    var root=document.documentElement;
    if(!root) return;

    if(paused){
      if(!document.getElementById(styleId)){
        document.head&&document.head.appendChild(ensureStyle());
      }
      if(typeof document.getAnimations==='function'){
        document.getAnimations({subtree:true}).forEach(function(anim){try{anim.pause();}catch(e){}});
      }
      document.querySelectorAll&&document.querySelectorAll('audio,video').forEach(function(media){try{media.pause();}catch(e){}});
      root.setAttribute('data-html-viewer-paused','1');
      return;
    }

    var style=document.getElementById(styleId);
    if(style) style.remove();
    if(typeof document.getAnimations==='function'){
      document.getAnimations({subtree:true}).forEach(function(anim){try{anim.play();}catch(e){}});
    }
    root.removeAttribute('data-html-viewer-paused');
    flushQueues();
  }

  window.addEventListener('message',function(event){
    var data=event&&event.data;
    if(!data||data.type!=='__html_viewer_pause__') return;
    setPaused(data.paused);
  });
})();</script>`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function withIsolationHeaders(response, body) {
  const headers = new Headers(response.headers);
  Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS).forEach(([key, value]) => headers.set(key, value));
  return new Response(body ?? response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function isAppShellRequest(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  const relativePath = url.pathname.startsWith(scopePath)
    ? url.pathname.slice(scopePath.length)
    : url.pathname.replace(/^\/+/, '');
  return APP_SHELL_FILES.has(relativePath);
}

async function handleAppShellRequest(request) {
  const response = await fetch(request);
  return withIsolationHeaders(response);
}

async function handleVirtualFileRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request.url);
  if (!hit) {
    return withIsolationHeaders(new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  }

  const contentType = hit.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) {
    return withIsolationHeaders(hit);
  }

  const html = await hit.text();
  const injected = html.includes('__html_viewer_pause__')
    ? html
    : html.includes('</head>')
      ? html.replace('</head>', `${PAUSE_RUNTIME_SNIPPET}</head>`)
      : `${PAUSE_RUNTIME_SNIPPET}${html}`;

  return withIsolationHeaders(hit, injected);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/__vfs__/')) {
    event.respondWith(handleVirtualFileRequest(event.request));
    return;
  }

  if (isAppShellRequest(url) || event.request.mode === 'navigate') {
    event.respondWith(handleAppShellRequest(event.request));
  }
});
