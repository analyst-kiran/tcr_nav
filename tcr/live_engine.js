// ═══ LIVE ENGINE ═══════════════════════════════════════════════════════════════
// Uses the daily NAV history (hist/<year>.js) for: rankings as of any date (calendar), risk
// ratios the vendor leaves blank, rolling returns (feeds TCR's own rolling engine), and
// correction & recovery cycles (fund drawer). All conventions match the vendor exports.
const LIVE_HIST_BASE=LIVE_URLS[0].replace('nav_data.js','hist/');
let LIVE_T=null;                 // null = latest; otherwise the day number picked in the calendar
let LIVE_HIST_READY=false,LIVE_FS={},LIVE_RR_OURS=false;
const LIVE_HIST_P={};
const lsGet=(k,d)=>{try{const v=localStorage.getItem(k);return v==null?d:v}catch(e){return d}};
const lsSet=(k,v)=>{try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch(e){}};
let LIVE_RF_USER=(()=>{const v=parseFloat(lsGet('tcr_rf',''));return isFinite(v)?v:null})();
let LIVE_RR_LB=+lsGet('tcr_rr_lb',5)||5;   // rolling-return observation window, years

function liveLoadYear(y){
  if(LIVE_HIST_P[y])return LIVE_HIST_P[y];
  const cur=new Date().getFullYear(),bust=y>=cur-1?'?h='+new Date().toISOString().slice(0,13):'';
  const urls=[LIVE_HIST_BASE+y+'.js'+bust,'hist/'+y+'.js'];
  return LIVE_HIST_P[y]=new Promise(res=>{
    let i=0;const next=()=>{
      if(window.TCR_HIST&&TCR_HIST[y])return res(true);
      if(i>=urls.length)return res(false);
      const s=document.createElement('script');s.src=urls[i++];
      s.onload=()=>(window.TCR_HIST&&TCR_HIST[y])?res(true):next();s.onerror=next;document.head.appendChild(s);
    };next();
  });
}
async function liveLoadHistory(){
  const ps=[];for(let y=2006;y<=new Date().getFullYear();y++)ps.push(liveLoadYear(y));
  const ok=await Promise.all(ps);LIVE_FS={};
  LIVE_HIST_READY=ok.some(Boolean);return LIVE_HIST_READY;
}
function liveFund(code){
  if(code in LIVE_FS)return LIVE_FS[code];
  const H=window.TCR_HIST||{},e=lday('2000-01-01'),days=[],vals=[];
  for(const y of Object.keys(H).map(Number).sort((a,b)=>a-b)){
    const r=H[y][code];if(!r)continue;let acc=e;
    for(let i=0;i<r[0].length;i++){acc+=r[0][i];days.push(acc);vals.push(r[1][i]);}
  }
  return LIVE_FS[code]=days.length?{days:Int32Array.from(days),vals:Float64Array.from(vals)}:null;
}
function lidx(s,n){const a=s.days;if(!a.length||n<a[0])return -1;let lo=0,hi=a.length-1;while(lo<hi){const m=(lo+hi+1)>>1;if(a[m]<=n)lo=m;else hi=m-1;}return lo;}
const lfwd=(n,yrs)=>lback(n,{years:-yrs});
const r2=x=>fin(x)?+x.toFixed(2):null;

// Trailing + calendar returns at day T (same rules as scripts/compute.py)
function liveFundAt(s,T,yearsBack){
  const i=lidx(s,T);if(i<0||T-s.days[i]>10)return null;
  const end=s.vals[i],first=s.days[0],tr={},cy={};
  for(const[k,off,long]of LIVE_TRP){
    const st=lback(T,off)+(long?1:0);if(st<first){tr[k]=null;continue;}
    const v=lon(s,st),y=off.years||0;
    tr[k]=r2(((long?Math.pow(end/v,365/(T-st+1)):y?Math.pow(end/v,1/y):end/v)-1)*100);
  }
  const yT=ldate(T).y;
  for(let y=yT-yearsBack;y<=yT;y++){
    const j1=LDAY(y,0,1);if(j1<first){cy[String(y)]=null;continue;}
    const a=lon(s,j1),b=y===yT?end:lon(s,LDAY(y,11,31));cy[String(y)]=r2((b/a-1)*100);
  }
  return{nav:end,navDay:s.days[i],tr,cy};
}
// Vendor risk method: 36 month-end returns ending the month-end before E's month.
function liveRatios(s,E,rf){
  const t=ldate(E),p=[];
  for(let k=37;k>=1;k--){const mm=t.m-k+1,y=t.y+Math.floor(mm/12),m=((mm%12)+12)%12,d=LDAY(y,m,0);p.push(d>=s.days[0]?lon(s,d):NaN);}
  const r=[];for(let i=1;i<p.length;i++)if(fin(p[i])&&fin(p[i-1]))r.push(p[i]/p[i-1]-1);
  if(r.length<12)return null;
  const n=r.length,mu=r.reduce((a,b)=>a+b,0)/n,sd=Math.sqrt(r.reduce((a,b)=>a+(b-mu)**2,0)/(n-1));
  const lo=r.filter(x=>x<mu),ml=lo.reduce((a,b)=>a+b,0)/lo.length;
  const dd=lo.length>1?Math.sqrt(lo.reduce((a,b)=>a+(b-ml)**2,0)/(lo.length-1)):NaN;
  const SD=sd*Math.sqrt(12)*100,MEAN=mu*1200,DD=dd*Math.sqrt(12)*100;
  return{n,'STANDARD DEV':r2(SD),'MEAN':r2(MEAN),'SHARP RATIO':SD>0?r2((MEAN-rf)/SD):null,'SORTINO RATIO':DD>0?r2((MEAN-rf)/DD):null};
}
// Risk-free rate the vendor used: Sharpe = (Mean − RF)/SD for every fund, so RF = Mean − Sharpe×SD.
function liveRFfromFile(){
  const v=[];for(const r of trRaw||[]){const sd=toN(r['STANDARD DEV']),sh=toN(r['SHARP RATIO']),mu=toN(r['MEAN']);if(sd>0&&fin(sh)&&sh!==0&&fin(mu))v.push(mu-sh*sd);}
  if(!v.length)return NaN;v.sort((a,b)=>a-b);return+v[v.length>>1].toFixed(2);
}
const liveRF=()=>LIVE_RF_USER!=null?LIVE_RF_USER:(fin(liveRFfromFile())?liveRFfromFile():6.5);
const liveRiskMissing=r=>{const sd=toN(r['STANDARD DEV']);return!(sd>0);};
function liveFileDay(){for(const r of trRaw||[]){const d=liveVendorDay(r);if(d!=null)return d;}return null;}

// Rolling returns at T for one fund: daily start dates over the last LB years
const LIVE_RRP=[1,2,3,5,7,10];
function liveRolling(s,T,P,LB){
  const lastStart=lfwd(T,-P),firstStart=Math.max(s.days[0],lback(lastStart,{years:LB}));
  if(lastStart<=firstStart)return null;
  const out=[];let i=lidx(s,firstStart);if(i<0)i=0;if(s.days[i]<firstStart)i++;
  for(;i<s.days.length&&s.days[i]<=lastStart;i++){
    const e=lon(s,lfwd(s.days[i],P));if(!fin(e))continue;
    out.push((P===1?e/s.vals[i]-1:Math.pow(e/s.vals[i],1/P)-1)*100);
  }
  if(out.length<20)return null;
  const so=[...out].sort((a,b)=>a-b),n=out.length,pc=f=>+(out.filter(f).length/n*100).toFixed(1);
  return{avg:+(out.reduce((a,b)=>a+b,0)/n).toFixed(2),median:+so[n>>1].toFixed(2),max:+so[n-1].toFixed(2),min:+so[0].toFixed(2),
    negPct:pc(x=>x<0),r0_8:pc(x=>x>=0&&x<8),r8_12:pc(x=>x>=8&&x<12),r12_15:pc(x=>x>=12&&x<15),r15_20:pc(x=>x>=15&&x<20),rGt20:pc(x=>x>=20),obs:n};
}
// Correction & recovery cycles on a daily series up to T (falls of at least minFall %)
function liveCycles(s,T,minFall=10){
  const end=lidx(s,T);if(end<0)return null;
  const cyc=[];let pk=0,tr=0,inFall=false;
  for(let i=1;i<=end;i++){
    const v=s.vals[i];
    if(v>=s.vals[pk]){
      if(inFall){const f=(s.vals[tr]/s.vals[pk]-1)*100;if(f<=-minFall)cyc.push({peak:s.days[pk],trough:s.days[tr],fall:f,recovered:s.days[i]});inFall=false;}
      pk=i;tr=i;
    }else{if(!inFall){inFall=true;tr=i;}if(v<s.vals[tr])tr=i;}
  }
  let open=null;
  if(inFall){const f=(s.vals[tr]/s.vals[pk]-1)*100;open={peak:s.days[pk],trough:s.days[tr],fall:f,recovered:null};if(f<=-minFall)cyc.push(open);}
  const maxIn=from=>{let p=-1,mx=0;for(let i=lidx(s,from)<0?0:lidx(s,from);i<=end;i++){if(p<0||s.vals[i]>s.vals[p])p=i;const d=(s.vals[i]/s.vals[p]-1)*100;if(d<mx)mx=d;}return mx;};
  let ath=0;for(let i=0;i<=end;i++)if(s.vals[i]>s.vals[ath])ath=i;
  return{cycles:cyc,current:(s.vals[end]/s.vals[ath]-1)*100,athDay:s.days[ath],
    max3:maxIn(lback(T,{years:3})),max5:maxIn(lback(T,{years:5})),maxAll:maxIn(s.days[0]),since:s.days[0],
    fromLow:open?(s.vals[end]/s.vals[lidx(s,open.trough)]-1)*100:0};
}
function liveBenchSeries(nm,T){ // daily benchmark levels (vendor anchors + tracker) for drawdowns
  const B=window.TCR_BENCH;if(!B||!trRaw)return null;
  const row=trRaw.find(r=>r['SCHEME NAME']===nm);if(!row)return null;
  const m=B.map[nm],P=m?liveRecipe(m.recipe):null;if(!P)return null;
  const cyRow=(cyRaw||[]).find(r=>r['SCHEME NAME']===nm),A=liveAnchors(row,cyRow,P);if(!A)return null;
  const days=[],vals=[];for(const d of P.days){if(d>T)break;if(d<A.days[0])continue;const v=liveLevel(A,P,d);if(fin(v)){days.push(d);vals.push(v);}}
  return days.length?{days:Int32Array.from(days),vals:Float64Array.from(vals)}:null;
}

// ── rows as of a past date (calendar mode) ──
function liveRowsAt(raw,kind,T){
  const S=window.TCR_NAV.schemes,iso=liveISO(T),rf=liveRF(),E=T,BR=liveBenchAll(T,true);
  const out=[];
  for(const r of raw){
    const nm=r['SCHEME NAME'];if(!nm){out.push(r);continue;}
    if(!fin(toN(r['CORPUS']))){
      const b=BR[nm];
      if(!b)continue; // rows that can't be rebuilt for that date are left out
      const o={...r,'NAV':b.level,'NAV DATE':liveDMY(iso)};
      for(const k of LIVE_TRP.map(x=>x[0]))if(k in r)o[k]=b.tr[k]??null;
      if(kind==='cy')for(const k of Object.keys(r))if(periodInfo(k)?.gran==='Y')o[k]=b.cy[k]??null;
      if(kind==='cy')for(const[k,v]of Object.entries(b.cy))o[k]=v;
      out.push(o);continue;
    }
    const c=liveMatch(r);if(!c)continue;              // unmatched: can't be rebuilt for a past date
    const s=liveFund(c);if(!s)continue;
    const m=liveFundAt(s,T,9);if(!m)continue;         // fund did not exist (or was not publishing) then
    const o={...r,'NAV':m.nav,'NAV DATE':liveDMY(liveISO(m.navDay))};
    for(const k of LIVE_TRP.map(x=>x[0]))if(k in r)o[k]=m.tr[k];
    if(kind==='cy'){for(const k of Object.keys(r))if(periodInfo(k)?.gran==='Y')o[k]=null;Object.assign(o,m.cy);}
    const rk=liveRatios(s,E,rf);                       // ratios recomputed for that date, vendor method
    for(const k of['STANDARD DEV','MEAN','SHARP RATIO','SORTINO RATIO'])if(k in r)o[k]=rk&&rk.n>=36?rk[k]:null;
    o.__live=c;out.push(o);
  }
  out.asOn=null;return out;
}

// ── fill blank ratios (latest mode; computed for the uploaded file's own window) ──
function liveFillRisk(o,c){
  if(!LIVE_HIST_READY||!liveRiskMissing(o))return o;
  const s=liveFund(c),M=liveFileDay();if(!s||M==null)return o;
  const rk=liveRatios(s,M,liveRF());if(!rk)return o;
  for(const k of['STANDARD DEV','MEAN','SHARP RATIO','SORTINO RATIO'])if(k in o&&rk[k]!=null)o[k]=rk[k];
  o.__estRisk=rk.n;LIVE_INFO.riskFilled=(LIVE_INFO.riskFilled||0)+1;return o;
}

// ── rolling returns → TCR's rolling engine ──
function liveFeedRolling(){
  if(!LIVE_HIST_READY||!LIVE_ON||!SLOTS.ts.loaded)return;
  if(SLOTS.rr.loaded&&!LIVE_RR_OURS)return;  // an uploaded rolling-returns file wins
  const T=LIVE_T??lday(window.TCR_NAV.latest_nav_date);
  const raw={};const seen=new Set();
  for(const r of trRaw||[]){
    const nm=r['SCHEME NAME'];if(!nm||seen.has(nm)||!fin(toN(r['CORPUS'])))continue;seen.add(nm);
    const c=liveMatch(r);const s=c&&liveFund(c);if(!s)continue;
    for(const P of LIVE_RRP){const x=liveRolling(s,T,P,LIVE_RR_LB);if(x)(raw[P+'Y']=raw[P+'Y']||[]).push({name:nm,...x});}
  }
  RR_RAW={};for(const k of Object.keys(raw))RR_RAW[k]=raw[k];
  RR_PERIODS=Object.keys(RR_RAW).sort((a,b)=>parseInt(a)-parseInt(b));
  SLOTS.rr={loaded:true,name:`AMFI NAV history · rolling, ${LIVE_RR_LB}y window to ${liveISO(T)}`};LIVE_RR_OURS=true;
  computeRollingRatings();
}

// ── fund drawer: corrections & recoveries ──
function liveDrawerSection(name){
  if(!LIVE_HIST_READY||!LIVE_MAP)return'';
  const c=LIVE_MAP.get(name);const s=c&&liveFund(c);if(!s)return'';
  const T=LIVE_T??lday(window.TCR_NAV.latest_nav_date),f=liveCycles(s,T);if(!f)return'';
  const res=RES[name],bn=res?fundBench(name,res.cat):null,bs=bn?liveBenchSeries(benchKeyOf(bn)||bn,T):null,b=bs?liveCycles(bs,T):null;
  const pc=v=>fin(v)?v.toFixed(1)+'%':'—',col=v=>fin(v)&&v<0?'var(--red)':'var(--green)';
  const mon=(a,z)=>z==null?'not yet':Math.max(0,Math.round((z-a)/30.44))+' mo';
  const dt=n=>{const t=ldate(n);return MON3[t.m].charAt(0)+MON3[t.m].slice(1).toLowerCase()+'-'+String(t.y).slice(2);};
  const grid='<div class="d-mini-grid">'
    +dMini('Fall from peak',pc(f.current),col(f.current))+dMini('Peak',dt(f.athDay))
    +dMini('Max fall 3Y',pc(f.max3),col(f.max3))+dMini('Max fall 5Y',pc(f.max5),col(f.max5))
    +(b?dMini('Bench max 3Y',pc(b.max3),col(b.max3))+dMini('Bench max 5Y',pc(b.max5),col(b.max5)):'')
    +'</div>';
  const rows=f.cycles.slice(-6).reverse().map(x=>`<tr><td>${dt(x.peak)}</td><td>${dt(x.trough)}</td><td style="color:var(--red)">${x.fall.toFixed(1)}%</td><td>${mon(x.peak,x.trough)}</td><td>${mon(x.trough,x.recovered)}</td></tr>`).join('');
  const tbl=rows?`<table style="width:100%;font-size:.66rem;margin-top:8px;border-collapse:collapse"><tr style="color:var(--muted);text-align:left"><th>Peak</th><th>Bottom</th><th>Fall</th><th>Falling</th><th>Recovery</th></tr>${rows}</table>`:'<div style="font-size:.66rem;color:var(--muted);margin-top:6px">No fall of 10% or more in the data.</div>';
  return`<div class="drw-sec"><div class="drw-sec-lbl">📉 Corrections &amp; recoveries <span style="font-weight:400;color:var(--muted)">(NAV to ${liveISO(T)}${bn?' · vs '+eh(bn):''})</span></div>${grid}${tbl}</div>`;
}

// ── settings panel (opens from the NAV button) ──
function livePanel(){
  let p=document.getElementById('live-panel');
  if(p){p.remove();return;}
  const D=window.TCR_NAV;if(!D){alert('The live NAV feed could not be loaded. Check the internet connection and reload.');return;}
  const latest=D.latest_nav_date,cur=LIVE_T==null?latest:liveISO(LIVE_T),rfFile=liveRFfromFile();
  p=document.createElement('div');p.id='live-panel';
  p.innerHTML=`<div class="lp-h">Live data</div>
  <label class="lp-row"><span>Live NAV</span><input type="checkbox" id="lp-on" ${LIVE_ON?'checked':''}></label>
  <div class="lp-row"><span>As of</span><input type="date" id="lp-date" min="2010-01-01" max="${latest}" value="${cur}"><button id="lp-latest" class="lp-btn">Latest</button></div>
  <div class="lp-row"><span>Risk-free %</span><input type="number" step="0.01" id="lp-rf" placeholder="${fin(rfFile)?rfFile+' (from file)':'auto'}" value="${LIVE_RF_USER??''}"></div>
  <div class="lp-row"><span>Rolling window</span><select id="lp-lb">${[3,5,7,10].map(y=>`<option value="${y}" ${y===LIVE_RR_LB?'selected':''}>last ${y} years</option>`).join('')}</select></div>
  <div class="lp-note" id="lp-note">${LIVE_HIST_READY?'History loaded.':'Loading NAV history…'} Latest NAV ${latest}.</div>
  <button id="lp-apply" class="lp-btn lp-go">Apply</button>`;
  document.body.appendChild(p);
  const r=document.getElementById('live-btn').getBoundingClientRect();p.style.top=(r.bottom+6)+'px';p.style.right=Math.max(8,innerWidth-r.right)+'px';
  document.getElementById('lp-latest').onclick=()=>{document.getElementById('lp-date').value=latest;};
  document.getElementById('lp-apply').onclick=liveApplyPanel;
}
async function liveApplyPanel(){
  const on=document.getElementById('lp-on').checked,dv=document.getElementById('lp-date').value,rfv=document.getElementById('lp-rf').value,lb=+document.getElementById('lp-lb').value;
  const note=document.getElementById('lp-note');
  LIVE_ON=on;lsSet('tcr_live',on?'1':'0');
  LIVE_RF_USER=rfv===''?null:parseFloat(rfv);lsSet('tcr_rf',LIVE_RF_USER==null?null:String(LIVE_RF_USER));
  LIVE_RR_LB=lb;lsSet('tcr_rr_lb',String(lb));
  const latest=window.TCR_NAV.latest_nav_date;
  LIVE_T=(!on||!dv||dv>=latest)?null:lday(dv);
  if(LIVE_T!=null&&!LIVE_HIST_READY){note.textContent='Loading NAV history (first time ~10 MB)…';await liveLoadHistory();}
  document.getElementById('live-panel')?.remove();
  if(!on&&LIVE_RR_OURS){SLOTS.rr={loaded:false,name:null};RR_RAW={};RR_PERIODS=[];RR_RESULTS={};LIVE_RR_OURS=false;}
  if(cyRaw&&trRaw){await runModel(true);if(typeof buildBenchStrip==='function')buildBenchStrip();if(typeof applyFilters==='function')applyFilters();}
  liveBadge();
}
let LIVE_RR_KEY=null;
const _liveRunModel=runModel;
runModel=async function(keepView){
  // TCR decides which calendar year is still running from CY_ASON (the file title's date);
  // with live data on, the date being shown is the as-of date.
  const savedAsOn=CY_ASON;
  if(LIVE_ON&&window.TCR_NAV){const iso=LIVE_T!=null?liveISO(LIVE_T):window.TCR_NAV.latest_nav_date;const[y,m,d]=iso.split('-').map(Number);CY_ASON=new Date(y,m-1,d);}
  try{await _liveRunModel(keepView);}finally{CY_ASON=savedAsOn;}
  try{
    const T=LIVE_T??(window.TCR_NAV?lday(window.TCR_NAV.latest_nav_date):0);
    const key=[LIVE_ON,T,LIVE_RR_LB,LIVE_HIST_READY,trRaw?trRaw.length:0].join('|');
    if(LIVE_HIST_READY&&LIVE_ON&&key!==LIVE_RR_KEY){
      LIVE_RR_KEY=key;liveFeedRolling();
      if(document.getElementById('dashboard').style.display!=='none'){rebuildTabs();renderCurrentTab();}
    }
  }catch(e){console.warn('[live] rolling',e);}
  liveBadge();
};
const _liveOpenDrawer=openDrawer;
openDrawer=function(name){
  _liveOpenDrawer(name);
  try{const h=liveDrawerSection(name);if(h)document.getElementById('drw-body').insertAdjacentHTML('beforeend',h);}catch(e){console.warn('[live] drawer',e);}
};
// After the feed loads, fetch the NAV history in the background, then re-run once so rolling
// returns, blank ratios and drawdowns appear.
LIVE_READY.then(async ok=>{
  if(!ok)return;await liveLoadHistory();liveBadge();
  const wait=()=>new Promise(r=>{let n=0;const t=setInterval(()=>{n++;if((!LOAD_PENDING&&typeof allResults!=='undefined'&&allResults.length)||n>600){clearInterval(t);r();}},200);});
  await wait();
  if(LIVE_ON&&cyRaw&&trRaw&&document.getElementById('dashboard').style.display!=='none'){await runModel(true);if(typeof applyFilters==='function')applyFilters();}
});
// ═══ end LIVE ENGINE ═══
