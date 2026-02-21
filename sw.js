const CACHE_NAME = 'html-viewer-vfs';

const PAUSE_RUNTIME_SNIPPET = `<script>(function(){
  var paused=false;
  var styleId='__html_viewer_pause_style__';
  function ensureStyle(){
    var style=document.getElementById(styleId);
    if(style) return style;
    style=document.createElement('style');
    style.id=styleId;
    style.textContent='*,:before,:after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}html,body{pointer-events:none!important;cursor:default!important}';
    return style;
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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.includes('/__vfs__/')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const hit = await cache.match(event.request.url);
      if (!hit) return new Response('Not Found', { status: 404 });

      const contentType = hit.headers.get('Content-Type') || '';
      if (!contentType.includes('text/html')) return hit;

      const html = await hit.text();
      if (html.includes('__html_viewer_pause__')) {
        return new Response(html, { status: hit.status, statusText: hit.statusText, headers: hit.headers });
      }

      const injected = html.includes('</head>')
        ? html.replace('</head>', `${PAUSE_RUNTIME_SNIPPET}</head>`)
        : `${PAUSE_RUNTIME_SNIPPET}${html}`;

      const headers = new Headers(hit.headers);
      headers.set('Content-Type', contentType || 'text/html; charset=utf-8');
      return new Response(injected, { status: hit.status, statusText: hit.statusText, headers });
    })
  );
});
