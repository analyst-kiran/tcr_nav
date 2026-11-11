// ═══ LIVE NAV ════════════════════════════════════════════════════════════════
// Daily AMFI data published by the tcr_nav GitHub job:
//   nav_data.js  (window.TCR_NAV)   latest NAV + returns per Regular-Growth scheme
//   bench_px.js  (window.TCR_BENCH) daily NAVs of ETFs that track each benchmark
// Before each run, matched fund rows get the latest NAV, NAV date, trailing and calendar returns.
// Benchmark rows are anchored at the exact levels implied by the uploaded vendor file and rolled
// to the same date with their tracker ETF (or composite), so funds and benchmarks share one date.
// Risk ratios, corpus, ratings and categories still come from the uploaded monthly files.
const LIVE_URLS=['__LIVE_URL__','nav_data.js'];
const LIVE_BENCH_URLS=LIVE_URLS.map(u=>u.replace('nav_data.js','bench_px.js'));
let LIVE_ON=(()=>{try{return localStorage.getItem('tcr_live')!=='0'}catch(e){return true}})();
let LIVE_INFO={tr:0,cy:0,funds:0,unmatched:[],bench:0,benchStale:[]};
function liveLoad(urls,flag){
  return new Promise(res=>{
    let i=0;const next=()=>{
      if(window[flag])return res(true);
      if(i>=urls.length)return res(false);
      const s=document.createElement('script');
      s.src=urls[i++]+'?h='+new Date().toISOString().slice(0,13); // fresh copy each hour
      s.onload=()=>window[flag]?res(true):next();s.onerror=next;
      document.head.appendChild(s);
    };next();
  });
}
const LIVE_READY=Promise.race([
  Promise.all([liveLoad(LIVE_URLS,'TCR_NAV'),liveLoad(LIVE_BENCH_URLS,'TCR_BENCH')]),
  new Promise(r=>setTimeout(r,12000))
]).then(()=>{liveBadge();return!!window.TCR_NAV;});

// ── helpers ──
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
// Day numbers (days since 1970-01-01, UTC) keep date arithmetic exact
const LDAY=(y,m,d)=>Math.round(Date.UTC(y,m,d)/864e5);
function lday(iso){const[y,m,d]=iso.split('-').map(Number);return LDAY(y,m-1,d);}
function ldate(n){const d=new Date(n*864e5);return{y:d.getUTCFullYear(),m:d.getUTCMonth(),d:d.getUTCDate()};}
function lback(n,off){ // n minus {days|months|years}; month ends clamp like pandas DateOffset
  if(off.days)return n-off.days;
  const t=ldate(n),mm=t.m-(off.months||0)-12*(off.years||0);
  const y=t.y+Math.floor(mm/12),m=((mm%12)+12)%12,last=new Date(Date.UTC(y,m+1,0)).getUTCDate();
  return LDAY(y,m,Math.min(t.d,last));
}
function liveISO(n){const t=ldate(n);return t.y+'-'+String(t.m+1).padStart(2,'0')+'-'+String(t.d).padStart(2,'0');}

// ── fund matching (vendor scheme name → AMFI code) ──
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
// Match on the NAV the vendor printed for its NAV date (to 0.06%), confirmed by fund house and
// name; then a strict name-only fallback.
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

// ── benchmarks: vendor anchors + tracker roll ──
const LIVE_TRP=[['30 DAYS',{days:30},0],['3 MONTHS',{months:3},0],['6 MONTHS',{months:6},0],['1 YEAR',{years:1},0],
  ['2 YEARS',{years:2},0],['3 YEARS',{years:3},1],['4 YEARS',{years:4},1],['5 YEARS',{years:5},1],['7 YEARS',{years:7},1],['10 YEARS',{years:10},1]];
let LIVE_SER=null,LIVE_BRES=null,LIVE_BKEY=null;
function liveSeries(code){
  if(!LIVE_SER){LIVE_SER={};}
  if(LIVE_SER[code])return LIVE_SER[code];
  const r=window.TCR_BENCH.series[code];if(!r)return null;
  const e=lday(window.TCR_BENCH.epoch),days=new Int32Array(r.d.length);let acc=e;
  for(let i=0;i<r.d.length;i++){acc+=r.d[i];days[i]=acc;}
  return LIVE_SER[code]={days,vals:Float64Array.from(r.v)};
}
function lon(s,n){ // value on/before day n
  const a=s.days;if(!a.length||n<a[0])return NaN;
  let lo=0,hi=a.length-1;while(lo<hi){const m=(lo+hi+1)>>1;if(a[m]<=n)lo=m;else hi=m-1;}
  return s.vals[lo];
}
function liveRecipe(recipe){ // daily-rebalanced blend of trackers
  const legs=recipe.map(([w,c])=>[w,liveSeries(String(c))]);
  if(legs.some(([,s])=>!s))return null;
  if(legs.length===1)return legs[0][1];
  const start=Math.max(...legs.map(([,s])=>s.days[0]));
  const all=[...new Set(legs.flatMap(([,s])=>Array.from(s.days)))].filter(d=>d>=start).sort((a,b)=>a-b);
  const vals=new Float64Array(all.length);let lvl=1,prev=legs.map(([,s])=>lon(s,start));
  for(let i=0;i<all.length;i++){
    const cur=legs.map(([,s])=>lon(s,all[i]));
    if(i>0){let r=0;legs.forEach(([w],j)=>{r+=w*(cur[j]/prev[j]-1);});lvl*=1+r;}
    vals[i]=lvl;prev=cur;
  }
  return{days:Int32Array.from(all),vals};
}
function liveVendorDay(row){
  const d=parseDMY(row['NAV DATE']);if(!d)return null;
  const n=LDAY(d.getFullYear(),d.getMonth(),d.getDate());
  return d.getDate()===1?n-1:n; // "01/11" exports are as of the month-end before
}
function liveAnchors(trRow,cyRow){
  const M=liveVendorDay(trRow),L0=toN(trRow['NAV']);if(M==null||!fin(L0)||L0<=0)return null;
  const pts=new Map([[M,L0]]);
  for(const[k,off,long]of LIVE_TRP){
    const r=toN(trRow[k]);if(!fin(r))continue;
    const st=lback(M,off)+(long?1:0);
    pts.set(st,long?L0/Math.pow(1+r/100,(M-st+1)/365):L0/(1+r/100));
  }
  if(cyRow){
    const y0=ldate(M).y;let r=toN(cyRow[String(y0)]);
    if(fin(r)){
      let x=L0/(1+r/100);pts.set(LDAY(y0,0,1),x);
      for(let y=y0-1;y>y0-12;y--){r=toN(cyRow[String(y)]);if(!fin(r))break;x/=(1+r/100);pts.set(LDAY(y,0,1),x);}
    }
  }
  const a=[...pts.entries()].sort((p,q)=>p[0]-q[0]);
  return{M,days:a.map(p=>p[0]),lv:a.map(p=>p[1])};
}
// Index level on day n: exact at anchors; between anchors the tracker path, with its small
// residual spread evenly; after the last anchor the tracker plus last year's residual drift.
function liveLevel(A,P,n){
  const D=A.days,V=A.lv,k=D.length;
  const pr=(a,b)=>{const pa=P?lon(P,a):NaN,pb=P?lon(P,b):NaN;return fin(pa)&&fin(pb)&&pa>0?pb/pa:NaN;};
  if(n<=D[0]){const r=pr(D[0],n);return fin(r)?V[0]*r:NaN;}
  if(n>=D[k-1]){
    const r=pr(D[k-1],n);if(!fin(r))return n===D[k-1]?V[k-1]:NaN;
    let drift=0;const j=D.findIndex(d=>d>=D[k-1]-370);
    if(j>=0&&j<k-1){const rr=pr(D[j],D[k-1]);if(fin(rr))drift=Math.log(V[k-1]/(V[j]*rr))/(D[k-1]-D[j]);}
    return V[k-1]*r*Math.exp(drift*(n-D[k-1]));
  }
  let i=0;while(D[i+1]<n)i++;
  const f=(n-D[i])/(D[i+1]-D[i]),r=pr(D[i],n),rr=pr(D[i],D[i+1]);
  if(fin(r)&&fin(rr))return V[i]*r*Math.pow(V[i+1]/(V[i]*rr),f);
  return V[i]*Math.pow(V[i+1]/V[i],f); // no tracker data here: geometric interpolation
}
function liveBenchAll(T){
  const B=window.TCR_BENCH;if(!B||!trRaw)return{};
  const key=T+'|'+trRaw.length+'|'+(cyRaw?cyRaw.length:0);
  if(LIVE_BKEY===key)return LIVE_BRES;
  const cyBy={};for(const r of cyRaw||[])if(r['SCHEME NAME'])cyBy[r['SCHEME NAME']]=r;
  const res={},stale=[];
  for(const r of trRaw){
    const nm=r['SCHEME NAME'];if(!nm||fin(toN(r['CORPUS']))||res[nm])continue;
    const m=B.map[nm];if(!m){if(isBenchmarkRow(r))stale.push(nm);continue;}
    const A=liveAnchors(r,cyBy[nm]);const P=liveRecipe(m.recipe);
    if(!A||!P||T<=A.M){continue;}
    const LT=liveLevel(A,P,T);if(!fin(LT))continue;
    const tr={},cy={};
    for(const[k,off,long]of LIVE_TRP){
      if(!fin(toN(r[k])))continue;
      const st=lback(T,off)+(long?1:0),Ls=liveLevel(A,P,st);if(!fin(Ls)||Ls<=0)continue;
      const yrs=off.years||0;
      tr[k]=+(((long?Math.pow(LT/Ls,365/(T-st+1)):yrs?Math.pow(LT/Ls,1/yrs):LT/Ls)-1)*100).toFixed(2);
    }
    const yT=ldate(T).y,yM=ldate(A.M).y;
    for(let y=yM;y<=yT;y++){
      const a=liveLevel(A,P,LDAY(y,0,1)),b=y===yT?LT:liveLevel(A,P,LDAY(y,11,31));
      if(fin(a)&&fin(b)&&a>0)cy[String(y)]=+((b/a-1)*100).toFixed(2);
    }
    res[nm]={level:+LT.toFixed(2),tr,cy,proxy:m.proxy,err:m.err};
  }
  LIVE_INFO.bench=Object.keys(res).length;LIVE_INFO.benchStale=stale;
  LIVE_BKEY=key;return LIVE_BRES=res;
}

function liveApply(raw,kind){
  if(!LIVE_ON||!window.TCR_NAV||!raw||!raw.length)return raw;
  if(!LIVE_MAP)LIVE_MAP=new Map();
  const S=window.TCR_NAV.schemes,iso=window.TCR_NAV.latest_nav_date,T=lday(iso);
  const BR=liveBenchAll(T);
  let n=0;const miss=[];
  const out=raw.map(r=>{
    const nm=r['SCHEME NAME'];if(!nm)return r;
    if(!fin(toN(r['CORPUS']))){ // benchmark / index rows
      const b=BR[nm];if(!b)return r;
      const o={...r,'NAV':b.level,'NAV DATE':liveDMY(iso)};
      for(const[k,v]of Object.entries(kind==='tr'?b.tr:b.cy))if(v!=null&&k in r)o[k]=v;
      return o;
    }
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
    ?`Live NAV on — everything rolled to ${D.latest_nav_date} (data refreshed ${D.generated.replace('T',' ').slice(0,16)} IST).\n`+
     (LIVE_INFO.funds?`Funds: ${LIVE_INFO.funds} updated (NAV, trailing & calendar returns)`+(LIVE_INFO.unmatched.length?`, ${LIVE_INFO.unmatched.length} not matched (kept from file).\n`:'.\n'):'')+
     (LIVE_INFO.bench?`Benchmarks: ${LIVE_INFO.bench} rolled forward with their ETFs`+(LIVE_INFO.benchStale.length?`; ${LIVE_INFO.benchStale.length} have no tracker and stay at the file date.\n`:'.\n'):(window.TCR_BENCH?'':'Benchmark trackers not loaded — benchmarks stay at the file date.\n'))+
     `Risk ratios, corpus and ratings are from the uploaded files.\nClick to switch off.`
    :'Live NAV off — every number is from the uploaded files. Click to switch on.';
}
async function toggleLive(){
  if(!window.TCR_NAV){alert('The live NAV feed could not be loaded. Check the internet connection and reload.');return;}
  LIVE_ON=!LIVE_ON;try{localStorage.setItem('tcr_live',LIVE_ON?'1':'0')}catch(e){}
  liveBadge();
  if(cyRaw&&trRaw){await runModel(true);if(typeof buildBenchStrip==='function')buildBenchStrip();if(typeof applyFilters==='function')applyFilters();}
}
// ═══ end LIVE NAV ═══
