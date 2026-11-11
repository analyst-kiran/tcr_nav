// ═══ LIVE NAV ════════════════════════════════════════════════════════════════
// Daily AMFI NAVs computed by the tcr_nav GitHub job (window.TCR_NAV from nav_data.js).
// Before each run, every vendor fund row that can be matched to an AMFI scheme gets the latest
// NAV, NAV date, trailing returns and calendar-year returns. Risk ratios, corpus, ratings,
// benchmarks and everything else still come from the uploaded monthly files.
const LIVE_URLS=['__LIVE_URL__','nav_data.js'];
let LIVE_ON=(()=>{try{return localStorage.getItem('tcr_live')!=='0'}catch(e){return true}})();
let LIVE_INFO={tr:0,cy:0,funds:0,unmatched:[]};
const LIVE_READY=new Promise(res=>{
  let i=0,done=false;const finish=ok=>{if(!done){done=true;res(ok);liveBadge();}};
  const next=()=>{
    if(window.TCR_NAV)return finish(true);
    if(i>=LIVE_URLS.length)return finish(false);
    const s=document.createElement('script');
    s.src=LIVE_URLS[i++]+'?h='+new Date().toISOString().slice(0,13); // fresh copy each hour
    s.onload=()=>window.TCR_NAV?finish(true):next();s.onerror=next;
    document.head.appendChild(s);
  };
  setTimeout(()=>finish(!!window.TCR_NAV),10000);
  next();
});
function liveNorm(n){
  return String(n||'').toLowerCase()
    .replace(/\([^)]*\)/g,' ').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ')
    .replace(/\bsl\b/g,'sun life').replace(/\bpru\b/g,'prudential').replace(/\bmf\b/g,' ')
    .replace(/\b(reg|regular|plan|growth|option|fund|funds|the|scheme|formerly|known|as|erstwhile|g)\b/g,' ')
    .replace(/\s+/g,' ').trim();
}
function liveDice(a,b){
  const A=new Set(a.split(' ').filter(Boolean)),B=new Set(b.split(' ').filter(Boolean));
  if(!A.size||!B.size)return 0;let n=0;for(const t of A)if(B.has(t))n++;return 2*n/(A.size+B.size);
}
function liveKey(d){if(!(d instanceof Date)||isNaN(d))return null;return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function liveDMY(iso){const[y,m,d]=iso.split('-');return d+'/'+m+'/'+y;}
let LIVE_MAP=null,LIVE_IDX=null;
function liveIndex(){
  if(LIVE_IDX)return LIVE_IDX;
  const S=window.TCR_NAV.schemes,byPt={},norm={};
  for(const[c,f]of Object.entries(S)){
    norm[c]=liveNorm(f.name);
    for(const[k,v]of Object.entries(f.pt||{}))if(v)(byPt[k]=byPt[k]||[]).push([v,c]);
  }
  for(const k in byPt)byPt[k].sort((a,b)=>a[0]-b[0]);
  return LIVE_IDX={byPt,norm};
}
// Vendor scheme name → AMFI code. Match on the NAV the vendor printed for its NAV date (exact to
// 0.06%), confirmed by the fund house and the name; then a strict name-only fallback.
function liveMatch(row){
  const nm=row['SCHEME NAME'];if(!nm)return null;
  if(LIVE_MAP.has(nm))return LIVE_MAP.get(nm);
  const{byPt,norm}=liveIndex();
  const vn=liveNorm(nm),first=vn.split(' ')[0];
  const nav=toN(row['NAV']),key=liveKey(parseDMY(row['NAV DATE']));
  let best=null,bs=0;
  const arr=key&&byPt[key];
  if(arr&&fin(nav)&&nav>0){
    const tol=Math.max(nav*0.0006,0.00015);
    let lo=0,hi=arr.length;while(lo<hi){const m=(lo+hi)>>1;if(arr[m][0]<nav-tol)lo=m+1;else hi=m;}
    for(let i=lo;i<arr.length&&arr[i][0]<=nav+tol;i++){
      const c=arr[i][1];if(norm[c].split(' ')[0]!==first)continue;
      const s=liveDice(vn,norm[c]);if(s>bs){bs=s;best=c;}
    }
    if(best&&bs<0.35)best=null;
  }
  if(!best&&first){
    let second=0;
    for(const[c,n]of Object.entries(norm)){if(n.split(' ')[0]!==first)continue;const s=liveDice(vn,n);if(s>bs){second=bs;bs=s;best=c;}else if(s>second)second=s;}
    if(!(bs>=0.85&&bs-second>=0.1))best=null;
  }
  LIVE_MAP.set(nm,best);return best;
}
function liveApply(raw,kind){
  if(!LIVE_ON||!window.TCR_NAV||!raw||!raw.length)return raw;
  if(!LIVE_MAP)LIVE_MAP=new Map();
  const S=window.TCR_NAV.schemes;let n=0;const miss=[];
  const out=raw.map(r=>{
    const nm=r['SCHEME NAME'];if(!nm||!fin(toN(r['CORPUS'])))return r; // benchmarks / category rows
    const c=liveMatch(r);if(!c){miss.push(nm);return r;}
    const f=S[c],o={...r,'NAV':f.nav,'NAV DATE':liveDMY(f.nav_date)};
    for(const[k,v]of Object.entries(kind==='tr'?f.tr:f.cy))if(v!=null&&k in r)o[k]=v;
    o.__live=c;n++;return o;
  });
  out.asOn=raw.asOn;LIVE_INFO[kind]=n;
  if(kind==='tr')LIVE_INFO.unmatched=miss;
  LIVE_INFO.funds=Math.max(LIVE_INFO.tr,LIVE_INFO.cy);
  return out;
}
function liveBadge(){
  const b=document.getElementById('live-btn');if(!b)return;
  const D=window.TCR_NAV;
  if(!D){b.textContent='NAV ✕';b.title='Live NAV feed not reachable (offline?) — using the uploaded files only';b.dataset.state='off';return;}
  const d=new Date(D.latest_nav_date+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short'});
  b.textContent=(LIVE_ON?'NAV ':'NAV off ')+d;b.dataset.state=LIVE_ON?'on':'paused';
  b.title=LIVE_ON
    ?`Live NAV on — AMFI NAVs as of ${D.latest_nav_date} (updated ${D.generated.replace('T',' ').slice(0,16)} IST).\n`+
     (LIVE_INFO.funds?`${LIVE_INFO.funds} funds updated (NAV, trailing & calendar returns). `:'')+
     (LIVE_INFO.unmatched.length?`${LIVE_INFO.unmatched.length} not matched, kept from file.`:'')+
     `\nRisk ratios, corpus, ratings and benchmark rows are from the uploaded files.\nClick to switch off.`
    :'Live NAV off — every number is from the uploaded files. Click to switch on.';
}
async function toggleLive(){
  if(!window.TCR_NAV){alert('The live NAV feed could not be loaded. Check the internet connection and reload.');return;}
  LIVE_ON=!LIVE_ON;try{localStorage.setItem('tcr_live',LIVE_ON?'1':'0')}catch(e){}
  liveBadge();
  if(cyRaw&&trRaw){await runModel(true);if(typeof buildBenchStrip==='function')buildBenchStrip();if(typeof applyFilters==='function')applyFilters();}
}
// ═══ end LIVE NAV ═══
