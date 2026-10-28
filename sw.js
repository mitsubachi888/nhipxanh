// Nhịp Xanh: lưu sẵn giao diện để mở nhanh. Dữ liệu luôn lấy từ Firebase, không lưu ở đây.
const VERSION='nhipxanh-v2';
const SHELL=['./','./index.html','./app.js?v=2','./config.js','./manifest.json','./icon-180.png','./icon-192.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);if(r.method!=='GET')return;
  // Never touch Firebase API traffic.
  if(/googleapis\.com$|firebaseio\.com$|firebaseapp\.com$/.test(u.hostname))return;
  const same=u.origin===location.origin,sdk=u.hostname==='www.gstatic.com'&&u.pathname.startsWith('/firebasejs/'),font=/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if(!same&&!sdk&&!font)return;
  if(same&&(r.mode==='navigate'||u.pathname.endsWith('.js'))){
    e.respondWith(fetch(r,{cache:'no-cache'}).then(res=>{const c=res.clone();caches.open(VERSION).then(x=>x.put(r,c));return res}).catch(()=>caches.match(r,{ignoreSearch:r.mode==='navigate'})));return}
  e.respondWith(caches.match(r).then(hit=>hit||fetch(r).then(res=>{if(res.ok||res.type==='opaque'){const c=res.clone();caches.open(VERSION).then(x=>x.put(r,c))}return res})));
});
