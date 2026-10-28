/* ============ Backend: Firebase (real) or Local (single-device test) ============
   Data model
   users/{uid}                     {role:'owner'|'member', clubId, memberId?}
   clubs/{clubId}                  {name,address,hours,pilotEnd,ownerUid,ownerName,ownerFull,challenge,board,createdAt}
   clubs/{clubId}/private/day      {date,code}   (owner only: today's check-in code)
   clubs/{clubId}/members/{mid}    {name,call,color,joined,targets,pkg,status,uid,consent,inviteToken,habits,measures,att,deleteRequested,createdAt}
   invites/{token}                 {clubId,memberId,memberCall,clubName,expiresAt}
*/
const FB_VER='10.12.2';
const UNION=Symbol('union'),REMOVE=Symbol('remove'),DEL=Symbol('del');
const ops={union:v=>({[UNION]:v}),remove:v=>({[REMOVE]:v}),del:()=>({[DEL]:true})};

function hasConfig(){try{return typeof firebaseConfig!=='undefined'&&firebaseConfig&&firebaseConfig.apiKey&&!/DAN_|XXXX/.test(firebaseConfig.apiKey)}catch(_){return false}}

async function makeFirebase(){
  const base=`https://www.gstatic.com/firebasejs/${FB_VER}`;
  const [A,Au,F]=await Promise.all([import(`${base}/firebase-app.js`),import(`${base}/firebase-auth.js`),import(`${base}/firebase-firestore.js`)]);
  const app=A.initializeApp(firebaseConfig);
  const auth=Au.getAuth(app);
  let db;try{db=F.initializeFirestore(app,{localCache:F.persistentLocalCache({tabManager:F.persistentMultipleTabManager()})})}catch(_){db=F.getFirestore(app)}
  const conv=patch=>{const o={};for(const k in patch){const v=patch[k];
    if(v&&typeof v==='object'&&v[UNION]!==undefined)o[k]=F.arrayUnion(v[UNION]);
    else if(v&&typeof v==='object'&&v[REMOVE]!==undefined)o[k]=F.arrayRemove(v[REMOVE]);
    else if(v&&typeof v==='object'&&v[DEL])o[k]=F.deleteField();else o[k]=v}return o};
  const snapDoc=s=>s.exists()?{id:s.id,...s.data()}:null;
  return {
    mode:'firebase',ops,
    onAuth:cb=>Au.onAuthStateChanged(auth,u=>cb(u?{uid:u.uid,anon:u.isAnonymous,email:u.email}:null)),
    async signUpOwner({email,pass,club}){
      const cred=await Au.createUserWithEmailAndPassword(auth,email,pass);const uid=cred.user.uid;
      const cref=F.doc(F.collection(db,'clubs'));const b=F.writeBatch(db);
      b.set(cref,{...club,ownerUid:uid,createdAt:Date.now()});b.set(F.doc(db,'users',uid),{role:'owner',clubId:cref.id});
      await b.commit();return {uid,clubId:cref.id};
    },
    signInOwner:(email,pass)=>Au.signInWithEmailAndPassword(auth,email,pass),
    resetPass:email=>Au.sendPasswordResetEmail(auth,email),
    signOut:()=>Au.signOut(auth),
    async signInAnon(){if(auth.currentUser&&auth.currentUser.isAnonymous)return auth.currentUser.uid;const c=await Au.signInAnonymously(auth);return c.user.uid},
    async getUser(uid){return snapDoc(await F.getDoc(F.doc(db,'users',uid)))},
    async getInvite(t){const d=snapDoc(await F.getDoc(F.doc(db,'invites',t)));if(d&&d.expiresAt&&d.expiresAt.toMillis)d.expiresAt=d.expiresAt.toMillis();return d},
    async claim(inv,token,consent){
      const uid=auth.currentUser.uid,b=F.writeBatch(db);
      b.update(F.doc(db,'clubs',inv.clubId,'members',inv.memberId),{uid,status:'active',consent});
      b.set(F.doc(db,'users',uid),{role:'member',clubId:inv.clubId,memberId:inv.memberId});
      b.delete(F.doc(db,'invites',token));
      await b.commit();
    },
    watchClub:(c,cb,err)=>F.onSnapshot(F.doc(db,'clubs',c),s=>cb(snapDoc(s)),err),
    watchMembers:(c,cb,err)=>F.onSnapshot(F.collection(db,'clubs',c,'members'),qs=>cb(qs.docs.map(d=>({id:d.id,...d.data()}))),err),
    watchMember:(c,m,cb,err)=>F.onSnapshot(F.doc(db,'clubs',c,'members',m),s=>cb(snapDoc(s)),err),
    watchDay:(c,cb,err)=>F.onSnapshot(F.doc(db,'clubs',c,'private','day'),s=>cb(snapDoc(s)),err),
    setDay:(c,data)=>F.setDoc(F.doc(db,'clubs',c,'private','day'),data),
    memberCheckin:(c,m,code,date)=>F.updateDoc(F.doc(db,'clubs',c,'members',m),{att:F.arrayUnion(date),checkin:code}),
    async createMember(c,data){const r=F.doc(F.collection(db,'clubs',c,'members'));await F.setDoc(r,data);return r.id},
    updateMember:(c,m,patch)=>F.updateDoc(F.doc(db,'clubs',c,'members',m),conv(patch)),
    deleteMember:(c,m)=>F.deleteDoc(F.doc(db,'clubs',c,'members',m)),
    async createInvite(c,m,data){const t=token();await F.setDoc(F.doc(db,'invites',t),{clubId:c,memberId:m,...data,expiresAt:F.Timestamp.fromMillis(data.expiresAt)});return t},
    deleteInvite:t=>F.deleteDoc(F.doc(db,'invites',t)).catch(()=>{}),
    updateClub:(c,patch)=>F.updateDoc(F.doc(db,'clubs',c),conv(patch)),
    async deleteClub(c,members,uid){
      for(const m of members){if(m.inviteToken)await F.deleteDoc(F.doc(db,'invites',m.inviteToken)).catch(()=>{});await F.deleteDoc(F.doc(db,'clubs',c,'members',m.id))}
      await F.deleteDoc(F.doc(db,'clubs',c,'private','day')).catch(()=>{});
      await F.deleteDoc(F.doc(db,'clubs',c));await F.deleteDoc(F.doc(db,'users',uid)).catch(()=>{});
    }
  };
}

/* Local backend: same API over localStorage, for trying the app on one device without Firebase. */
function makeLocal(){
  const K='nhipxanh.local.v1',AK='nhipxanh.local.auth';
  const load=()=>{try{return JSON.parse(localStorage.getItem(K))||{owners:{},users:{},clubs:{},members:{},invites:{}}}catch(_){return {owners:{},users:{},clubs:{},members:{},invites:{}}}};
  let D=load();D.days=D.days||{};const subs=new Set();let authCb=null;
  let cur=(()=>{try{return JSON.parse(localStorage.getItem(AK))}catch(_){return null}})();
  const persist=()=>{try{localStorage.setItem(K,JSON.stringify(D))}catch(_){}subs.forEach(f=>f())};
  const setAuth=u=>{cur=u;try{u?localStorage.setItem(AK,JSON.stringify(u)):localStorage.removeItem(AK)}catch(_){}authCb&&authCb(cur)};
  const id=()=>Math.random().toString(36).slice(2,12);
  const apply=(obj,patch)=>{for(const k in patch){const path=k.split('.');let o=obj;for(let i=0;i<path.length-1;i++){o[path[i]]=o[path[i]]&&typeof o[path[i]]==='object'?o[path[i]]:{};o=o[path[i]]}
    const last=path[path.length-1],v=patch[k];
    if(v&&typeof v==='object'&&v[UNION]!==undefined){o[last]=Array.isArray(o[last])?o[last]:[];if(!o[last].includes(v[UNION]))o[last].push(v[UNION])}
    else if(v&&typeof v==='object'&&v[REMOVE]!==undefined){o[last]=(o[last]||[]).filter(x=>x!==v[REMOVE])}
    else if(v&&typeof v==='object'&&v[DEL])delete o[last];else o[last]=JSON.parse(JSON.stringify(v))}};
  const err=(code)=>{const e=new Error(code);e.code=code;return e};
  const watch=fn=>{fn();subs.add(fn);return()=>subs.delete(fn)};
  const clone=x=>x?JSON.parse(JSON.stringify(x)):x;
  return {
    mode:'local',ops,
    onAuth:cb=>{authCb=cb;setTimeout(()=>cb(cur),0);return()=>{authCb=null}},
    async signUpOwner({email,pass,club}){email=email.toLowerCase();if(D.owners[email])throw err('auth/email-already-in-use');if(pass.length<6)throw err('auth/weak-password');
      const uid='u'+id(),c='c'+id();D.owners[email]={pass,uid};D.clubs[c]={...club,ownerUid:uid,createdAt:Date.now()};D.members[c]={};D.users[uid]={role:'owner',clubId:c};persist();setAuth({uid,anon:false,email});return {uid,clubId:c}},
    async signInOwner(email,pass){const o=D.owners[email.toLowerCase()];if(!o||o.pass!==pass)throw err('auth/invalid-credential');setAuth({uid:o.uid,anon:false,email:email.toLowerCase()})},
    async resetPass(email){if(!D.owners[email.toLowerCase()])throw err('auth/user-not-found')},
    async signOut(){setAuth(null)},
    async signInAnon(){if(cur&&cur.anon)return cur.uid;const uid='a'+id();setAuth({uid,anon:true,email:null});return uid},
    async getUser(uid){return clone(D.users[uid])||null},
    async getInvite(t){return D.invites[t]?{id:t,...clone(D.invites[t])}:null},
    async claim(inv,token,consent){const m=D.members[inv.clubId]&&D.members[inv.clubId][inv.memberId];
      if(!m||m.uid||m.inviteToken!==token||!D.invites[token]||Date.now()>D.invites[token].expiresAt)throw err('permission-denied');
      Object.assign(m,{uid:cur.uid,status:'active',consent});D.users[cur.uid]={role:'member',clubId:inv.clubId,memberId:inv.memberId};delete D.invites[token];persist()},
    watchDay:(c,cb)=>watch(()=>cb(D.days[c]?clone(D.days[c]):null)),
    async setDay(c,data){D.days[c]=clone(data);persist()},
    async memberCheckin(c,m,code,date){const x=D.members[c][m];if(!D.days[c]||D.days[c].code!==code)throw err('permission-denied');if(!x.att.includes(date))x.att.push(date);x.checkin=code;persist()},
    watchClub:(c,cb)=>watch(()=>cb(D.clubs[c]?{id:c,...clone(D.clubs[c])}:null)),
    watchMembers:(c,cb)=>watch(()=>cb(Object.entries(D.members[c]||{}).map(([k,v])=>({id:k,...clone(v)})))),
    watchMember:(c,m,cb,e)=>watch(()=>{const x=D.members[c]&&D.members[c][m];if(!x||x.uid!==cur.uid){e&&e(err('permission-denied'));return}cb({id:m,...clone(x)})}),
    async createMember(c,data){const m='m'+id();D.members[c][m]=clone(data);persist();return m},
    async updateMember(c,m,patch){apply(D.members[c][m],patch);persist()},
    async deleteMember(c,m){delete D.members[c][m];persist()},
    async createInvite(c,m,data){const t=token();D.invites[t]={clubId:c,memberId:m,...clone(data)};persist();return t},
    async deleteInvite(t){delete D.invites[t];persist()},
    async updateClub(c,patch){apply(D.clubs[c],patch);persist()},
    async deleteClub(c,members,uid){delete D.days[c];for(const k in D.invites)if(D.invites[k].clubId===c)delete D.invites[k];delete D.members[c];delete D.clubs[c];delete D.users[uid];
      for(const e in D.owners)if(D.owners[e].uid===uid)delete D.owners[e];persist()}
  };
}
/* 8-char invite code from an alphabet without look-alike characters */
function token(){const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',r=new Uint32Array(8);crypto.getRandomValues(r);return Array.from(r,x=>A[x%A.length]).join('')}
async function makeBackend(){if(hasConfig()){try{return await makeFirebase()}catch(e){console.error(e);const b=makeLocal();b.loadError=true;return b}}return makeLocal()}

/* ============ Icons ============ */
const sv=(p,w=2.2)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const I={
  leaf:sv('<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14zM5 19l7-7"/>',2.4),
  water:sv('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
  meal:sv('<path d="M3 12h18a9 9 0 0 1-18 0zM8 8c0-2 1-2 1-4M12 8c0-2 1-2 1-4M16 8c0-2 1-2 1-4"/>'),
  ex:sv('<circle cx="14" cy="4.5" r="2"/><path d="M8 21l3-6 3 2v4M6 12l3-4 4 1 3 4h3M11 15l2-6"/>'),
  sleep:sv('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  weigh:sv('<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M8.5 10a5 5 0 0 1 7 0M12 10.5l1.5-2"/>'),
  home:sv('<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-5h4v5"/>'),
  qr:sv('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 14h2M14 18h2v2M18 18h2v2"/>'),
  users:sv('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>'),
  trophy:sv('<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8"/>'),
  chart:sv('<path d="M4 19V5M4 19h16M8 15l4-4 3 3 5-6"/>'),
  check:sv('<path d="M5 12.5l4.5 4.5L19 7.5"/>',3),
  back:sv('<path d="M15 6l-6 6 6 6"/>',2.4),
  next:sv('<path d="M9 6l6 6-6 6"/>',2.4),
  plus:sv('<path d="M12 5v14M5 12h14"/>',2.6),
  search:sv('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  flame:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 3.5 5 5.6 5 10.5A5 5 0 0 1 7 13c0-2 1-3.5 2-4.5.2 1.7 1 2.8 2 3.2C10.6 9 11 5.5 12 2z"/></svg>',
  send:sv('<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>'),
  copy:sv('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  edit:sv('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  link:sv('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  lock:sv('<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
  shield:sv('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  logout:sv('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>'),
  alert:sv('<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17v.5"/>'),
  info:sv('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  calendar:sv('<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
  ticket:sv('<path d="M4 7a2 2 0 0 0 2-2h12a2 2 0 0 0 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 0-2 2H6a2 2 0 0 0-2-2v-3a2 2 0 0 0 0-4z"/>'),
  ban:sv('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
  user:sv('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  store:sv('<path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6"/>'),
  trash:sv('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  key:sv('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>'),
  phone:sv('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/>')
};
const isz=(ic,s)=>ic.replace('<svg',`<svg width="${s}" height="${s}"`);

/* ============ Domain ============ */
const HABITS=[{k:'water',n:'Uống nước',ic:I.water,c:'var(--h-water)'},{k:'meal',n:'Bữa ăn',ic:I.meal,c:'var(--h-meal)'},{k:'ex',n:'Vận động',ic:I.ex,c:'var(--h-ex)'},{k:'sleep',n:'Giấc ngủ',ic:I.sleep,c:'var(--h-sleep)'},{k:'weigh',n:'Cân buổi sáng',ic:I.weigh,c:'var(--h-weigh)'}];
const H=k=>HABITS.find(h=>h.k===k);
const SLOTS=[{k:'sang',n:'Bữa sáng'},{k:'phus',n:'Phụ sáng'},{k:'trua',n:'Bữa trưa'},{k:'phuc',n:'Phụ chiều'},{k:'toi',n:'Bữa tối'}];
const FOODS=['Shake','Trà thảo mộc','Protein','Lô hội','Bữa thường','Bữa nhẹ'];
const METRICS=[{k:'weight',n:'Cân nặng',u:'kg',good:-1,d:1},{k:'height',n:'Chiều cao',u:'cm',good:0,d:0},{k:'bmi',n:'BMI',u:'',good:0,d:1,calc:true},{k:'fat',n:'Tỷ lệ mỡ',u:'%',good:-1,d:1},{k:'visceral',n:'Mỡ nội tạng',u:'',good:-1,d:0},{k:'muscle',n:'Khối cơ',u:'kg',good:1,d:1},{k:'water',n:'Nước cơ thể',u:'%',good:1,d:1},{k:'bioAge',n:'Tuổi sinh học',u:'tuổi',good:-1,d:0},{k:'bmr',n:'Trao đổi chất',u:'kcal',good:1,d:0},{k:'waist',n:'Vòng eo',u:'cm',good:-1,d:1},{k:'belly',n:'Vòng bụng',u:'cm',good:-1,d:1},{k:'hip',n:'Vòng mông',u:'cm',good:-1,d:1}];
const PACKS=[{kind:'sessions',name:'Gói 30 buổi',total:30},{kind:'sessions',name:'Gói 10 buổi',total:10},{kind:'time',name:'Gói 1 tháng',days:30},{kind:'time',name:'Gói 3 tháng',days:90},{kind:'both',name:'Gói 20 buổi / 45 ngày',total:20,days:45}];
const AVC=['#13803F','#2C7BD4','#D9732B','#6E57D2','#CC4A83','#0F978A','#A86400','#3E7A2E'];
const CONSENT_VER='chay-thu-v1';
const INVITE_HOURS=48;
const STANDALONE=(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;
const IOS_BROWSER=/iPhone|iPad|iPod/.test(navigator.userAgent)&&!STANDALONE;

/* ============ Dates & format ============ */
const DAY=864e5,pad=n=>String(n).padStart(2,'0');
const keyOf=t=>{const d=new Date(t);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())};
const t0=()=>{const d=new Date();d.setHours(0,0,0,0);return d.getTime()};
let TODAY=keyOf(Date.now());
const kAgo=n=>keyOf(t0()-n*DAY+12*3600e3);
const kTime=k=>{const[y,m,d]=k.split('-').map(Number);return new Date(y,m-1,d).getTime()};
const addDays=(k,n)=>keyOf(kTime(k)+n*DAY+12*3600e3);
const dShort=k=>{if(!k)return '–';const[,m,d]=k.split('-');return (+d)+'/'+(+m)};
const dFull=k=>{if(!k)return '–';const[y,m,d]=k.split('-');return (+d)+'/'+(+m)+'/'+y};
const dLong=k=>{const s=new Date(kTime(k)).toLocaleDateString('vi-VN',{weekday:'long',day:'numeric',month:'numeric'});return s.charAt(0).toUpperCase()+s.slice(1)};
const daysBetween=(a,b)=>Math.round((kTime(b)-kTime(a))/DAY);
const fmt=(v,d=0)=>v==null||isNaN(v)?'–':Number(v).toLocaleString('vi-VN',{minimumFractionDigits:d,maximumFractionDigits:d});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const cap=s=>String(s||'').charAt(0).toUpperCase()+String(s||'').slice(1);
const $=s=>document.querySelector(s);
const fmtCode=t=>t?t.slice(0,4)+'-'+t.slice(4):'';

/* ============ State ============ */
let B=null,SES=null,CLUB=null,MEMBERS=[],ME=null,DAYC=undefined,UNSUB=[],READY=false;
let tab='today',filter='all',selMode=false,sel=new Set(),q='',mfilter='all',metric='weight',page=null,ptab='overview',authStep={s:'welcome'};
const M=id=>MEMBERS.find(m=>m.id===id);
const meM=()=>ME;
function clearSubs(){UNSUB.forEach(f=>{try{f()}catch(_){}});UNSUB=[];DAYC=undefined}

/* ============ Scoring ============ */
const hOf=(m,k)=>(m.habits||{})[k]||{};
function parts(m,k){const h=hOf(m,k),t=m.targets;return {water:Math.min(1,(h.water||0)/t.water),meal:Math.min(1,Object.keys(h.meals||{}).length/t.meals),ex:Math.min(1,(h.ex||0)/t.ex),sleep:h.sleep?Math.min(1,h.sleep/t.sleep):0,weigh:h.weigh?1:0}}
function score(m,k){const p=parts(m,k);return Math.round(100*(p.water*.25+p.meal*.3+p.ex*.2+p.sleep*.15+p.weigh*.1))}
const level=s=>s>=80?'ok':s>=40?'warn':'bad';
function streak(m){let n=0;for(let a=score(m,TODAY)>=80?0:1;a<120;a++){if(score(m,kAgo(a))>=80)n++;else break}return n}
function logged(m,k=TODAY){const h=hOf(m,k);return !!(h.water||Object.keys(h.meals||{}).length||h.ex||h.sleep||h.weigh)}
const att=m=>m.att||[];
const measures=m=>{let h=null;return (m.measures||[]).slice().sort((a,b)=>a.date<b.date?-1:1).map(r=>{if(r.height)h=r.height;return h&&r.weight?{...r,bmi:Math.round(r.weight/((h/100)**2)*10)/10}:r})};
function pkgInfo(m){
  const p=m.pkg||{kind:'time',name:'Chưa có gói'},o={label:p.name,warn:false,text:'',pct:1};
  const ld=p.end?daysBetween(TODAY,p.end):null;
  if(p.kind!=='time'){const used=att(m).filter(d=>!p.start||d>=p.start).length,left=Math.max(0,p.total-used);o.left=left;o.text=`Còn ${left}/${p.total} buổi`;o.pct=left/p.total;if(left<=3)o.warn=true}
  if(p.end){const t=ld<0?'đã hết hạn':`còn ${ld} ngày`;o.text=o.text?o.text+' · '+t:'Hạn '+dShort(p.end)+' · '+t;if(p.kind==='time')o.pct=Math.max(0,ld/Math.max(1,daysBetween(p.start,p.end)));if(ld<=5)o.warn=true}
  if(!p.end&&p.kind==='time')o.text='Chưa có gói';
  o.leftDays=ld;return o;
}
function missing(m){
  const h=hOf(m,TODAY),t=m.targets,miss=[];
  if((h.water||0)<t.water)miss.push(`uống nước (mới ${fmt((h.water||0)/1000,1)}/${fmt(t.water/1000,1)} lít)`);
  const done=Object.keys(h.meals||{});if(done.length<t.meals)miss.push(SLOTS.filter(s=>!done.includes(s.k)).map(s=>s.n.toLowerCase()).slice(0,3).join(', '));
  if((h.ex||0)<t.ex)miss.push(`vận động (mới ${h.ex||0}/${t.ex} phút)`);
  if(!h.weigh)miss.push('cân buổi sáng');return miss;
}
function chPoints(m){const c=CLUB.challenge;if(!c)return 0;let p=0;for(let i=0;i<c.days;i++){const k=addDays(c.start,i);if(k>TODAY)break;p+=score(m,k)}return p}
const chDay=()=>CLUB.challenge?Math.min(CLUB.challenge.days,daysBetween(CLUB.challenge.start,TODAY)+1):0;
const initial=n=>esc(String(n||'?').trim().split(' ').slice(-1)[0].charAt(0).toUpperCase());
const av=(m,cls='')=>`<span class="av ${cls}" style="background:${m.color||'#13803F'}">${initial(m.name)}</span>`;
const ownerAv=(cls='')=>`<span class="av ${cls}" style="background:linear-gradient(135deg,#13803F,#0A4A25)">${initial(CLUB&&CLUB.ownerName)}</span>`;
const activeMembers=()=>MEMBERS.filter(m=>m.status==='active');

/* ============ Boot ============ */
async function boot(){
  B=await makeBackend();
  const url=new URL(location.href),code=(url.searchParams.get('ma')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(code){authStep={s:'code',code};history.replaceState(null,'',location.pathname)}
  B.onAuth(async u=>{
    clearSubs();CLUB=null;MEMBERS=[];ME=null;SES=null;READY=false;
    if(!u){render();return}
    if(authStep.s==='code'||authStep.s==='inv1'||authStep.s==='inv2'){render();return}
    let ud=null;for(let i=0;i<8&&!ud;i++){try{ud=await B.getUser(u.uid)}catch(e){console.warn(e)}if(!ud&&!u.anon&&authStep.creating)await new Promise(r=>setTimeout(r,700));else break}
    if(!ud){if(u.anon){render();return}renderAuthMsg('Tài khoản này chưa có club. Hãy tạo club mới.');return}
    SES={...ud,uid:u.uid,email:u.email};startSession();
  });
  if(B.mode==='local'&&B.loadError)setTimeout(()=>toast('Không tải được Firebase, đang chạy chế độ thử trên máy'),800);
  setInterval(()=>{const k=keyOf(Date.now());if(k!==TODAY){TODAY=k;render()}},60000);
}
function startSession(){
  const c=SES.clubId;
  UNSUB.push(B.watchClub(c,d=>{CLUB=d;if(!d){toast('Club không còn tồn tại');doSignOut();return}READY=true;onData()},onErr));
  if(SES.role==='owner'){UNSUB.push(B.watchMembers(c,list=>{MEMBERS=list.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));onData()},onErr));
    UNSUB.push(B.watchDay(c,d=>{DAYC=d;onData()},onErr))}
  else UNSUB.push(B.watchMember(c,SES.memberId,d=>{ME=d;onData()},e=>{if(e&&(e.code==='permission-denied'||/permission/.test(e.message))){ME=null;SES=null;clearSubs();authStep={s:'welcome',err:'Phiên đăng nhập trên máy này đã hết. Nhập mã mới chủ club gửi để vào lại.'};B.signOut();render()}else onErr(e)}));
}
function onErr(e){console.error(e);toast('Mất kết nối, đang thử lại…')}
let dataT;function onData(){clearTimeout(dataT);dataT=setTimeout(()=>{if(SES&&SES.role==='owner')ownerHousekeeping();render()},30)}
function ownerHousekeeping(){
  if(!CLUB)return;
  if(DAYC!==undefined&&(!DAYC||DAYC.date!==TODAY)&&!ownerHousekeeping.dayPending){ownerHousekeeping.dayPending=true;const r=new Uint32Array(1);crypto.getRandomValues(r);B.setDay(SES.clubId,{date:TODAY,code:String(1000+r[0]%9000)}).catch(onErr).finally(()=>{ownerHousekeeping.dayPending=false})}
  if(CLUB.challenge){const board=CLUB.challenge.ids.map(M).filter(Boolean).filter(m=>m.status==='active').map(m=>({id:m.id,call:m.call,pts:chPoints(m),st:streak(m),color:m.color,name:m.name.split(' ').slice(-1)[0]})).sort((a,b)=>b.pts-a.pts);
    const sig=JSON.stringify(board.map(x=>[x.id,x.pts,x.st]));if(sig!==ownerHousekeeping.sig&&sig!==JSON.stringify((CLUB.board||[]).map(x=>[x.id,x.pts,x.st]))){ownerHousekeeping.sig=sig;clearTimeout(ownerHousekeeping.t);ownerHousekeeping.t=setTimeout(()=>B.updateClub(SES.clubId,{board,boardAt:Date.now()}).catch(()=>{}),4000)}}
}

/* ============ Render ============ */
const OTABS=[['today','Tổng quan',I.home],['checkin','Điểm danh',I.qr],['members','Hội viên',I.users],['challenge','Thử thách',I.trophy]];
const MTABS=[['today','Hôm nay',I.home],['results','Kết quả',I.chart],['card','Thẻ của tôi',I.ticket]];
function render(){
  if(!SES){$('#app').hidden=true;$('#tabsnav').hidden=true;closePage();renderAuth();return}
  $('#auth').hidden=true;$('#auth').innerHTML='';$('#app').hidden=false;$('#tabsnav').hidden=false;
  document.body.classList.toggle('big',SES.role==='member');
  const T=SES.role==='owner'?OTABS:MTABS;
  $('#tabs').innerHTML=T.map(([k,n,ic])=>`<button data-tab="${k}" aria-current="${tab===k?'page':'false'}">${ic}<span>${n}</span></button>`).join('');
  if(!READY||(SES.role==='member'&&!ME)){$('#app').innerHTML='<div class="loading"><span class="spin"></span>Đang tải…</div>';return}
  const v=SES.role==='owner'?{today:oToday,checkin:oCheckin,members:oMembers,challenge:oChallenge}[tab]:{today:mToday,results:mResults,card:mCard}[tab];
  const ae=document.activeElement,foc=ae&&ae.id&&ae.tagName==='INPUT'&&ae.type!=='checkbox'?{id:ae.id,v:ae.value,s:ae.selectionStart,e:ae.selectionEnd}:null;
  const y=window.scrollY;$('#app').innerHTML=v();window.scrollTo(0,y);
  if(page&&SES.role==='owner'&&page!=='__profile'&&page!=='__club')renderPage();
  if(foc){const el=document.getElementById(foc.id);if(el&&el!==document.activeElement){el.value=foc.v;try{el.focus();el.setSelectionRange(foc.s,foc.e)}catch(_){}}}
}
$('#tabs').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;tab=b.dataset.tab;selMode=false;sel.clear();render();window.scrollTo(0,0)});
function head(title,sub,extra=''){const a=SES.role==='owner'?ownerAv():av(ME);return `<header class="ph"><div class="t"><p>${sub}</p><h1>${title}</h1></div>${extra}<button class="avbtn" data-act="account" aria-label="Tài khoản">${a}</button></header>`}
let toastT;function toast(t){clearTimeout(toastT);let el=$('#toast');if(!el){el=document.createElement('div');el.id='toast';el.className='toast';el.setAttribute('role','status');document.body.appendChild(el)}el.innerHTML=I.check+'<span>'+esc(t)+'</span>';el.hidden=false;toastT=setTimeout(()=>el.hidden=true,2400)}
const wrap=p=>Promise.resolve(p).catch(e=>{console.error(e);toast(/permission/i.test(e.code||e.message||'')?'Không có quyền thực hiện thao tác này':'Chưa lưu được, kiểm tra kết nối mạng');throw e});

/* ============ Charts ============ */
function lineChart(pts,unit,d){
  if(pts.length<2)return `<div class="empty-chart">${pts.length?'Cần thêm 1 lần đo để vẽ biểu đồ':'Chưa có lần đo nào'}</div>`;
  const W=330,H=168,p={l:38,r:14,t:24,b:24},ys=pts.map(q=>q.y),mx=Math.max(...ys),mn=Math.min(...ys),sp=Math.max(.5,mx-mn),top=mx+sp*.3,bot=mn-sp*.3;
  const X=i=>p.l+(W-p.l-p.r)*(i/(pts.length-1)),Y=v=>p.t+(H-p.t-p.b)*(1-(v-bot)/(top-bot));
  const ticks=[bot+(top-bot)*.15,(bot+top)/2,top-(top-bot)*.15];
  const line=pts.map((q,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(q.y).toFixed(1)).join(' ');
  const area=line+` L${X(pts.length-1).toFixed(1)} ${H-p.b} L${X(0).toFixed(1)} ${H-p.b} Z`,li=pts.length-1,gid='g'+Math.random().toString(36).slice(2,7);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Biểu đồ">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--brand-2)" stop-opacity=".22"/><stop offset="1" stop-color="var(--brand-2)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map(t=>`<line x1="${p.l}" x2="${W-p.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)" stroke-dasharray="2 4"/><text x="${p.l-8}" y="${Y(t)+4}" text-anchor="end">${fmt(t,d)}</text>`).join('')}
    <path d="${area}" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="var(--brand-2)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.map((q,i)=>`<circle cx="${X(i)}" cy="${Y(q.y)}" r="${i===li?5.5:3}" fill="${i===li?'var(--brand-2)':'var(--surface)'}" stroke="var(--brand-2)" stroke-width="2"/>`).join('')}
    <text x="${X(li)}" y="${Y(pts[li].y)-12}" text-anchor="end" style="fill:var(--ink);font-weight:700;font-size:12.5px">${fmt(pts[li].y,d)} ${unit}</text>
    <text x="${X(0)}" y="${H-6}" text-anchor="start">${dShort(pts[0].x)}</text><text x="${X(li)}" y="${H-6}" text-anchor="end">${dShort(pts[li].x)}</text></svg>`;
}
function ring(pct,size,color,label,sub,track='var(--sunk)',ink='var(--ink)',subc='var(--muted)'){
  const R=42,C=2*Math.PI*R;
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${label} ${sub||''}" style="flex:none"><circle cx="50" cy="50" r="${R}" fill="none" stroke="${track}" stroke-width="10"/>
    <circle cx="50" cy="50" r="${R}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(C*Math.max(.001,pct)/100).toFixed(1)} ${C}" transform="rotate(-90 50 50)"/>
    <text x="50" y="${sub?53:57}" text-anchor="middle" style="font-weight:800;font-size:${label.length>4?18:25}px;fill:${ink}">${label}</text>${sub?`<text x="50" y="68" text-anchor="middle" style="font-size:9.5px;fill:${subc};font-weight:600">${sub}</text>`:''}</svg>`;
}
function heatmap(m,days=28){
  const start=t0()-(days-1)*DAY,dow=(new Date(start).getDay()+6)%7;let cells='';
  for(let i=0;i<dow;i++)cells+='<i style="visibility:hidden"></i>';
  for(let i=0;i<days;i++){const k=keyOf(start+i*DAY+12*3600e3),s=score(m,k);cells+=`<i class="${s>=80?'l3':s>=40?'l2':s>0?'l1':''}${k===TODAY?' today':''}" title="${dShort(k)}: ${s} điểm">${+k.slice(8)}</i>`}
  const sw=c=>`<i style="display:inline-block;width:12px;height:12px;border-radius:4px;background:${c}"></i>`;
  return `<div class="heat-h"><span>T2</span><span>T3</span><span>T4</span><span>T5</span><span>T6</span><span>T7</span><span>CN</span></div><div class="heat">${cells}</div>
  <div class="legend" style="margin-top:10px"><span>${sw('var(--brand-2)')}Đủ thói quen</span><span>${sw('color-mix(in srgb,var(--brand-2) 55%,var(--sunk))')}Một phần</span><span>${sw('var(--sunk)')}Chưa ghi</span></div>`;
}
function hdots(m){const p=parts(m,TODAY);return `<div class="hdots">${HABITS.map(h=>`<span class="hd ${p[h.k]>=1?'full':p[h.k]>0?'part':''}" style="--hc:${h.c}" title="${h.n}">${h.ic}</span>`).join('')}</div>`}
const emptyCard=(icon,title,text,btn)=>`<section class="card empty"><span class="ic">${icon}</span><h2>${title}</h2><p class="muted">${text}</p>${btn||''}</section>`;

/* ============ OWNER: Overview ============ */
function oToday(){
  const act=activeMembers();
  if(!MEMBERS.length)return `<div class="stack">${head('Chào '+esc(CLUB.ownerName),dLong(TODAY))}
    ${emptyCard(I.users,'Thêm hội viên đầu tiên','Tạo hồ sơ cho từng hội viên, rồi gửi mã mời qua Zalo. Hội viên bấm link là vào app, không cần mật khẩu.',`<button class="btn btn-primary" data-act="newmember">${I.plus} Thêm hội viên</button>`)}
    ${pilotNote()}</div>`;
  const lg=act.filter(m=>logged(m)).length,full=act.filter(m=>score(m,TODAY)>=80).length,came=MEMBERS.filter(m=>att(m).includes(TODAY)).length,warnPk=MEMBERS.filter(m=>m.pkg&&pkgInfo(m).warn).length;
  const F={all:['Tất cả',()=>true],none:['Chưa ghi',m=>!logged(m)],water:['Thiếu nước',m=>parts(m,TODAY).water<1],meal:['Thiếu bữa',m=>parts(m,TODAY).meal<1],ex:['Chưa vận động',m=>parts(m,TODAY).ex<1]};
  const list=act.filter(F[filter][1]).sort((a,b)=>score(a,TODAY)-score(b,TODAY));
  const risk=act.filter(m=>daysBetween((m.consent&&m.consent.date)||TODAY,TODAY)>=3&&[1,2,3].every(a=>score(m,kAgo(a))<40));
  const reqs=MEMBERS.filter(m=>m.deleteRequested);
  const invited=MEMBERS.filter(m=>m.status!=='active').length;
  return `<div class="stack">
    ${head('Chào '+esc(CLUB.ownerName),dLong(TODAY))}
    ${reqs.length?`<div class="note warn"><span class="ic">${I.alert}</span><div><b>Yêu cầu xóa dữ liệu:</b> ${reqs.map(m=>esc(m.name)).join(', ')}. Mở hồ sơ để xóa trong vòng 20 ngày.</div></div>`:''}
    <section class="card sum">${ring(act.length?Math.round(100*lg/act.length):0,118,'var(--brand-2)',lg+'/'+act.length,'đã ghi')}
      <div class="kpis">
        <div class="kpi"><span class="ic" style="background:var(--brand-soft);color:var(--brand)">${I.check}</span><span class="kl">Đủ thói quen</span><b class="num">${full}</b></div>
        <button class="kpi" data-act="tab" data-v="checkin"><span class="ic" style="background:color-mix(in srgb,var(--h-water) 14%,transparent);color:var(--h-water)">${I.qr}</span><span class="kl">Đến club</span><b class="num">${came}</b></button>
        <button class="kpi ${warnPk?'warn':''}" data-act="mfilter" data-v="pkg"><span class="ic" style="background:var(--amber-soft);color:var(--amber)">${I.ticket}</span><span class="kl">Gói sắp hết</span><b class="num">${warnPk}</b></button>
      </div></section>
    ${invited?`<button class="note info" data-act="mfilter" data-v="invited" style="width:100%;text-align:left"><span class="ic">${I.link}</span><div><b>${invited} hội viên chưa vào app.</b> Mở danh sách để gửi mã mời.</div></button>`:''}
    ${risk.length?`<div class="sec"><h2>Cần quan tâm</h2></div><section class="card flush">${risk.map(m=>`<div class="li">${av(m)}<span class="grow"><b>${esc(m.name)}</b><small>Gần như không ghi thói quen 3 ngày qua</small></span><button class="btn btn-sm btn-zalo" data-act="remind1" data-id="${m.id}">Nhắn</button></div>`).join('')}</section>`:''}
    ${act.length?`<div class="sec"><h2>Thói quen hôm nay</h2><button class="link" data-act="selmode" style="font-size:.9rem">${selMode?'Hủy chọn':'Nhắc nhiều người'}</button></div>
    <div class="chips" role="group" aria-label="Lọc">${Object.entries(F).map(([k,[n,f]])=>`<button class="chip" data-act="filter" data-v="${k}" aria-pressed="${filter===k}">${n}<b>${act.filter(f).length}</b></button>`).join('')}</div>
    <section class="card flush">${list.length?list.map(m=>{const s=score(m,TODAY);return `<button class="li" data-act="${selMode?'sel':'open'}" data-id="${m.id}">${selMode?`<span class="selbox ${sel.has(m.id)?'on':''}">${sel.has(m.id)?I.check:''}</span>`:''}${av(m)}<span class="grow"><b>${esc(m.name)}</b>${hdots(m)}</span><span class="sc ${level(s)}"><b class="num">${s}</b><small>điểm</small></span></button>`}).join(''):'<p class="muted" style="padding:16px 18px">Không có ai trong mục này.</p>'}</section>
    <div class="legend" style="padding:0 2px">${HABITS.map(h=>`<span><span class="hd full" style="--hc:${h.c}">${h.ic}</span>${h.n}</span>`).join('')}</div>`:''}
    ${pilotNote()}
    ${selMode?`<div class="actionbar"><b>Đã chọn ${sel.size}</b><button class="btn btn-sm btn-ghost" data-act="selall">Chọn người chưa đủ</button><button class="btn btn-sm btn-zalo" data-act="remind" ${sel.size?'':'disabled style="opacity:.5"'}>Soạn tin</button></div>`:''}
  </div>`;
}
function pilotNote(){const left=CLUB.pilotEnd?daysBetween(TODAY,CLUB.pilotEnd):null;return `<p class="muted" style="font-size:.8rem;text-align:center;padding:4px 8px">Chạy thử đến ${dFull(CLUB.pilotEnd)}${left!=null?` (còn ${Math.max(0,left)} ngày)`:''} · Máy chủ Firebase, Singapore</p>`}

/* ============ OWNER: Check-in ============ */
function oCheckin(){
  const act=activeMembers(),came=act.filter(m=>att(m).includes(TODAY)),not=act.filter(m=>!att(m).includes(TODAY));
  const code=DAYC&&DAYC.date===TODAY?DAYC.code:'····';
  return `<div class="stack">
    ${head('Điểm danh',dLong(TODAY))}
    <section class="daycode"><div><div class="cap">Mã điểm danh hôm nay</div><span class="code num">${code}</span></div><p>Viết mã này lên bảng ở quầy. Hội viên mở app, chọn <b>Thẻ của tôi → Điểm danh</b> và nhập 4 số. Mã đổi mỗi ngày.</p></section>
    <div class="sec"><h2>Chưa đến <span class="muted num">${not.length}</span></h2></div>
    <section class="card flush">${not.map(m=>{const p=pkgInfo(m);return `<div class="li">${av(m)}<span class="grow"><b>${esc(m.name)}</b><small${p.warn?' style="color:var(--amber);font-weight:600"':''}>${esc(p.text)}</small></span><button class="btn btn-sm btn-soft" data-act="checkin" data-id="${m.id}">Điểm danh</button></div>`}).join('')||'<p class="muted" style="padding:16px 18px">Mọi người đã đến.</p>'}</section>
    <div class="sec"><h2>Đã đến <span class="muted num">${came.length}</span></h2></div>
    <section class="card flush">${came.map(m=>`<div class="li">${av(m)}<span class="grow"><b>${esc(m.name)}</b><small>${esc(pkgInfo(m).text)}</small></span><button class="btn btn-sm btn-ghost" data-act="uncheckin" data-id="${m.id}">Bỏ</button></div>`).join('')||'<p class="muted" style="padding:16px 18px">Chưa có ai.</p>'}</section>
  </div>`;
}

/* ============ OWNER: Members ============ */
function oMembers(){
  const F={all:['Tất cả',()=>true],pkg:['Sắp hết gói',m=>pkgInfo(m).warn],rare:['Ít đến club',m=>m.status==='active'&&att(m).filter(k=>daysBetween(k,TODAY)<7).length<2],invited:['Chưa vào app',m=>m.status!=='active']};
  const list=MEMBERS.filter(F[mfilter][1]).filter(m=>!q||String(m.name).toLowerCase().includes(q.toLowerCase()));
  return `<div class="stack">
    ${head('Hội viên',esc(CLUB.name),`<button class="btn btn-primary btn-sm" data-act="newmember" style="min-height:42px">${I.plus} Thêm</button>`)}
    ${MEMBERS.length?`<label class="search">${I.search}<input type="search" id="q" placeholder="Tìm theo tên" value="${esc(q)}" autocomplete="off"></label>
    <div class="chips">${Object.entries(F).map(([k,[n,f]])=>`<button class="chip" data-act="mf" data-v="${k}" aria-pressed="${mfilter===k}">${n}<b>${MEMBERS.filter(f).length}</b></button>`).join('')}</div>
    <section class="card flush">${list.map(m=>{const p=pkgInfo(m),ms=measures(m),d=ms.length>1?ms[ms.length-1].weight-ms[0].weight:null;
      return `<button class="li" data-act="open" data-id="${m.id}">${av(m)}<span class="grow"><b>${esc(m.name)}</b><small>${m.status!=='active'?'<span class="pill warn">Chưa vào app</span>':m.deleteRequested?'<span class="pill bad">Yêu cầu xóa dữ liệu</span>':`<span${p.warn?' style="color:var(--amber);font-weight:600"':''}>${esc(p.text)}</span>`}</small></span>
        ${ms.length?`<span style="text-align:right;flex:none"><b class="num" style="font-weight:700">${fmt(ms[ms.length-1].weight,1)}</b><small class="muted"> kg</small>${d!=null?`<br><span class="dl ${d<0?'good':d>0?'badd':'flat'} num" style="margin:0">${d>0?'+':''}${fmt(d,1)} kg</span>`:''}</span>`:''}<span class="chev">${I.next}</span></button>`}).join('')||'<p class="muted" style="padding:16px 18px">Không tìm thấy.</p>'}</section>`
    :emptyCard(I.users,'Chưa có hội viên','Bấm Thêm để tạo hồ sơ hội viên đầu tiên.','')}
  </div>`;
}
document.addEventListener('input',e=>{if(e.target.id==='q'){q=e.target.value;const pos=e.target.selectionStart;render();const i=$('#q');if(i){i.focus();i.setSelectionRange(pos,pos)}}});

/* ============ OWNER: Member page ============ */
function openMember(id){page=id;ptab='overview';renderPage();$('#page').scrollTop=0}
function renderPage(){
  const m=M(page);if(!m){closePage();return}
  const p=pkgInfo(m),ms=measures(m),last=ms[ms.length-1],first=ms[0],s=score(m,TODAY),mt=METRICS.find(x=>x.k===metric),consented=!!m.consent;
  let body='';
  if(ptab==='overview')body=`
    ${m.deleteRequested?`<div class="note warn"><span class="ic">${I.alert}</span><div><b>${esc(cap(m.call))} yêu cầu xóa dữ liệu.</b> Theo luật cần thực hiện trong 20 ngày. Kéo xuống dưới, chọn <b>Xóa hội viên</b>.</div></div>`:''}
    <section class="card stack" style="gap:12px"><div class="row between"><div><div class="cap">Gói hội viên</div><h2 style="margin-top:2px">${esc(p.label)}</h2></div><button class="btn btn-sm btn-soft" data-act="renew" data-id="${m.id}">Gia hạn</button></div>
      <div class="bar" style="--bc:${p.warn?'var(--amber)':'var(--brand-2)'};height:8px"><i style="width:${Math.round(p.pct*100)}%"></i></div>
      <p${p.warn?' style="color:var(--amber);font-weight:700"':' class="muted"'}>${esc(p.text)}</p></section>
    <section class="card flush">
      <div class="li"><span class="ic" style="background:var(--brand-soft);color:var(--brand)">${I.qr}</span><span class="grow"><b>Đến club</b><small>${att(m).filter(k=>daysBetween(k,TODAY)<7).length} lần trong 7 ngày${att(m).length?' · gần nhất '+dShort(att(m).slice().sort().pop()):''}</small></span></div>
      <div class="li"><span class="ic" style="background:var(--amber-soft);color:var(--amber)">${I.flame}</span><span class="grow"><b>Chuỗi thói quen</b><small>${streak(m)} ngày liên tục đạt 80 điểm trở lên</small></span></div>
      <div class="li"><span class="ic" style="background:color-mix(in srgb,var(--h-water) 14%,transparent);color:var(--h-water)">${I.calendar}</span><span class="grow"><b>Tham gia</b><small>Từ ${dShort(m.joined)}</small></span></div></section>
    <div class="sec"><h2>Tài khoản và dữ liệu</h2></div>
    <section class="card flush">
      <div class="li"><span class="ic" style="background:${consented?'var(--brand-soft)':'var(--red-soft)'};color:${consented?'var(--brand)':'var(--red)'}">${I.shield}</span><span class="grow"><b>Đồng ý lưu dữ liệu</b><small>${consented?'Đã đồng ý ngày '+dShort(m.consent.date):'Chưa đồng ý: chưa được nhập chỉ số'}</small></span></div>
      <button class="li" data-act="invite" data-id="${m.id}"><span class="ic" style="background:color-mix(in srgb,var(--zalo) 12%,transparent);color:var(--zalo)">${I.link}</span><span class="grow"><b>${m.status==='active'?'Gửi mã đăng nhập mới':'Gửi mã mời'}</b><small>${m.status==='active'?'Khi đổi điện thoại. Máy cũ sẽ bị đăng xuất.':'Mã dùng 1 lần, trong '+INVITE_HOURS+' giờ'}</small></span><span class="chev">${I.next}</span></button>
      ${m.status==='active'?`<button class="li" data-act="unbind" data-id="${m.id}"><span class="ic" style="background:var(--sunk);color:var(--ink2)">${I.logout}</span><span class="grow"><b>Đăng xuất khỏi điện thoại</b><small>Dùng khi hội viên mất máy hoặc đổi máy</small></span><span class="chev">${I.next}</span></button>`:''}
      <button class="li" data-act="delmember" data-id="${m.id}"><span class="ic" style="background:var(--red-soft);color:var(--red)">${I.trash}</span><span class="grow"><b style="color:var(--red)">Xóa hội viên</b><small>Xóa hồ sơ, thói quen, chỉ số và lịch sử điểm danh</small></span><span class="chev">${I.next}</span></button></section>`;
  if(ptab==='metrics')body=ms.length?`
    <div class="row between"><div><div class="cap">Lần đo gần nhất</div><h2 style="margin-top:2px">${dLong(last.date)}</h2></div></div>
    <section class="card stack" style="gap:6px"><div class="cap">${mt.n}</div>${lineChart(ms.filter(x=>x[mt.k]!=null).map(x=>({x:x.date,y:x[mt.k]})),mt.u,mt.d)}</section>
    <div class="mgrid">${METRICS.filter(x=>last[x.k]!=null).map(x=>{const dv=last[x.k]!=null&&first[x.k]!=null?last[x.k]-first[x.k]:null;return `<button class="mc" data-act="metric" data-v="${x.k}" aria-pressed="${metric===x.k}"><span>${x.n}</span><b class="num">${fmt(last[x.k],x.d)}<small> ${x.u}</small></b>${ms.length>1&&dv!=null?`<span class="dl ${Math.abs(dv)<.05||!x.good?'flat':dv*x.good>0?'good':'badd'} num" style="display:inline">${dv>0?'+':''}${fmt(dv,x.d)}</span>`:''}</button>`}).join('')}</div>
    <p class="muted" style="font-size:.82rem">Chênh lệch tính từ lần đo đầu tiên ngày ${dShort(first.date)}. Màu xanh là thay đổi tốt.</p>`
    :emptyCard(I.weigh,'Chưa có lần đo',consented?'Khi đo ở club, bấm Nhập lần đo và điền theo phiếu in từ cân.':'Hội viên cần vào app và đồng ý lưu dữ liệu trước khi nhập chỉ số.',consented?`<button class="btn btn-primary" data-act="measure" data-id="${m.id}">${I.plus} Nhập lần đo</button>`:'');
  if(ptab==='habits'){const h=hOf(m,TODAY),t=m.targets,meals=Object.values(h.meals||{}),pp=parts(m,TODAY);
    const rows=[['water',`${fmt((h.water||0)/1000,2)} / ${fmt(t.water/1000,1)} lít`],['meal',`${meals.length}/${t.meals} bữa${meals.length?' · '+meals.join(', '):''}`],['ex',`${h.ex||0}/${t.ex} phút${h.steps?' · '+fmt(h.steps)+' bước':''}`],['sleep',h.sleep?`${fmt(h.sleep,1)} / ${t.sleep} giờ`:'Chưa ghi'],['weigh',h.weigh?`${fmt(h.weigh,1)} kg`:'Chưa cân']];
    body=`<div class="row between"><div><div class="cap">Hôm nay</div><h2 style="margin-top:2px" class="num">${s} điểm</h2></div><button class="btn btn-sm btn-ghost" data-act="targets" data-id="${m.id}">${I.edit} Đặt mục tiêu</button></div>
    <section class="card flush">${rows.map(([k,txt])=>`<div class="li"><span class="ic" style="background:${pp[k]>=1?H(k).c:'color-mix(in srgb,'+H(k).c+' 14%,transparent)'};color:${pp[k]>=1?'var(--on-h)':H(k).c}">${H(k).ic}</span><span class="grow"><b>${H(k).n}</b><small>${esc(txt)}</small></span>${pp[k]>=1?`<span class="pill ok">${I.check} Đủ</span>`:''}</div>`).join('')}</section>
    <section class="card"><div class="cap" style="margin-bottom:10px">4 tuần gần nhất</div>${heatmap(m)}</section>`}
  $('#page').innerHTML=`<div class="in">
    <div class="navbar"><button class="iconbtn" data-act="closepage" aria-label="Quay lại">${I.back}</button><b class="grow" style="text-align:center">Hồ sơ hội viên</b><span style="width:42px"></span></div>
    <section class="card" style="display:flex;gap:16px;align-items:center">${av(m,'lg')}<div class="grow"><h1 style="font-size:1.4rem">${esc(m.name)}</h1><p class="muted">Xưng hô: ${esc(m.call)}</p>
      <div class="row wrapr" style="gap:6px;margin-top:8px">${m.status==='active'?'<span class="pill ok">Đang dùng app</span>':'<span class="pill warn">Chưa vào app</span>'}${m.status==='active'?`<span class="pill ${level(s)} num">${s} điểm hôm nay</span>`:''}</div></div>
      <button class="iconbtn" data-act="editmember" data-id="${m.id}" aria-label="Sửa tên">${I.edit}</button></section>
    <div class="row"><button class="btn btn-zalo grow" data-act="remind1" data-id="${m.id}" ${m.status==='active'?'':'disabled style="opacity:.5"'}>${I.send} Soạn tin nhắc</button><button class="btn btn-line grow" data-act="measure" data-id="${m.id}" ${consented?'':'disabled style="opacity:.5"'}>${I.plus} Nhập lần đo</button></div>
    <div class="seg" role="tablist">${[['overview','Tổng quan'],['metrics','Chỉ số'],['habits','Thói quen']].map(([k,n])=>`<button data-act="ptab" data-v="${k}" aria-pressed="${ptab===k}">${n}</button>`).join('')}</div>
    ${body}</div>`;
  $('#page').hidden=false;
}
function closePage(){page=null;$('#page').hidden=true;$('#page').innerHTML=''}

/* ============ OWNER: Challenge ============ */
function oChallenge(){
  const c=CLUB.challenge;
  if(!c)return `<div class="stack">${head('Thử thách',esc(CLUB.name))}${emptyCard(I.trophy,'Chưa có thử thách','Tạo thử thách 21 ngày: hội viên tích điểm thói quen mỗi ngày và xem bảng xếp hạng.',`<button class="btn btn-primary" data-act="newch">${I.plus} Tạo thử thách</button>`)}</div>`;
  const d=chDay(),ranked=c.ids.map(M).filter(Boolean).filter(m=>m.status==='active').map(m=>({m,p:chPoints(m),s:streak(m)})).sort((a,b)=>b.p-a.p);
  const ended=daysBetween(c.start,TODAY)>=c.days;
  return `<div class="stack">
    ${head('Thử thách',esc(CLUB.name),`<button class="btn btn-sm btn-line" data-act="newch" style="min-height:42px">${I.plus} Tạo mới</button>`)}
    <section class="chall"><div class="cap">${ended?'Đã kết thúc':'Đang diễn ra'} · ${ranked.length} người</div><h2>${esc(c.name)}</h2>
      <div class="row between"><b class="num" style="font-size:1.6rem;font-weight:800">Ngày ${d}<span style="opacity:.7;font-weight:600">/${c.days}</span></b><span style="opacity:.85">${ended?'Kết thúc '+dShort(addDays(c.start,c.days-1)):'Còn '+(c.days-d)+' ngày'}</span></div>
      <span class="cbar"><i style="width:${Math.round(100*d/c.days)}%"></i></span>
      <p style="font-size:.86rem;opacity:.85">Điểm là tổng điểm thói quen mỗi ngày, tối đa 100 điểm/ngày. Hội viên thấy bảng này bằng biệt danh.</p></section>
    <div class="sec"><h2>Bảng xếp hạng</h2></div>
    <section class="card flush">${ranked.map((r,i)=>`<button class="li" data-act="open" data-id="${r.m.id}"><span class="rk r${i+1}">${i+1}</span>${av(r.m,'sm')}<span class="grow"><b>${esc(r.m.name)}</b><small>${r.s?`<span class="streak">${I.flame} ${r.s} ngày liên tục</span>`:'Chưa có chuỗi'}</small></span><span class="pts num">${fmt(r.p)}</span></button>`).join('')||'<p class="muted" style="padding:16px 18px">Chưa có ai tham gia.</p>'}</section>
  </div>`;
}

/* ============ MEMBER ============ */
function mToday(){
  const m=ME,h=hOf(m,TODAY),t=m.targets,p=parts(m,TODAY),s=score(m,TODAY),st=streak(m);
  const gl=Math.round(t.water/250),had=Math.round((h.water||0)/250),doneN=Object.values(p).filter(v=>v>=1).length;
  const hh=(k,txt)=>`<div class="hh"><span class="ic">${H(k).ic}</span><div class="grow"><h2>${H(k).n}</h2><p>${txt}</p></div><span class="okmark ${p[k]>=1?'on':''}" role="img" aria-label="${p[k]>=1?'Đã xong':'Chưa xong'}">${p[k]>=1?I.check:''}</span></div>`;
  return `<div class="stack" style="gap:16px">
    ${head('Chào '+esc(m.call),dLong(TODAY))}
    <section class="mhero">${ring(s,108,'#FFFFFF',String(s),'điểm','rgba(255,255,255,.22)','#fff','rgba(255,255,255,.8)')}
      <div><h2>Xong ${doneN}/5 việc</h2><p>${s>=80?'Tuyệt vời, giữ vững nhé!':doneN?'Làm tiếp các việc còn lại nhé.':'Bắt đầu ngày mới thôi!'}</p>${st?`<span class="streak">${I.flame} ${st} ngày liên tục</span>`:''}</div></section>
    <section class="hcard" style="--hc:var(--h-water)">${hh('water',`Đã uống <b class="num">${had}</b> / ${gl} ly`)}
      <div class="glasses" aria-hidden="true">${Array.from({length:gl},(_,i)=>`<span class="glass${i<had?' on':''}"></span>`).join('')}</div>
      <div class="two"><button class="bb minor" data-act="water" data-v="-250">Bớt 1 ly</button><button class="bb main" data-act="water" data-v="250">${I.plus} Thêm 1 ly</button></div>
      <p class="muted" style="font-size:.9rem;margin-top:-4px">1 ly = 250 ml</p></section>
    <section class="hcard" style="--hc:var(--h-meal)">${hh('meal',`Đã ăn <b class="num">${Object.keys(h.meals||{}).length}</b> / ${t.meals} bữa`)}
      <div>${SLOTS.map(sl=>{const v=(h.meals||{})[sl.k];return `<button class="meal${v?' on':''}" data-act="meal" data-v="${sl.k}"><span class="ck">${v?I.check:''}</span><span class="ml">${sl.n}<small>${v?esc(v):'Chạm để ghi'}</small></span><span class="go">${v?'Sửa':'Ghi'}</span></button>`}).join('')}</div></section>
    <section class="hcard" style="--hc:var(--h-ex)">${hh('ex',`Đã vận động <b class="num">${h.ex||0}</b> / ${t.ex} phút`)}<div class="hprog"><i style="width:${Math.round(p.ex*100)}%"></i></div>
      <div class="three"><button class="bb main" data-act="ex" data-v="10">+10 phút</button><button class="bb main" data-act="ex" data-v="20">+20 phút</button><button class="bb minor" data-act="ex" data-v="-10">Bớt 10</button></div>
      <div><label for="steps" class="muted" style="font-size:.95rem">Số bước chân (nếu có)</label><div class="bigin" style="margin-top:6px"><input id="steps" inputmode="numeric" placeholder="Ví dụ 5000" value="${h.steps||''}"><button class="btn btn-ghost" data-act="steps">Lưu</button></div></div></section>
    <section class="hcard" style="--hc:var(--h-sleep)">${hh('sleep','Đêm qua ngủ được bao lâu?')}
      <div class="stepper"><button data-act="sleep" data-v="-0.5" aria-label="Bớt nửa giờ">−</button><output class="num">${h.sleep?fmt(h.sleep,1):'–'}<small>giờ · mục tiêu ${t.sleep} giờ</small></output><button data-act="sleep" data-v="0.5" aria-label="Thêm nửa giờ">+</button></div></section>
    <section class="hcard" style="--hc:var(--h-weigh)">${hh('weigh',h.weigh?`Sáng nay: <b class="num">${fmt(h.weigh,1)} kg</b>`:'Cân lúc mới dậy, trước khi ăn')}
      <div class="bigin"><input id="weigh" inputmode="decimal" placeholder="Ví dụ 65,5" value="${h.weigh?String(h.weigh).replace('.',','):''}" aria-label="Cân nặng (kg)"><button class="btn btn-primary" data-act="weigh">Lưu kg</button></div></section>
  </div>`;
}
function mResults(){
  const m=ME,ms=measures(m),last=ms[ms.length-1],first=ms[0],key=['weight','fat','waist'];
  const c=CLUB.challenge,board=(CLUB.board||[]),myRank=board.findIndex(r=>r.id===m.id)+1;
  return `<div class="stack" style="gap:16px">
    ${head('Kết quả',last?'Đo ở club ngày '+dShort(last.date):esc(CLUB.name))}
    ${c&&myRank?`<section class="chall"><div class="cap">${esc(c.name)}</div><div class="row between"><h2>Hạng ${myRank}/${board.length}</h2><b class="num" style="font-size:1.2rem">${fmt(board[myRank-1].pts)} điểm</b></div><span class="cbar"><i style="width:${Math.round(100*chDay()/c.days)}%"></i></span><p style="opacity:.85">Ngày ${chDay()}/${c.days}</p></section>`:''}
    ${ms.length?key.map(k=>{const x=METRICS.find(y=>y.k===k);if(last[k]==null)return '';const dv=ms.length>1&&first[k]!=null?last[k]-first[k]:null,good=dv!=null&&dv*x.good>0;return `<section class="card stack" style="gap:8px">
      <div class="row between" style="align-items:flex-end"><div><div class="cap">${x.n}</div><b class="num" style="font-size:2.3rem;font-weight:800;line-height:1.1;letter-spacing:-.02em">${fmt(last[k],x.d)} <small style="font-size:1rem;color:var(--muted);font-weight:600">${x.u}</small></b></div>
        ${dv!=null?`<span class="pill ${Math.abs(dv)<.05||!x.good?'mute':good?'ok':'bad'}" style="font-size:.92rem;padding:6px 12px">${dv>0?'Tăng':'Giảm'} ${fmt(Math.abs(dv),x.d)} ${x.u}</span>`:''}</div>
      ${lineChart(ms.filter(y=>y[k]!=null).map(y=>({x:y.date,y:y[k]})),x.u,x.d)}</section>`}).join('')+`
    <div class="sec"><h2>Các chỉ số khác</h2></div>
    <div class="mgrid">${METRICS.filter(x=>!key.includes(x.k)&&last[x.k]!=null).map(x=>`<div class="mc" style="background:var(--surface);box-shadow:var(--sh),inset 0 0 0 1px var(--card-bd)"><span>${x.n}</span><b class="num">${fmt(last[x.k],x.d)}<small> ${x.u}</small></b></div>`).join('')}</div>`
    :emptyCard(I.weigh,'Chưa có lần đo','Khi bạn đo ở club, chủ club sẽ nhập kết quả. Biểu đồ sẽ hiện ở đây.','')}
    <div class="sec"><h2>Thói quen 4 tuần qua</h2></div><section class="card">${heatmap(m)}</section>
    ${c&&board.length?`<div class="sec"><h2>Top 5 thử thách</h2></div><section class="card flush">${board.slice(0,5).map((r,i)=>`<div class="li${r.id===m.id?' me':''}"><span class="rk r${i+1}">${i+1}</span><span class="av sm" style="background:${r.color||'#13803F'}">${esc((r.name||'?').charAt(0))}</span><span class="grow"><b>${r.id===m.id?'Bạn':esc(cap(r.call))}</b></span><span class="pts num">${fmt(r.pts)}</span></div>`).join('')}${myRank>5?`<div class="li me"><span class="rk">${myRank}</span>${av(m,'sm')}<span class="grow"><b>Bạn</b></span><span class="pts num">${fmt(board[myRank-1].pts)}</span></div>`:''}</section>`:''}
  </div>`;
}
function mCard(){
  const m=ME,p=pkgInfo(m),here=att(m).includes(TODAY),list=att(m).slice().sort().reverse().slice(0,6);
  return `<div class="stack" style="gap:16px">
    ${head('Thẻ của tôi',esc(CLUB.name))}
    <section class="pkgc"><div class="row between"><div class="cap">Gói hội viên</div><span style="opacity:.85;font-weight:600">${esc(p.label)}</span></div>
      ${p.left!=null?`<div class="big num">${p.left}<small> buổi còn lại</small></div>`:p.leftDays!=null?`<div class="big num">${Math.max(0,p.leftDays)}<small> ngày còn lại</small></div>`:''}
      <span class="cbar"><i style="width:${Math.round(p.pct*100)}%"></i></span><p style="opacity:.9">${esc(p.text)}</p></section>
    ${p.warn?`<div class="note warn"><span class="ic">${I.alert}</span><div>Gói sắp hết. Hỏi chủ club để gia hạn nhé.</div></div>`:''}
    ${here?`<div class="note info" style="font-size:1.05rem"><span class="ic">${I.check}</span><div><b>Hôm nay bạn đã điểm danh.</b><br>Cảm ơn bạn đã đến club!</div></div>`:`<button class="btn btn-primary btn-xl btn-block" data-act="mcheckin">${I.qr} Điểm danh hôm nay</button>`}
    <div class="sec"><h2>Lần đến club gần đây</h2></div>
    <section class="card flush">${list.map(k=>`<div class="li" style="min-height:56px"><span class="grow"><b style="font-weight:500">${dLong(k)}</b></span><span class="pill ok">${I.check} Có mặt</span></div>`).join('')||'<p class="muted" style="padding:16px 18px">Chưa có lần nào.</p>'}</section>
  </div>`;
}

/* ============ Sheets ============ */
function openSheet(html){$('#scrim').innerHTML=`<div class="sheet" role="dialog" aria-modal="true"><span class="grab"></span>${html}</div>`;$('#scrim').hidden=false}
function closeSheet(){$('#scrim').hidden=true;$('#scrim').innerHTML=''}
$('#scrim').addEventListener('click',e=>{if(e.target.id==='scrim')closeSheet()});

function sheetAccount(){
  if(SES.role==='owner')openSheet(`<div class="row" style="gap:16px">${ownerAv('lg')}<div class="grow"><h2 style="font-size:1.3rem">${esc(CLUB.ownerFull||CLUB.ownerName)}</h2><p class="muted">Chủ club · ${esc(CLUB.name)}</p><p class="muted" style="font-size:.85rem">${esc(SES.email||'')}</p></div></div>
    <section class="card flush">
      <button class="li" data-act="profile"><span class="ic" style="background:var(--brand-soft);color:var(--brand)">${I.user}</span><span class="grow"><b>Thông tin cá nhân</b><small>Họ tên, tên hiển thị</small></span><span class="chev">${I.next}</span></button>
      <button class="li" data-act="clubinfo"><span class="ic" style="background:color-mix(in srgb,var(--h-water) 14%,transparent);color:var(--h-water)">${I.store}</span><span class="grow"><b>Thông tin club</b><small>Tên, địa chỉ, ngày kết thúc chạy thử</small></span><span class="chev">${I.next}</span></button>
      <button class="li" data-act="changepass"><span class="ic" style="background:var(--sunk)">${I.key}</span><span class="grow"><b>Đổi mật khẩu</b><small>Gửi link đổi mật khẩu về email</small></span><span class="chev">${I.next}</span></button>
      <button class="li" data-act="endpilot"><span class="ic" style="background:var(--red-soft);color:var(--red)">${I.trash}</span><span class="grow"><b style="color:var(--red)">Kết thúc chạy thử</b><small>Xóa toàn bộ dữ liệu club khỏi máy chủ</small></span><span class="chev">${I.next}</span></button></section>
    <button class="btn btn-danger btn-block" data-act="logout">${I.logout} Đăng xuất</button>
    ${B.mode==='local'?'<p class="muted" style="font-size:.8rem;text-align:center">Chế độ thử trên máy: dữ liệu chỉ nằm trên trình duyệt này.</p>':''}`);
  else{const m=ME;openSheet(`<div class="row" style="gap:16px">${av(m,'lg')}<div class="grow"><h2 style="font-size:1.35rem">${esc(m.name)}</h2><p class="muted">Hội viên · ${esc(CLUB.name)}</p></div></div>
    <section class="card flush">
      <div class="li"><span class="ic" style="background:var(--sunk)">${I.store}</span><span class="grow"><b>${esc(CLUB.name)}</b><small>${esc(CLUB.address||'')}${CLUB.hours?'<br>Mở cửa '+esc(CLUB.hours):''}</small></span></div>
      <div class="li"><span class="ic" style="background:var(--brand-soft);color:var(--brand)">${I.shield}</span><span class="grow"><b>Dữ liệu của tôi</b><small>Đã đồng ý ngày ${m.consent?dShort(m.consent.date):'–'}. Lưu trên máy chủ Firebase ở Singapore, xóa khi kết thúc chạy thử (${dFull(CLUB.pilotEnd)}).</small></span></div>
      ${m.deleteRequested?`<div class="li"><span class="ic" style="background:var(--amber-soft);color:var(--amber)">${I.trash}</span><span class="grow"><b>Đã gửi yêu cầu xóa dữ liệu</b><small>Chủ club sẽ xóa trong vòng 20 ngày</small></span></div>`:`<button class="li" data-act="reqdelete"><span class="ic" style="background:var(--red-soft);color:var(--red)">${I.trash}</span><span class="grow"><b style="color:var(--red)">Yêu cầu xóa dữ liệu của tôi</b><small>Chủ club sẽ xóa trong vòng 20 ngày</small></span><span class="chev">${I.next}</span></button>`}</section>
    <button class="btn btn-danger btn-xl btn-block" data-act="logout">${I.logout} Đăng xuất</button>
    <p class="muted" style="font-size:.88rem;text-align:center">Đăng xuất rồi thì cần mã mới từ chủ club để vào lại.</p>`)}
}
function openProfile(keep){
  page='__profile';const c=CLUB;
  $('#page').innerHTML=`<div class="in">
    <div class="navbar"><button class="iconbtn" data-act="closepage" aria-label="Quay lại">${I.back}</button><b class="grow" style="text-align:center">Thông tin cá nhân</b><span style="width:42px"></span></div>
    <section class="card stack" style="gap:14px">
      <div class="field"><label for="p-full">Họ và tên</label><input id="p-full" value="${esc(c.ownerFull||'')}" autocomplete="name"></div>
      <div class="field"><label for="p-name">Tên hiển thị với hội viên</label><input id="p-name" value="${esc(c.ownerName||'')}"><span class="muted" style="font-size:.8rem">Dùng trong lời chào và cuối tin nhắn nhắc hội viên.</span></div>
      <div class="field"><label>Email đăng nhập</label><input value="${esc(SES.email||'')}" readonly style="color:var(--muted)"></div>
      <div class="err" id="p-err" aria-live="polite"></div>
      <button class="btn btn-primary btn-block" data-act="saveprofile">Lưu thay đổi</button></section></div>`;
  $('#page').hidden=false;if(!keep)$('#page').scrollTop=0;
}
function openClub(keep){
  page='__club';const c=CLUB;
  $('#page').innerHTML=`<div class="in">
    <div class="navbar"><button class="iconbtn" data-act="closepage" aria-label="Quay lại">${I.back}</button><b class="grow" style="text-align:center">Thông tin club</b><span style="width:42px"></span></div>
    <section class="card stack" style="gap:14px">
      <div class="field"><label for="c-cname">Tên club</label><input id="c-cname" value="${esc(c.name)}"></div>
      <div class="field"><label for="c-addr">Địa chỉ</label><input id="c-addr" value="${esc(c.address||'')}"></div>
      <div class="field"><label for="c-hours">Giờ mở cửa</label><input id="c-hours" value="${esc(c.hours||'')}"></div>
      <div class="field"><label for="c-end">Ngày kết thúc chạy thử</label><input id="c-end" type="date" value="${esc(c.pilotEnd||'')}"><span class="muted" style="font-size:.8rem">Hội viên thấy ngày này trong màn hình đồng ý. Đến hạn, hãy xóa dữ liệu hoặc chuyển sang máy chủ chính thức.</span></div>
      <div class="err" id="c-err" aria-live="polite"></div>
      <button class="btn btn-primary btn-block" data-act="saveclub">Lưu thay đổi</button></section></div>`;
  $('#page').hidden=false;if(!keep)$('#page').scrollTop=0;
}
function remindMsg(m){
  const miss=missing(m),st=streak(m);
  if(!miss.length)return `Chào ${m.call}, hôm nay ${m.call} đã hoàn thành đủ thói quen rồi. Tuyệt vời lắm!\n— ${CLUB.ownerName}, ${CLUB.name}`;
  return `Chào ${m.call}, hôm nay mình còn thiếu: ${miss.join('; ')}.\nCố gắng hoàn thành ${st?'để giữ chuỗi '+st+' ngày ':''}nhé! Ghi lại trên app Nhịp Xanh giúp em nha.\n— ${CLUB.ownerName}, ${CLUB.name}`;
}
function sheetRemind(ids){
  const ms=ids.map(M).filter(Boolean);let i=0;if(!ms.length)return;
  const draw=()=>{const m=ms[i];openSheet(`<div class="row between"><h2>Soạn tin nhắc</h2><span class="muted num">${i+1}/${ms.length}</span></div>
    <div class="row">${av(m)}<div class="grow"><b>${esc(m.name)}</b></div></div>
    <div class="msg" id="msgtext">${esc(remindMsg(m))}</div>
    <button class="btn btn-primary btn-block" data-act="copymsg">${I.copy} Sao chép, rồi dán vào Zalo</button>
    <div class="row">${i>0?'<button class="btn btn-ghost grow" data-act="rprev">Người trước</button>':''}${i<ms.length-1?'<button class="btn btn-line grow" data-act="rnext">Người tiếp theo</button>':'<button class="btn btn-line grow" data-act="closesheet">Xong</button>'}</div>`)};
  sheetRemind.next=()=>{if(i<ms.length-1){i++;draw()}};sheetRemind.prev=()=>{if(i>0){i--;draw()}};draw();
}
function sheetMeal(slot){
  const cur=hOf(ME,TODAY).meals?.[slot],sl=SLOTS.find(s=>s.k===slot);
  openSheet(`<h2 style="font-size:1.45rem">${sl.n}: bạn đã ăn gì?</h2>
    <div class="optgrid">${FOODS.map(f=>`<button class="opt" data-act="food" data-slot="${slot}" data-v="${esc(f)}" aria-pressed="${cur===f}">${f}</button>`).join('')}</div>
    ${cur?`<button class="btn btn-line btn-xl btn-block" data-act="food" data-slot="${slot}" data-v="">Bỏ đánh dấu</button>`:''}
    <button class="btn btn-ghost btn-xl btn-block" data-act="closesheet">Đóng</button>`);
}
function sheetMeasure(m){
  const l=measures(m).pop()||(hOf(m,TODAY).weigh?{weight:hOf(m,TODAY).weigh}:{});
  openSheet(`<div><h2>Nhập lần đo</h2><p class="muted">${esc(m.name)} · ${dLong(TODAY)}. Ô nào không đo thì để trống.</p></div>
    <div class="fgrid">${METRICS.filter(x=>!x.calc).map(x=>`<div class="field"><label for="f-${x.k}">${x.n}${x.u?' ('+x.u+')':''}</label><input id="f-${x.k}" inputmode="decimal" value="${l[x.k]!=null?String(l[x.k]).replace('.',','):''}" placeholder="${x.k==='weight'?'Bắt buộc':x.k==='height'?'Ví dụ 158':''}"></div>`).join('')}</div>
    <div class="err" id="f-err" aria-live="polite"></div>
    <div class="row"><button class="btn btn-ghost grow" data-act="closesheet">Hủy</button><button class="btn btn-primary grow" data-act="savemeasure" data-id="${m.id}">Lưu lần đo</button></div>`);
}
function sheetTargets(m){
  const t={...m.targets},rows=[['water','Uống nước','ml',250,1000,4000],['meals','Số bữa','bữa',1,2,5],['ex','Vận động','phút',5,10,120],['sleep','Giấc ngủ','giờ',.5,5,10]],hk={water:'water',meals:'meal',ex:'ex',sleep:'sleep'};
  sheetTargets.t=t;sheetTargets.m=m;sheetTargets.rows=rows;
  const draw=()=>openSheet(`<div><h2>Mục tiêu của ${esc(m.call)}</h2><p class="muted">Đặt riêng từng người. Hội viên thấy ngay trên app.</p></div>
    <section class="card" style="padding:4px 16px">${rows.map(([k,n,u,st])=>`<div class="tgt"><span class="ic" style="background:${H(hk[k]).c};color:var(--on-h)">${H(hk[k]).ic}</span><b>${n}</b><button data-act="tg" data-k="${k}" data-v="${-st}" aria-label="Giảm">−</button><output class="num">${fmt(t[k],k==='sleep'?1:0)} ${u}</output><button data-act="tg" data-k="${k}" data-v="${st}" aria-label="Tăng">+</button></div>`).join('')}</section>
    <div class="row"><button class="btn btn-ghost grow" data-act="closesheet">Hủy</button><button class="btn btn-primary grow" data-act="savetargets">Lưu mục tiêu</button></div>`);
  sheetTargets.draw=draw;draw();
}
function sheetRenew(m){
  openSheet(`<div><h2>Gói cho ${esc(m.call)}</h2><p class="muted">Gói mới bắt đầu từ hôm nay.</p></div>
    <section class="card flush">${PACKS.map((p,i)=>`<button class="li" data-act="dorenew" data-id="${m.id}" data-v="${i}"><span class="ic" style="background:var(--brand-soft);color:var(--brand)">${I.ticket}</span><span class="grow"><b>${p.name}</b><small>${p.kind==='sessions'?p.total+' buổi, không giới hạn ngày':p.kind==='time'?p.days+' ngày, không giới hạn buổi':p.total+' buổi, dùng trong '+p.days+' ngày'}</small></span><span class="chev">${I.next}</span></button>`).join('')}</section>
    <button class="btn btn-ghost btn-block" data-act="closesheet">Hủy</button>`);
}
const mkPkg=(p,start)=>({kind:p.kind,name:p.name,total:p.total||null,start,end:p.days?addDays(start,p.days):null});
function appUrl(){return location.href.split('?')[0].split('#')[0]}
async function sheetInvite(m){
  openSheet('<div class="loading"><span class="spin"></span>Đang tạo mã…</div>');
  try{
    if(m.inviteToken)B.deleteInvite(m.inviteToken);
    const tk=await B.createInvite(SES.clubId,m.id,{memberCall:m.call,clubName:CLUB.name,pilotEnd:CLUB.pilotEnd||null,expiresAt:Date.now()+INVITE_HOURS*3600e3});
    await B.updateMember(SES.clubId,m.id,{inviteToken:tk,uid:null});
    const link=`${appUrl()}?ma=${tk}`;
    const msg=`Chào ${m.call}, ${CLUB.name} mời ${m.call} dùng app Nhịp Xanh để ghi thói quen mỗi ngày.\n\nBấm vào link này để vào app (chỉ dành riêng cho ${m.call}, dùng 1 lần trong ${INVITE_HOURS} giờ):\n${link}\n\nNếu link mở trong Zalo, bấm dấu ⋯ góc trên rồi chọn "Mở bằng trình duyệt".\nNếu app hỏi mã, nhập: ${fmtCode(tk)}\n— ${CLUB.ownerName}`;
    openSheet(`<h2>Mã cho ${esc(m.call)}</h2>
      <div class="bigcode num">${fmtCode(tk)}</div>
      <div class="note info"><span class="ic">${I.shield}</span><div>Gửi <b>riêng</b> cho ${esc(m.call)}, không gửi vào nhóm chung. Mã <b>chỉ dùng được 1 lần</b>, trong <b>${INVITE_HOURS} giờ</b>.${m.status==='active'?' Điện thoại cũ của '+esc(m.call)+' đã bị đăng xuất.':''}</div></div>
      <div class="msg">${esc(msg)}</div>
      <button class="btn btn-primary btn-block" data-act="copytext" data-t="${esc(msg)}">${I.copy} Sao chép tin nhắn, rồi dán vào Zalo</button>
      <button class="btn btn-ghost btn-block" data-act="closesheet">Xong</button>`);
  }catch(e){console.error(e);closeSheet();toast('Chưa tạo được mã, kiểm tra kết nối mạng')}
}
function sheetMember(m){
  const isNew=!m;m=m||{name:'',call:'chị'};
  const calls=['anh','chị','cô','chú','bác','em'],cw=(m.call||'chị').split(' ')[0];
  openSheet(`<h2>${isNew?'Thêm hội viên':'Sửa thông tin'}</h2>
    <div class="note info"><span class="ic">${I.shield}</span><div>Chỉ cần <b>tên gọi hoặc biệt danh</b>. Không nhập số điện thoại, không tải ảnh, để giảm dữ liệu cá nhân trong thời gian chạy thử.</div></div>
    <div class="fgrid"><div class="field"><label for="n-call">Xưng hô</label><select id="n-call">${calls.map(c=>`<option${c===cw?' selected':''}>${c}</option>`).join('')}</select></div>
    <div class="field"><label for="n-name">Tên gọi / biệt danh</label><input id="n-name" placeholder="Ví dụ Lan, Hùng béo" value="${esc(m.name)}" autocomplete="off"></div></div>
    ${isNew?`<div class="field"><label for="n-pack">Gói</label><select id="n-pack">${PACKS.map((p,i)=>`<option value="${i}">${p.name}</option>`).join('')}<option value="-1">Chưa có gói</option></select></div>`:''}
    <div id="n-err" class="err" aria-live="polite"></div>
    <div class="row"><button class="btn btn-ghost grow" data-act="closesheet">Hủy</button><button class="btn btn-primary grow" data-act="savemember" data-id="${isNew?'':m.id}">${isNew?'Lưu và tạo mã mời':'Lưu'}</button></div>`);
}
function sheetNewCh(){
  openSheet(`<h2>Tạo thử thách mới</h2>
    <div class="field"><label for="c-name">Tên thử thách</label><input id="c-name" value="Thử thách 21 ngày Khỏe Đẹp"></div>
    <div class="field"><label for="c-days">Số ngày</label><select id="c-days"><option>7</option><option>14</option><option selected>21</option><option>30</option></select></div>
    <p class="muted" style="font-size:.86rem">Mời tất cả hội viên đang dùng app. Thử thách hiện tại (nếu có) sẽ kết thúc.</p>
    <div class="row"><button class="btn btn-ghost grow" data-act="closesheet">Hủy</button><button class="btn btn-primary grow" data-act="savech">Bắt đầu hôm nay</button></div>`);
}
function sheetCheckinCode(){
  openSheet(`<h2 style="font-size:1.45rem">Điểm danh hôm nay</h2><p style="font-size:1.05rem">Nhập <b>4 số</b> viết trên bảng ở quầy club.</p>
    <div class="otp otp4" id="cc">${[0,1,2,3].map(i=>`<input inputmode="numeric" maxlength="1" aria-label="Số thứ ${i+1}">`).join('')}</div>
    <div class="err" id="cc-err" aria-live="polite"></div>
    <button class="btn btn-primary btn-xl btn-block" data-act="mcheckin-ok">Xác nhận</button>
    <button class="btn btn-ghost btn-xl btn-block" data-act="closesheet">Đóng</button>`);
  setupDigits('#cc');
}
function sheetConfirm(title,text,btn,act,id,danger,extra=''){openSheet(`<h2>${title}</h2><p class="muted">${text}</p>${extra}<div class="err" id="cf-err" aria-live="polite"></div><div class="row"><button class="btn btn-ghost grow" data-act="closesheet">Hủy</button><button class="btn ${danger?'btn-danger':'btn-primary'} grow" data-act="${act}" data-id="${id||''}">${btn}</button></div>`)}
function setupDigits(sel){
  const ins=[...document.querySelectorAll(sel+' input')];try{ins[0].focus()}catch(_){}
  ins.forEach((el,i)=>{el.addEventListener('input',()=>{el.value=el.value.replace(/[^0-9A-Za-z]/g,'').slice(-1).toUpperCase();if(el.value&&ins[i+1])ins[i+1].focus()});
    el.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!el.value&&ins[i-1])ins[i-1].focus()});
    el.addEventListener('paste',e=>{const t=(e.clipboardData.getData('text')||'').replace(/[^0-9A-Za-z]/g,'').toUpperCase();if(t.length>=ins.length){e.preventDefault();ins.forEach((x,j)=>x.value=t[j])}})});
}

/* ============ AUTH ============ */
const authErr=e=>{const c=(e&&(e.code||e.message))||'';
  if(/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c))return 'Email hoặc mật khẩu chưa đúng.';
  if(/email-already-in-use/.test(c))return 'Email này đã có tài khoản. Hãy đăng nhập.';
  if(/weak-password/.test(c))return 'Mật khẩu quá yếu, cần ít nhất 8 ký tự có cả chữ và số.';
  if(/invalid-email/.test(c))return 'Email chưa đúng định dạng.';
  if(/too-many-requests/.test(c))return 'Thử sai nhiều lần. Đợi vài phút rồi thử lại.';
  if(/network/.test(c))return 'Không có mạng. Kiểm tra kết nối rồi thử lại.';
  if(/operation-not-allowed|admin-restricted/.test(c))return 'Chưa bật cách đăng nhập này trong Firebase (xem hướng dẫn cài đặt).';
  if(/permission/.test(c))return 'Mã đã hết hạn hoặc không đúng. Xin chủ club gửi mã mới.';
  return 'Có lỗi xảy ra. Thử lại sau.'};
function renderAuthMsg(t){authStep={s:'welcome',err:t};render()}
function renderAuth(){
  const a=$('#auth');a.hidden=false;document.body.classList.remove('big');
  const s=authStep.s,top=(h,p)=>`<div class="auth-top"><div class="in"><div class="brandmark"><span class="lg">${I.leaf}</span><b>Nhịp Xanh</b></div>${h?`<h1>${h}</h1>`:''}${p?`<p>${p}</p>`:''}</div></div>`;
  const back=(act='authback')=>`<button class="btn btn-ghost btn-sm" data-act="${act}" style="align-self:flex-start">${I.back} Quay lại</button>`;
  const su=authStep.su||{};let html='';
  if(s==='welcome')html=top('Chào mừng bạn','Ghi thói quen mỗi ngày và theo dõi tiến độ cùng club của bạn.')+`<div class="auth-body"><div class="in">
    <section class="auth-card"><div><h2 style="font-size:1.3rem">Hội viên</h2><p class="muted" style="margin-top:4px">Nhập mã 8 ký tự chủ club gửi qua Zalo.</p></div>
      <div class="otp otp8" id="code">${[0,1,2,3,4,5,6,7].map(i=>`${i===4?'<span class="dash">–</span>':''}<input maxlength="1" autocapitalize="characters" autocomplete="off" aria-label="Ký tự ${i+1}">`).join('')}</div>
      <div class="err" id="a-err" aria-live="polite">${esc(authStep.err||'')}</div>
      <button class="btn btn-primary btn-xl btn-block" data-act="a-code">Vào app</button></section>
    <section class="auth-card"><div><h2 style="font-size:1.15rem">Chủ club</h2></div>
      <div class="field"><label for="o-email">Email</label><input id="o-email" type="email" inputmode="email" autocomplete="email" value="${esc(authStep.email||'')}"></div>
      <div class="field"><label for="o-pass">Mật khẩu</label><input id="o-pass" type="password" autocomplete="current-password"></div>
      <div class="err" id="o-err" aria-live="polite"></div>
      <button class="btn btn-line btn-block" data-act="o-login">Đăng nhập</button>
      <div class="row between" style="font-size:.9rem"><button class="link" data-act="o-forgot">Quên mật khẩu?</button><button class="link" data-act="su-start">Tạo club mới</button></div></section>
    ${B.mode==='local'?`<section class="demo"><span class="tag">CHẾ ĐỘ THỬ TRÊN MÁY</span><p class="muted" style="font-size:.88rem">Chưa nối Firebase. Dữ liệu chỉ lưu trong trình duyệt này, dùng để xem thử. Làm theo hướng dẫn cài đặt để dùng thật.</p></section>`:''}
    <p class="secure">${I.lock} Hội viên không cần mật khẩu. Kết nối được mã hóa.</p></div></div>`;
  if(s==='code')html=top('','')+`<div class="auth-body"><div class="in"><section class="auth-card" style="align-items:center;text-align:center"><span class="spin"></span><p class="muted">Đang kiểm tra mã…</p></section></div></div>`;
  if(s==='inv1'){const inv=authStep.inv;html=top('Chào '+esc(inv.memberCall),esc(inv.clubName)+' mời '+esc(inv.memberCall)+' dùng Nhịp Xanh để ghi thói quen mỗi ngày và xem kết quả.')+`<div class="auth-body"><div class="in"><section class="auth-card" style="font-size:1.05rem">
      <div class="steps"><i class="on"></i><i></i><i></i></div>
      <p>Không cần mật khẩu. Chỉ cần đọc và đồng ý ở bước tiếp theo.</p>
      ${IOS_BROWSER?`<div class="note warn" style="text-align:left"><span class="ic">${I.info}</span><div><b>Muốn có icon trên màn hình iPhone?</b> Làm bước này <b>trước</b>: bấm <b>Chia sẻ</b> → <b>Thêm vào MH chính</b>. Sau đó mở icon và nhập mã <b class="num">${fmtCode(authStep.code)}</b>. Mã chỉ dùng được 1 lần.</div></div>`:''}
      <button class="btn btn-primary btn-xl btn-block" data-act="a-inv2">${IOS_BROWSER?'Dùng luôn trên trình duyệt':'Bắt đầu'}</button>
      <button class="btn btn-ghost btn-block" data-act="authback">Đây không phải tôi</button></section></div></div>`}
  if(s==='inv2'){const inv=authStep.inv,c=inv.memberCall;html=top('','')+`<div class="auth-body"><div class="in"><section class="auth-card" style="font-size:1.02rem">
      <div class="steps"><i class="on"></i><i class="on"></i><i></i></div>
      <h2 style="font-size:1.45rem">Đồng ý lưu thông tin</h2>
      <p>Đây là <b>bản chạy thử</b> của ${esc(inv.clubName)}. App sẽ lưu:</p>
      <section class="card flush wrapb" style="box-shadow:inset 0 0 0 1.5px var(--line)">
        <div class="li"><span class="ic" style="background:var(--sunk)">${I.user}</span><span class="grow"><b>Tên gọi hoặc biệt danh</b><small>Không lưu số điện thoại, không lưu ảnh</small></span></div>
        <div class="li"><span class="ic" style="background:var(--sunk)">${I.calendar}</span><span class="grow"><b>Thói quen hằng ngày, điểm danh</b><small>Nước, bữa ăn, vận động, giấc ngủ, cân sáng</small></span></div>
        <div class="li"><span class="ic" style="background:var(--amber-soft);color:var(--amber)">${I.shield}</span><span class="grow"><b>Chỉ số cơ thể khi đo ở club</b><small>Dữ liệu sức khỏe nhạy cảm</small></span></div></section>
      <div class="note warn"><span class="ic">${I.info}</span><div>Dữ liệu được lưu trên <b>máy chủ Google Firebase đặt tại Singapore</b> (ngoài Việt Nam). Chỉ ${esc(c)} và chủ club xem được. Bảng xếp hạng thử thách hiện tên gọi và điểm thói quen, không hiện chỉ số cơ thể.</div></div>
      <p class="muted" style="font-size:.92rem">Chạy thử đến ngày <b>${dFull(inv.pilotEnd)}</b>, sau đó dữ liệu bị xóa hoặc chuyển sang máy chủ chính thức nếu ${esc(c)} đồng ý lần nữa. ${esc(cap(c))} có thể yêu cầu xem, sửa, xóa dữ liệu hoặc rút lại đồng ý bất cứ lúc nào.</p>
      <label class="consent" for="cs1"><input type="checkbox" id="cs1"><span>Tôi đồng ý cho ${esc(inv.clubName)} lưu và dùng các thông tin trên, kể cả <b>dữ liệu sức khỏe nhạy cảm</b>, trên máy chủ ở Singapore trong thời gian chạy thử.</span></label>
      <div class="err" id="a-err" aria-live="polite"></div>
      <button class="btn btn-primary btn-xl btn-block" data-act="a-inv3">Đồng ý và vào app</button></section></div></div>`}
  if(s==='inv3'){html=top('','')+`<div class="auth-body"><div class="in"><section class="auth-card" style="align-items:center;text-align:center;font-size:1.05rem">
      <div class="steps" style="width:100%"><i class="on"></i><i class="on"></i><i class="on"></i></div>
      <span style="width:84px;height:84px;border-radius:50%;background:var(--brand);color:var(--on-brand);display:grid;place-items:center">${isz(I.check,46)}</span>
      <h2 style="font-size:1.6rem">Xong rồi!</h2>
      ${STANDALONE?'':IOS_BROWSER?`<div class="note info" style="text-align:left;width:100%"><span class="ic">${I.info}</span><div>Lần sau mở lại đúng trình duyệt này để vào app. Nếu muốn có icon, nhờ chủ club gửi mã mới rồi làm bước "Thêm vào MH chính" trước khi nhập mã.</div></div>`
        :`<div class="note info" style="text-align:left;width:100%"><span class="ic">${I.info}</span><div><b>Để có icon trên điện thoại:</b> bấm <b>⋮</b> góc trên trình duyệt, chọn <b>Thêm vào màn hình chính</b>.</div></div>`}
      <button class="btn btn-primary btn-xl btn-block" data-act="a-done">Vào app</button></section></div></div>`}
  if(s==='su1')html=top('Tạo club mới','Bước 1/2 · Thông tin của bạn')+`<div class="auth-body"><div class="in"><section class="auth-card">${back()}
      <div class="steps"><i class="on"></i><i></i></div>
      <div class="field"><label for="su-full">Họ và tên</label><input id="su-full" value="${esc(su.full||'')}" autocomplete="name"></div>
      <div class="field"><label for="su-name">Tên hiển thị với hội viên</label><input id="su-name" value="${esc(su.name||'')}" placeholder="Ví dụ anh Minh, coach Minh"></div>
      <div class="field"><label for="su-email">Email (dùng để đăng nhập)</label><input id="su-email" type="email" inputmode="email" autocomplete="email" value="${esc(su.email||'')}"></div>
      <div class="field"><label for="su-pw1">Mật khẩu</label><input id="su-pw1" type="password" autocomplete="new-password"><span class="muted" style="font-size:.8rem">Ít nhất 8 ký tự, có cả chữ và số.</span></div>
      <div class="field"><label for="su-pw2">Nhập lại mật khẩu</label><input id="su-pw2" type="password" autocomplete="new-password"></div>
      <div class="err" id="a-err" aria-live="polite"></div>
      <button class="btn btn-primary btn-xl btn-block" data-act="su-2">Tiếp tục</button></section></div></div>`;
  if(s==='su2')html=top('Tạo club mới','Bước 2/2 · Thông tin club')+`<div class="auth-body"><div class="in"><section class="auth-card">${back('su-back1')}
      <div class="steps"><i class="on"></i><i class="on"></i></div>
      <div class="field"><label for="su-cname">Tên club</label><input id="su-cname" value="${esc(su.cname||'')}" placeholder="Ví dụ Club Sống Khỏe Q.7"></div>
      <div class="field"><label for="su-addr">Địa chỉ</label><input id="su-addr" value="${esc(su.addr||'')}"></div>
      <div class="field"><label for="su-hours">Giờ mở cửa</label><input id="su-hours" value="${esc(su.hours||'6:00 – 10:00 và 16:00 – 20:00')}"></div>
      <div class="field"><label for="su-end">Ngày kết thúc chạy thử</label><input id="su-end" type="date" value="${esc(su.end||addDays(TODAY,60))}"></div>
      <label class="check" for="su-agree"><input type="checkbox" id="su-agree" ${su.agree?'checked':''}><span>Tôi cam kết chỉ dùng dữ liệu hội viên để chăm sóc sức khỏe cho chính họ, chỉ nhập chỉ số khi hội viên đã đồng ý, và xóa dữ liệu khi kết thúc chạy thử hoặc khi hội viên yêu cầu.</span></label>
      <div class="err" id="a-err" aria-live="polite"></div>
      <button class="btn btn-primary btn-xl btn-block" data-act="su-done">Tạo club</button></section></div></div>`;
  a.innerHTML=html;a.scrollTop=0;
  if(s==='welcome')setupDigits('#code');
  if(s==='code')checkCode(authStep.code);
}
function keepSu(){const su=authStep.su=authStep.su||{};const g=id=>{const e=$('#'+id);return e?e.value.trim():undefined};
  ['full','name','email'].forEach(k=>{const v=g('su-'+k);if(v!==undefined)su[k]=v});
  if($('#su-pw1')){su.pw1=$('#su-pw1').value;su.pw2=$('#su-pw2').value}
  const c=g('su-cname');if(c!==undefined){su.cname=c;su.addr=g('su-addr');su.hours=g('su-hours');su.end=g('su-end');su.agree=$('#su-agree').checked}}
async function checkCode(code){
  code=(code||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(code.length!==8){authStep={s:'welcome',err:'Mã gồm 8 ký tự, ví dụ K7M2-Q9XA.'};render();return}
  try{
    await B.signInAnon();const inv=await B.getInvite(code);
    if(!inv){authStep={s:'welcome',err:'Mã không đúng hoặc đã được dùng rồi. Xin chủ club gửi mã mới.'};render();return}
    if(Date.now()>inv.expiresAt){authStep={s:'welcome',err:'Mã đã hết hạn. Xin chủ club gửi mã mới.'};render();return}
    authStep={s:'inv1',inv,code};
    // Member who already consented: skip the consent screen
    render();
  }catch(e){console.error(e);authStep={s:'welcome',err:authErr(e)};render()}
}

/* ============ Actions ============ */
const num=v=>{const n=parseFloat(String(v||'').replace(',','.'));return isNaN(n)?null:n};
async function updMe(patch){try{await wrap(B.updateMember(SES.clubId,SES.memberId,patch))}catch(_){}}
function dayPatch(fn){const h=JSON.parse(JSON.stringify(hOf(ME,TODAY)));h.meals=h.meals||{};fn(h);ME.habits=ME.habits||{};ME.habits[TODAY]=h;render();return updMe({['habits.'+TODAY]:h})}
async function doSignOut(){clearSubs();SES=null;CLUB=null;MEMBERS=[];ME=null;closeSheet();closePage();authStep={s:'welcome'};tab='today';try{await B.signOut()}catch(_){}render()}

document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-act]');if(!b)return;
  const a=b.dataset.act,id=b.dataset.id,v=b.dataset.v,m=id?M(id):null,C=SES&&SES.clubId;
  switch(a){
    /* auth */
    case 'a-code':{const code=[...document.querySelectorAll('#code input')].map(x=>x.value).join('');authStep={s:'code',code};render();break}
    case 'a-inv2':authStep.s='inv2';render();break;
    case 'a-inv3':{if(!$('#cs1').checked){$('#a-err').textContent='Cần tích vào ô đồng ý để tiếp tục.';break}
      b.disabled=true;const inv=authStep.inv;
      try{await B.claim({clubId:inv.clubId,memberId:inv.memberId},authStep.code,{date:TODAY,at:Date.now(),version:CONSENT_VER,server:'firebase-singapore'});authStep.s='inv3';render()}
      catch(err){console.error(err);b.disabled=false;$('#a-err').textContent=authErr(err)}break}
    case 'a-done':{const inv=authStep.inv,uid=await B.signInAnon(),u=await B.getUser(uid).catch(()=>null);authStep={s:'welcome'};SES={...(u||{role:'member',clubId:inv.clubId,memberId:inv.memberId}),uid};startSession();render();break}
    case 'authback':authStep={s:'welcome'};render();break;
    case 'o-login':{const em=$('#o-email').value.trim(),pw=$('#o-pass').value;if(!em||!pw){$('#o-err').textContent='Nhập email và mật khẩu.';break}
      b.disabled=true;authStep.email=em;try{await B.signInOwner(em,pw)}catch(err){b.disabled=false;$('#o-err').textContent=authErr(err)}break}
    case 'o-forgot':{const em=$('#o-email').value.trim();if(!em){$('#o-err').textContent='Nhập email trước, rồi bấm Quên mật khẩu.';break}
      try{await B.resetPass(em);$('#o-err').style.color='var(--brand)';$('#o-err').textContent='Đã gửi link đổi mật khẩu tới '+em+'. Kiểm tra cả hộp thư Spam.'}catch(err){$('#o-err').textContent=authErr(err)}break}
    case 'su-start':authStep={s:'su1',su:{}};render();break;
    case 'su-back1':keepSu();authStep.s='su1';render();break;
    case 'su-2':{keepSu();const su=authStep.su;
      if(!su.full||!su.name){$('#a-err').textContent='Cần nhập họ tên và tên hiển thị.';break}
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(su.email||'')){$('#a-err').textContent='Email chưa đúng định dạng.';break}
      if((su.pw1||'').length<8||!/[a-zA-Z]/.test(su.pw1)||!/\d/.test(su.pw1)){$('#a-err').textContent='Mật khẩu cần ít nhất 8 ký tự, có cả chữ và số.';break}
      if(su.pw1!==su.pw2){$('#a-err').textContent='Hai lần nhập mật khẩu không khớp.';break}
      authStep.s='su2';render();break}
    case 'su-done':{keepSu();const su=authStep.su;
      if(!su.cname){$('#a-err').textContent='Cần nhập tên club.';break}
      if(!su.end||su.end<=TODAY){$('#a-err').textContent='Ngày kết thúc chạy thử phải sau hôm nay.';break}
      if(!su.agree){$('#a-err').textContent='Cần đồng ý cam kết để tiếp tục.';break}
      b.disabled=true;authStep.creating=true;
      try{await B.signUpOwner({email:su.email,pass:su.pw1,club:{name:su.cname,address:su.addr,hours:su.hours,pilotEnd:su.end,ownerName:su.name,ownerFull:su.full,challenge:null,board:[]}});
        authStep={s:'welcome'};toast('Đã tạo '+su.cname)}
      catch(err){b.disabled=false;$('#a-err').textContent=authErr(err)}break}
    case 'account':sheetAccount();break;
    case 'logout':await doSignOut();break;
    /* owner */
    case 'tab':tab=v;render();window.scrollTo(0,0);break;
    case 'mfilter':tab='members';mfilter=v;render();window.scrollTo(0,0);break;
    case 'filter':filter=v;render();break;
    case 'mf':mfilter=v;render();break;
    case 'selmode':selMode=!selMode;sel.clear();render();break;
    case 'sel':sel.has(id)?sel.delete(id):sel.add(id);render();break;
    case 'selall':activeMembers().filter(x=>score(x,TODAY)<80).forEach(x=>sel.add(x.id));render();break;
    case 'remind':if(sel.size)sheetRemind([...sel]);break;
    case 'remind1':sheetRemind([id]);break;
    case 'rnext':sheetRemind.next();break;
    case 'rprev':sheetRemind.prev();break;
    case 'copymsg':copy($('#msgtext').textContent);break;
    case 'copytext':copy(b.dataset.t);break;
    case 'open':openMember(id);break;
    case 'closepage':closePage();render();break;
    case 'ptab':ptab=v;renderPage();break;
    case 'metric':metric=v;renderPage();break;
    case 'measure':if(m&&m.consent)sheetMeasure(m);break;
    case 'savemeasure':{const r={date:TODAY};METRICS.filter(x=>!x.calc).forEach(x=>{const n=num($('#f-'+x.k).value);if(n!=null)r[x.k]=n});
      if(r.weight==null){$('#f-err').textContent='Cần nhập ít nhất cân nặng.';break}
      if(r.height!=null&&(r.height<90||r.height>230)){$('#f-err').textContent='Chiều cao tính bằng cm, ví dụ 158.';break}
      const ms=(m.measures||[]).filter(x=>x.date!==TODAY);ms.push(r);try{await wrap(B.updateMember(C,m.id,{measures:ms}));closeSheet();ptab='metrics';toast('Đã lưu lần đo')}catch(_){}break}
    case 'targets':sheetTargets(m);break;
    case 'tg':{const t=sheetTargets.t,row=sheetTargets.rows.find(r=>r[0]===b.dataset.k);t[row[0]]=Math.min(row[5],Math.max(row[4],+(t[row[0]]+Number(v)).toFixed(1)));sheetTargets.draw();break}
    case 'savetargets':try{await wrap(B.updateMember(C,sheetTargets.m.id,{targets:{...sheetTargets.t}}));closeSheet();toast('Đã lưu mục tiêu')}catch(_){}break;
    case 'renew':sheetRenew(m);break;
    case 'dorenew':try{await wrap(B.updateMember(C,m.id,{pkg:mkPkg(PACKS[+v],TODAY)}));closeSheet();toast('Đã cập nhật gói')}catch(_){}break;
    case 'invite':sheetInvite(m);break;
    case 'unbind':sheetConfirm('Đăng xuất '+esc(m.call)+'?',`App trên điện thoại của ${esc(m.call)} sẽ không vào được nữa. Gửi mã mới khi ${esc(m.call)} cần vào lại.`,'Đăng xuất','dounbind',id);break;
    case 'dounbind':try{await wrap(B.updateMember(C,id,{uid:null}));if(m.inviteToken)B.deleteInvite(m.inviteToken);closeSheet();toast('Đã đăng xuất '+m.call)}catch(_){}break;
    case 'delmember':sheetConfirm('Xóa '+esc(m.name)+'?',`Toàn bộ thói quen, chỉ số và lịch sử điểm danh của ${esc(m.call)} sẽ bị xóa khỏi máy chủ. Không hoàn tác được.`,'Xóa hội viên','dodel',id,true);break;
    case 'dodel':try{if(m.inviteToken)await B.deleteInvite(m.inviteToken);await wrap(B.deleteMember(C,id));closeSheet();closePage();render();toast('Đã xóa hội viên')}catch(_){}break;
    case 'editmember':sheetMember(m);break;
    case 'checkin':try{await wrap(B.updateMember(C,id,{att:B.ops.union(TODAY)}));toast('Đã điểm danh '+m.call)}catch(_){}break;
    case 'uncheckin':try{await wrap(B.updateMember(C,id,{att:B.ops.remove(TODAY)}))}catch(_){}break;
    case 'newmember':sheetMember(null);break;
    case 'savemember':{const name=$('#n-name').value.trim().slice(0,40),call=$('#n-call').value+' '+name.split(' ').slice(-1)[0];
      if(!name){$('#n-err').textContent='Cần nhập tên gọi.';break}
      if(id){try{await wrap(B.updateMember(C,id,{name,call}));closeSheet();toast('Đã lưu')}catch(_){}break}
      const pi=+$('#n-pack').value;b.disabled=true;
      const data={name,call,color:AVC[MEMBERS.length%AVC.length],joined:TODAY,targets:{water:2000,meals:5,ex:30,sleep:7},pkg:pi>=0?mkPkg(PACKS[pi],TODAY):null,status:'invited',uid:null,consent:null,inviteToken:null,habits:{},measures:[],att:[],deleteRequested:false,createdAt:Date.now()};
      try{const mid=await wrap(B.createMember(C,data));closeSheet();setTimeout(()=>{const nm=M(mid)||{id:mid,...data};sheetInvite(nm)},150)}catch(_){b.disabled=false}break}
    case 'newch':sheetNewCh();break;
    case 'savech':try{await wrap(B.updateClub(C,{challenge:{name:$('#c-name').value.trim()||'Thử thách mới',start:TODAY,days:+$('#c-days').value,ids:activeMembers().map(x=>x.id)},board:[]}));closeSheet();toast('Đã bắt đầu thử thách')}catch(_){}break;
    case 'profile':closeSheet();openProfile();break;
    case 'clubinfo':closeSheet();openClub();break;
    case 'saveprofile':{const full=$('#p-full').value.trim(),nm=$('#p-name').value.trim();if(!full||!nm){$('#p-err').textContent='Cần nhập họ tên và tên hiển thị.';break}
      try{await wrap(B.updateClub(C,{ownerFull:full,ownerName:nm}));toast('Đã lưu')}catch(_){}break}
    case 'saveclub':{const n=$('#c-cname').value.trim(),end=$('#c-end').value;if(!n){$('#c-err').textContent='Cần nhập tên club.';break}
      try{await wrap(B.updateClub(C,{name:n,address:$('#c-addr').value.trim(),hours:$('#c-hours').value.trim(),pilotEnd:end||CLUB.pilotEnd}));toast('Đã lưu')}catch(_){}break}
    case 'changepass':try{await B.resetPass(SES.email);closeSheet();toast('Đã gửi link đổi mật khẩu tới email')}catch(err){toast(authErr(err))}break;
    case 'endpilot':sheetConfirm('Kết thúc chạy thử?',`Toàn bộ hội viên, thói quen, chỉ số, thử thách và tài khoản club <b>${esc(CLUB.name)}</b> sẽ bị xóa khỏi máy chủ. Không hoàn tác được.`,'Xóa toàn bộ','doend','',true,`<div class="field"><label for="cf-name">Gõ tên club để xác nhận</label><input id="cf-name" autocomplete="off" placeholder="${esc(CLUB.name)}"></div>`);break;
    case 'doend':{if($('#cf-name').value.trim()!==CLUB.name){$('#cf-err').textContent='Tên club chưa khớp.';break}b.disabled=true;
      try{clearSubs();await B.deleteClub(C,MEMBERS,SES.uid);toast('Đã xóa toàn bộ dữ liệu club');await doSignOut()}catch(err){console.error(err);b.disabled=false;$('#cf-err').textContent='Chưa xóa được, thử lại.'}break}
    case 'closesheet':closeSheet();break;
    /* member */
    case 'water':dayPatch(h=>{h.water=Math.max(0,(h.water||0)+Number(v))});break;
    case 'meal':sheetMeal(v);break;
    case 'food':closeSheet();dayPatch(h=>{if(v)h.meals[b.dataset.slot]=v;else delete h.meals[b.dataset.slot]});break;
    case 'ex':dayPatch(h=>{h.ex=Math.max(0,(h.ex||0)+Number(v))});break;
    case 'steps':dayPatch(h=>{h.steps=parseInt(($('#steps').value||'0').replace(/\D/g,''))||0});toast('Đã lưu số bước');break;
    case 'sleep':dayPatch(h=>{h.sleep=Math.min(14,Math.max(0,h.sleep?h.sleep+Number(v):ME.targets.sleep))});break;
    case 'weigh':{const n=num($('#weigh').value);if(n==null||n<25||n>250){toast('Nhập cân nặng, ví dụ 65,5');break}dayPatch(h=>{h.weigh=n});toast('Đã lưu '+fmt(n,1)+' kg');break}
    case 'mcheckin':sheetCheckinCode();break;
    case 'mcheckin-ok':{const code=[...document.querySelectorAll('#cc input')].map(x=>x.value).join('');
      if(code.length!==4){$('#cc-err').textContent='Nhập đủ 4 số.';break}b.disabled=true;
      try{await B.memberCheckin(SES.clubId,SES.memberId,code,TODAY);closeSheet();toast('Điểm danh thành công')}
      catch(err){b.disabled=false;$('#cc-err').textContent=/permission/i.test(err.code||err.message||'')?'Mã chưa đúng. Xem lại 4 số trên bảng ở quầy.':'Chưa gửi được, kiểm tra kết nối mạng.'}break}
    case 'reqdelete':sheetConfirm('Yêu cầu xóa dữ liệu?','Chủ club sẽ nhận được yêu cầu và xóa toàn bộ dữ liệu của bạn trong vòng 20 ngày.','Gửi yêu cầu','doreqdel','',true);break;
    case 'doreqdel':await updMe({deleteRequested:true});closeSheet();toast('Đã gửi yêu cầu');break;
  }
});
function copy(t){try{navigator.clipboard.writeText(t).then(()=>toast('Đã sao chép'),()=>toast('Hãy chọn và sao chép tay'))}catch(_){toast('Hãy chọn và sao chép tay')}}
document.addEventListener('keydown',e=>{if(e.key!=='Enter'||SES)return;const t=e.target;if(t.id==='o-pass')$('[data-act="o-login"]').click();else if(t.closest&&t.closest('#code'))$('[data-act="a-code"]').click()});
if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('sw.js').catch(()=>{});
boot();
