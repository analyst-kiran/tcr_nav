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
  const m=B.map[nm],P=m?liveRecipe(m.recipe,m.history):null;if(!P)return null;
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
  <div class="lp-row"><span>Calendar periods</span><select id="lp-gran">${[['Y','Yearly'],['H','Half-yearly'],['Q','Quarterly'],['M','Monthly']].map(([v,l])=>`<option value="${v}" ${v===LIVE_GRAN?'selected':''}>${l}</option>`).join('')}</select></div>
  <div class="lp-row"><span>Capture source</span><select id="lp-cap"><option value="file" ${LIVE_CAP==='file'?'selected':''}>Investwell (Top Schemes)</option><option value="nav" ${LIVE_CAP==='nav'?'selected':''}>NAV · TCR formula, all funds</option></select></div>
  <div class="lp-row"><span>Rolling window</span><select id="lp-lb">${[3,5,7,10].map(y=>`<option value="${y}" ${y===LIVE_RR_LB?'selected':''}>last ${y} years</option>`).join('')}</select></div>
  <div class="lp-note" id="lp-note">${LIVE_HIST_READY?'History loaded.':'Loading NAV history…'} Latest NAV ${latest}.</div>
  <button id="lp-apply" class="lp-btn lp-go">Apply</button>
  <div class="lp-row" style="margin-top:8px"><button class="lp-btn" style="flex:1" onclick="document.getElementById('live-panel').remove();liveModal('Signals',liveSignals())">🚀 Signals &amp; backtest</button><button class="lp-btn" style="flex:1" onclick="document.getElementById('live-panel').remove();liveModal('Benchmark sources',liveBenchSources())">Benchmark sources</button></div>`;
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
  LIVE_GRAN=document.getElementById('lp-gran').value;lsSet('tcr_gran',LIVE_GRAN);
  LIVE_CAP=document.getElementById('lp-cap').value;lsSet('tcr_cap',LIVE_CAP);
  if((LIVE_GRAN!=='Y'||LIVE_CAP==='nav')&&!LIVE_HIST_READY){note.textContent='Loading NAV history…';await liveLoadHistory();}
  const latest=window.TCR_NAV.latest_nav_date;
  LIVE_T=(!on||!dv||dv>=latest)?null:lday(dv);
  if(LIVE_T!=null&&!LIVE_HIST_READY){note.textContent='Loading NAV history (first time ~10 MB)…';await liveLoadHistory();}
  document.getElementById('live-panel')?.remove();
  if(!on&&LIVE_RR_OURS){SLOTS.rr={loaded:false,name:null};RR_RAW={};RR_PERIODS=[];RR_RESULTS={};LIVE_RR_OURS=false;}
  if(cyRaw&&trRaw){await runModel(true);if(typeof buildBenchStrip==='function')buildBenchStrip();if(typeof applyFilters==='function')applyFilters();}
  liveBadge();
}

// ── period returns (calendar granularity + monthly feed for captures) ──
let LIVE_GRAN=lsGet('tcr_gran','Y');          // Y | H | Q | M  (Calendar tab periods)
let LIVE_CAP=lsGet('tcr_cap','file');         // file = Investwell Top Schemes; nav = TCR formula on NAVs
const LIVE_GRAN_N={Y:9,H:10,Q:12,M:36};       // complete periods kept (plus the running one)
function livePeriods(T,gran,n){                // [{key,a,b}] oldest first; last one runs to T
  const t=ldate(T),out=[];
  const step={Y:12,H:6,Q:3,M:1}[gran];
  const curStartM=Math.floor(t.m/step)*step;
  for(let k=n;k>=0;k--){
    const sm=curStartM-k*step,y=t.y+Math.floor(sm/12),m=((sm%12)+12)%12;
    const a=LDAY(y,m,1),b=k===0?T:LDAY(y,m+step,0);
    const key=gran==='Y'?String(y):gran==='H'?y+'-H'+(m<6?1:2):gran==='Q'?y+'-Q'+(Math.floor(m/3)+1):y+'-'+String(m+1).padStart(2,'0');
    out.push({key,a,b});
  }
  return out;
}
function livePeriodVals(s,per){
  const o={};if(!s)return o;
  for(const p of per){if(p.a<s.days[0]){o[p.key]=null;continue;}const x=lon(s,p.a),z=lon(s,p.b);o[p.key]=fin(x)&&fin(z)&&x>0?r2((z/x-1)*100):null;}
  return o;
}
function liveRegran(rows,T){
  const per=livePeriods(T,LIVE_GRAN,LIVE_GRAN_N[LIVE_GRAN]),bs={};
  const out=rows.map(r=>{
    const nm=r['SCHEME NAME'];if(!nm)return r;
    const o={};for(const[k,v]of Object.entries(r))if(!periodInfo(k))o[k]=v;
    let s=null;
    if(fin(toN(r['CORPUS']))){const c=r.__live||LIVE_MAP.get(nm);s=c?liveFund(c):null;}
    else s=bs[nm]=bs[nm]||liveBenchSeries(nm,T);
    return Object.assign(o,livePeriodVals(s,per));
  });
  out.asOn=rows.asOn;return out;
}
function liveMonthlyRows(T){                  // fund + benchmark monthly returns for TCR's capture code
  const per=livePeriods(T,'M',37),rows=[],seen=new Set();
  for(const r of trRaw||[]){
    const nm=r['SCHEME NAME'];if(!nm||seen.has(nm))continue;seen.add(nm);
    const base={'SCHEME NAME':nm,'CATEGORY':r['CATEGORY'],'CORPUS':r['CORPUS'],'SCHEME BENCHMARK':r['SCHEME BENCHMARK'],'NAV DATE':liveDMY(liveISO(T))};
    let s=null;
    if(fin(toN(r['CORPUS']))){const c=LIVE_MAP.get(nm)||liveMatch(r);s=c?liveFund(c):null;}
    else if(window.TCR_BENCH&&TCR_BENCH.map[nm])s=liveBenchSeries(nm,T);
    if(s)rows.push(Object.assign(base,livePeriodVals(s,per)));
  }
  return rows;
}
const _liveApplyBase=liveApply;
liveApply=function(raw,kind){
  let out=_liveApplyBase(raw,kind);
  if(kind==='cy'&&LIVE_ON&&LIVE_HIST_READY&&LIVE_GRAN!=='Y'&&window.TCR_NAV&&out&&out.length)
    out=liveRegran(out,LIVE_T??lday(window.TCR_NAV.latest_nav_date));
  return out;
};


// ── score history: TCR re-scored at past month-ends (quiet runs, saved in the browser) ──
let LIVE_SILENT=false,LIVE_SH=null,LIVE_SH_BUSY=false;
const LIVE_W={t:W_TR,c:W_CY,r:W_RK,k:W_CONS};      // TCR's own pillar weights
const _liveShowLoad=showLoad,_liveSetMsg=setLoadMsg;
showLoad=function(m){if(!LIVE_SILENT)_liveShowLoad(m);};
setLoadMsg=function(m){if(!LIVE_SILENT)_liveSetMsg(m);};
function liveIDB(){return new Promise((res,rej)=>{const q=indexedDB.open('tcr_live',1);q.onupgradeneeded=()=>q.result.createObjectStore('sh');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});}
async function liveIDBget(k){try{const db=await liveIDB();return await new Promise(r=>{const g=db.transaction('sh').objectStore('sh').get(k);g.onsuccess=()=>r(g.result||null);g.onerror=()=>r(null);});}catch(e){return null;}}
async function liveIDBput(k,v){try{const db=await liveIDB();await new Promise(r=>{const t=db.transaction('sh','readwrite');t.objectStore('sh').put(v,k);t.oncomplete=r;t.onerror=r;});}catch(e){}}
function liveSHSig(){ // what the scores depend on: the uploaded files and the live settings
  const f=(LOADED_FILES||[]).map(x=>x.file.name+':'+x.file.size).sort().join('|');
  return['v2',f,trRaw?trRaw.length:0,cyRaw?cyRaw.length:0,LIVE_GRAN,LIVE_CAP,LIVE_RF_USER??'',INCLUDE_PASSIVE?1:0,INCLUDE_FOF?1:0].join('#');
}
function liveSHDates(){
  const L=lday(window.TCR_NAV.latest_nav_date),t=ldate(L),out=[];
  for(let k=60;k>=1;k--){const mm=t.m-k+1,y=t.y+Math.floor(mm/12),m=((mm%12)+12)%12;out.push(LDAY(y,m,0));}  // last 60 month-ends
  const first=out[0];
  for(let y=2015;;y++){let done=false;for(const m of[3,6,9,12]){const d=LDAY(y,m,0);if(d>=first){done=true;break;}out.push(d);}if(done)break;}
  out.push(L);return[...new Set(out)].sort((a,b)=>a-b);
}
function liveSnapshot(){
  const o={},byCat={};
  for(const r of allResults)if(fin(r.composite))(byCat[r.cat]=byCat[r.cat]||[]).push(r);
  for(const rs of Object.values(byCat)){rs.sort((a,b)=>b.composite-a.composite);
    rs.forEach((r,i)=>{o[r.name]=[r.composite,r.trailing,r.calendar,r.risk,r.consistency,i+1,rs.length].map(v=>fin(v)?+(+v).toFixed(1):null);});}
  return o;
}
async function liveBuildScoreHistory(){
  if(LIVE_SH_BUSY||!LIVE_HIST_READY||!trRaw)return;
  LIVE_SH_BUSY=true;const sig=liveSHSig(),dates=liveSHDates(),latest=dates[dates.length-1];
  const keep={T:LIVE_T},H={};let todo=[];
  for(const d of dates){const v=d===latest?null:await liveIDBget(sig+'@'+d);if(v)H[d]=v;else todo.push(d);}
  try{
    if(todo.length){_liveShowLoad('Building score history…');await tick();}
    let i=0;
    for(const d of todo){
      i++;_liveSetMsg(`Score history: ${liveISO(d)} (${i}/${todo.length})`);await tick();
      LIVE_T=d===latest?null:d;LIVE_SILENT=true;
      try{await runModel(true);}finally{LIVE_SILENT=false;}
      H[d]=liveSnapshot();if(d!==latest)await liveIDBput(sig+'@'+d,H[d]);
    }
  }finally{
    LIVE_T=keep.T;LIVE_SH_BUSY=false;
    if(todo.length){await runModel(true);if(typeof applyFilters==='function')applyFilters();}
    hideLoad();
  }
  LIVE_SH={sig,dates:Object.keys(H).map(Number).sort((a,b)=>a-b),H};
  liveBadge();return LIVE_SH;
}
function liveFundHistory(name){
  if(!LIVE_SH)return null;
  const pts=LIVE_SH.dates.map(d=>({d,v:LIVE_SH.H[d][name]})).filter(x=>x.v&&fin(x.v[0]));
  return pts.length?pts:null;
}
function liveScoreSection(name){
  if(!window.TCR_NAV||!LIVE_HIST_READY)return'';
  const btn='<button class="lp-btn" style="padding:3px 9px;border:1px solid var(--border);border-radius:5px;background:var(--card2);color:var(--text);cursor:pointer" '
    +'onclick="liveBuildScoreHistory().then(()=>openDrawer('+JSON.stringify(name).replace(/"/g,'&quot;')+'))">';
  if(!LIVE_SH||LIVE_SH.sig!==liveSHSig())
    return`<div class="drw-sec"><div class="drw-sec-lbl">📈 Score history</div><div style="font-size:.68rem;color:var(--muted);margin-bottom:6px">Re-scores TCR at every month-end for 5 years and every quarter-end since 2015 (about 85 runs, a few minutes the first time; saved in this browser).</div>${btn}Build score history</button></div>`;
  const pts=liveFundHistory(name);if(!pts||pts.length<3)return'<div class="drw-sec"><div class="drw-sec-lbl">📈 Score history</div><div style="font-size:.68rem;color:var(--muted)">Not enough history for this fund.</div></div>';
  const now=pts[pts.length-1],L=now.d,avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
  const yr=pts.filter(p=>p.d>=lback(L,{years:1})),all=pts;
  const sc=a=>a.map(p=>p.v[0]);
  const aAll=avg(sc(all)),a1=avg(sc(yr)),sd=Math.sqrt(avg(sc(all).map(v=>(v-aAll)**2)));
  const z=sd>0?(now.v[0]-aAll)/sd:0;
  // why: pillar changes vs the 1-year average, weighted like TCR's final score
  const pil=[['Trailing',1,LIVE_W.t],['Calendar',2,LIVE_W.c],['Risk',3,LIVE_W.r],['Consistency',4,LIVE_W.k]];
  const parts=pil.map(([lbl,i,w])=>{const h=yr.map(p=>p.v[i]).filter(fin);const v=now.v[i];return fin(v)&&h.length?{lbl,w,d:v-avg(h)}:null;}).filter(Boolean);
  const wsum=parts.reduce((a,p)=>a+p.w,0)||1;parts.forEach(p=>p.c=p.d*p.w/wsum);
  parts.sort((a,b)=>Math.abs(b.c)-Math.abs(a.c));
  const col=v=>v>=0?'var(--green)':'var(--red)',sgn=v=>(v>=0?'+':'')+v.toFixed(1);
  const why=parts.map(p=>`<span style="margin-right:10px">${p.lbl} <b style="color:${col(p.c)}">${sgn(p.c)}</b> <span style="color:var(--muted)">(pillar ${sgn(p.d)})</span></span>`).join('');
  const rk=now.v[5]?`#${now.v[5]} of ${now.v[6]}`:'—',rk1=yr[0]&&yr[0].v[5]?`#${yr[0].v[5]} of ${yr[0].v[6]}`:'—';
  // sparkline
  const W=330,Hh=60,xs=pts.map(p=>p.d),x0=xs[0],x1=xs[xs.length-1]||x0+1;
  const vs=pts.map(p=>p.v[0]),lo=Math.max(0,Math.min(...vs)-5),hi=Math.min(100,Math.max(...vs)+5);
  const X=d=>(d-x0)/(x1-x0||1)*W,Y=v=>Hh-4-((v-lo)/((hi-lo)||1))*(Hh-8);
  const path=pts.map((p,i)=>(i?'L':'M')+X(p.d).toFixed(1)+' '+Y(p.v[0]).toFixed(1)).join(' ');
  const svg=`<svg viewBox="0 0 ${W} ${Hh}" width="100%" height="${Hh}" style="margin-top:6px"><line x1="0" x2="${W}" y1="${Y(aAll)}" y2="${Y(aAll)}" stroke="var(--muted2)" stroke-dasharray="3 3" stroke-width="1"/><path d="${path}" fill="none" stroke="var(--blue)" stroke-width="1.6"/><circle cx="${X(L)}" cy="${Y(now.v[0])}" r="3" fill="var(--blue)"/><text x="2" y="10" font-size="9" fill="var(--muted)">${hi.toFixed(0)}</text><text x="2" y="${Hh-2}" font-size="9" fill="var(--muted)">${lo.toFixed(0)}</text><text x="${W-2}" y="${Y(aAll)-3}" font-size="9" fill="var(--muted)" text-anchor="end">all-time avg</text></svg>`;
  const dt=n=>{const t=ldate(n);return MON3[t.m].charAt(0)+MON3[t.m].slice(1).toLowerCase()+'-'+String(t.y).slice(2);};
  return`<div class="drw-sec"><div class="drw-sec-lbl">📈 Score history <span style="font-weight:400;color:var(--muted)">(${dt(all[0].d)} → ${dt(L)}, ${all.length} points)</span></div>
  <div class="d-mini-grid">${dMini('Score now',now.v[0].toFixed(1))}${dMini('1Y average',a1.toFixed(1))}${dMini('All-time avg',aAll.toFixed(1))}
  ${dMini('Deviation',sgn(now.v[0]-aAll)+' pts',col(now.v[0]-aAll))}${dMini('vs own history',(z>=0?'+':'')+z.toFixed(1)+'σ',col(z))}${dMini('Rank now / 1Y ago',rk+' · '+rk1)}</div>
  <div style="font-size:.68rem;margin-top:6px"><span style="color:var(--muted)">Why it moved vs its 1Y average:</span> ${why||'—'}</div>${svg}</div>`;
}


// ── pop-up views: benchmark sources, signals ──
function liveModal(title,html){
  document.getElementById('live-modal')?.remove();
  const m=document.createElement('div');m.id='live-modal';
  m.innerHTML=`<div class="lm-box"><div class="lm-h"><b>${title}</b><button onclick="document.getElementById('live-modal').remove()">✕</button></div><div class="lm-b">${html}</div></div>`;
  m.onclick=e=>{if(e.target===m)m.remove();};document.body.appendChild(m);
}
const lnk=n=>`<a href="#" onclick="document.getElementById('live-modal').remove();openDrawer(${JSON.stringify(n).replace(/"/g,'&quot;')});return false">${eh(sn?sn(n):n)}</a>`;
const lf=(v,d=1)=>fin(v)?(+v).toFixed(d):'—';
function liveBenchSources(){
  const T=lday(window.TCR_NAV.latest_nav_date),BR=liveBenchAll(T),B=window.TCR_BENCH||{map:{}};
  const used={};for(const r of allResults||[]){const b=fundBench(r.name,r.cat);if(b)(used[b]=used[b]||new Set()).add(r.catLbl||r.cat);}
  const rows=[];const seen=new Set();
  for(const r of trRaw||[]){
    const nm=r['SCHEME NAME'];if(!nm||seen.has(nm)||fin(toN(r['CORPUS']))||!isBenchmarkRow(r))continue;seen.add(nm);
    const m=B.map[nm],b=BR[nm],u=used[nm]?[...used[nm]]:[];
    rows.push({nm,u,method:m?(m.recipe.length>1?'Composite':'Tracker'):'File only',proxy:m?m.proxy:'—',err:m?m.err:null,f1:toN(r['1 YEAR']),l1:b?b.tr['1 YEAR']:null,live:!!b});
  }
  rows.sort((a,b)=>(b.u.length-a.u.length)||(a.method==='File only')-(b.method==='File only')||a.nm.localeCompare(b.nm));
  const fd=liveFileDay();
  return`<p class="lm-p"><b>How benchmarks flow.</b> Benchmark rows live in your Trailing and Calendar files, and TCR's benchmark list shows every one of them.
  Before each run the live layer rewrites a benchmark row's level, trailing and calendar returns: anchored to the exact levels implied by the file (as of ${fd!=null?liveISO(fd):'—'}),
  rolled to ${window.TCR_NAV.latest_nav_date} with the tracker below. Whichever benchmark you pick in TCR then uses the live row. Rows marked <i>file only</i> have no tracker and keep the file's values
  (in calendar mode they are interpolated between the file's exact levels). Benchmark 2-year returns are annualised like funds' (the file gives benchmarks' 2Y as an absolute return).</p>
  <table class="lm-t"><tr><th>Benchmark</th><th>Default for</th><th>Source</th><th>Tracker</th><th>Test error / 30d</th><th>1Y file</th><th>1Y live</th></tr>
  ${rows.map(r=>`<tr class="${r.live?'':'lm-dim'}"><td>${eh(r.nm)}</td><td style="max-width:220px;white-space:normal">${eh(r.u.join(', '))||'—'}</td><td>${r.method}</td><td>${eh(r.proxy)}</td><td>${r.err!=null?r.err.toFixed(3)+'%':'—'}</td><td>${lf(r.f1,2)}</td><td>${lf(r.l1,2)}</td></tr>`).join('')}</table>`;
}
// percentile of v in arr (0 worst … 1 best)
const lpct=(v,arr)=>{const a=arr.filter(fin);if(!fin(v)||a.length<2)return NaN;return a.filter(x=>x<v).length/(a.length-1);};
// ── as-of correctness: fund age is measured at the date being shown (no look-ahead) ──
const _liveAge=fundAgeMonths;
fundAgeMonths=function(name){
  if(!LIVE_ON||LIVE_T==null)return _liveAge(name);
  const d=getLaunchDate(name);if(!d)return null;const t=ldate(LIVE_T);
  let m=(t.y-d.getFullYear())*12+(t.m-d.getMonth());if(t.d<d.getDate())m--;return Math.max(0,m);
};

// ── Top Schemes snapshots (one per monthly file, kept in this browser) ──
let LIVE_TS={};                                   // {iso date: {fund: [manager, L, M, S, aum, er, uc, dc]}}
function liveIDB2(){return new Promise((res,rej)=>{const q=indexedDB.open('tcr_live_ts',1);q.onupgradeneeded=()=>q.result.createObjectStore('ts');q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});}
async function liveTSLoadAll(){try{const db=await liveIDB2();await new Promise(r=>{const st=db.transaction('ts').objectStore('ts'),q=st.openCursor();q.onsuccess=()=>{const c=q.result;if(c){LIVE_TS[c.key]=c.value;c.continue();}else r();};q.onerror=r;});}catch(e){}}
async function liveTSSave(k,v){LIVE_TS[k]=v;delete LIVE_TSNK[k];try{const db=await liveIDB2();await new Promise(r=>{const t=db.transaction('ts','readwrite');t.objectStore('ts').put(v,k);t.oncomplete=r;t.onerror=r;});}catch(e){}}
function liveTSSnap(rows){
  const h=(rows||[]).findIndex(r=>(r||[]).some(v=>String(v||'').trim().toUpperCase()==='SCHEMES'));if(h<0)return;
  const H=rows[h].map(v=>String(v||'').trim().toUpperCase()),col=n=>H.indexOf(n);
  const c={n:col('SCHEMES'),m:col('FUND MANAGER'),l:col('LARGE CAP'),md:col('MID CAP'),s:col('SMALL CAP'),a:col('A U M')>=0?col('A U M'):col('AUM(CR)'),e:col('EXPENSE RATIO'),u:col('UP CAPTURE'),d:col('DOWN CAPTURE'),dt:col('NAV DATE')};
  if(c.m<0)return; // only the full export (with FUND MANAGER) is kept as a snapshot
  const snap={},dates={};
  for(let i=h+1;i<rows.length;i++){const r=rows[i];if(!r||!r[c.n])continue;
    snap[String(r[c.n]).trim()]=[String(r[c.m]||'').trim(),toN(r[c.l]),toN(r[c.md]),toN(r[c.s]),toN(r[c.a]),toN(r[c.e]),toN(r[c.u]),toN(r[c.d])].map(v=>typeof v==='number'&&!fin(v)?null:v);
    const d=parseDMY(r[c.dt]);if(d){const k=liveKey(d);dates[k]=(dates[k]||0)+1;}}
  const key=Object.entries(dates).sort((a,b)=>b[1]-a[1])[0]?.[0];if(key&&Object.keys(snap).length>100)liveTSSave(key,snap);
}
const _liveParseTS=parseTSFile;
parseTSFile=function(rows){const out=_liveParseTS(rows);try{liveTSSnap(rows);}catch(e){console.warn('[live] TS snapshot',e);}return out;};
const liveMgrSet=s=>String(s||'').toLowerCase().split(/[,&/]| and /).map(x=>x.trim()).filter(Boolean).sort().join(', ');
const LIVE_TSNK={};
function liveTSHistory(name){ // oldest → newest; exact name, else normalised name
  const nk=normKey(name);
  return Object.keys(LIVE_TS).sort().map(k=>{
    if(!LIVE_TSNK[k]){LIVE_TSNK[k]={};for(const n of Object.keys(LIVE_TS[k]))LIVE_TSNK[k][normKey(n)]=n;}
    return{k,v:LIVE_TS[k][name]||LIVE_TS[k][LIVE_TSNK[k][nk]]};
  }).filter(x=>x.v);
}
function liveMgrChange(name){
  const h=liveTSHistory(name);if(h.length<2)return null;
  for(let i=h.length-1;i>0;i--)if(liveMgrSet(h[i].v[0])!==liveMgrSet(h[i-1].v[0]))return{when:h[i].k,from:h[i-1].v[0],to:h[i].v[0]};
  return{none:true,months:h.length};
}
// SEBI minimums for the size categories (reported portfolio, latest snapshot)
const LIVE_MANDATE={'Equity: Large Cap':[1,80,'large'],'Equity: Mid Cap':[2,65,'mid'],'Equity: Small Cap':[3,65,'small'],'Equity: Large & Mid Cap':[[1,35],[2,35]],'Equity: Multi Cap':[[1,25],[2,25],[3,25]]};

// ── style from NAV: weekly returns regressed on Nifty 100 / Midcap 150 / Smallcap 250 (weights ≥0, sum 1) ──
const LIVE_FAC=['NSE Nifty 100 TRI','NSE Nifty Midcap 150 TRI','NSE Nifty Smallcap 250 TRI'];
let LIVE_FACS=null;
function liveFactors(T){if(LIVE_FACS&&LIVE_FACS.T===T)return LIVE_FACS;const f=LIVE_FAC.map(n=>liveBenchSeries(n,T));return LIVE_FACS={T,f:f.every(Boolean)?f:null};}
function liveStyleAt(s,end,days=252){ // daily returns over ~1 year; exact least squares on the 3×3 moments, weights on a 5% grid
  const F=liveFactors(LIVE_T??lday(window.TCR_NAV.latest_nav_date)).f;if(!F||!s)return null;
  const z=lidx(s,end);if(z<days||end-s.days[z]>10)return null;
  const R=[],X=[[],[],[]];
  for(let i=z-days+1;i<=z;i++){const a=s.days[i-1],b=s.days[i];const xs=F.map(f=>{const xa=lon(f,a),xb=lon(f,b);return fin(xa)&&fin(xb)&&xa>0?xb/xa-1:NaN;});
    if(xs.some(x=>!fin(x)))continue;R.push(s.vals[i]/s.vals[i-1]-1);xs.forEach((x,j)=>X[j].push(x));}
  const n=R.length;if(n<days*0.8)return null;
  const mean=a=>a.reduce((p,q)=>p+q,0)/a.length,mr=mean(R),mx=X.map(mean);
  const cov=(a,ma,b,mb)=>{let t=0;for(let k=0;k<n;k++)t+=(a[k]-ma)*(b[k]-mb);return t/n;};
  const vR=cov(R,mr,R,mr),cR=X.map((x,j)=>cov(R,mr,x,mx[j])),S=X.map((x,i)=>X.map((y,j)=>cov(x,mx[i],y,mx[j])));
  let best=null;
  for(let i=0;i<=20;i++)for(let j=0;j<=20-i;j++){const w=[i/20,j/20,(20-i-j)/20];let q=vR;
    for(let a=0;a<3;a++){q-=2*w[a]*cR[a];for(let b=0;b<3;b++)q+=w[a]*w[b]*S[a][b];}
    if(!best||q<best.q)best={w,q};}
  return{L:Math.round(best.w[0]*100),M:Math.round(best.w[1]*100),S:Math.round(best.w[2]*100),r2:vR>0?1-best.q/vR:0};
}
function liveStyle(code,T){const s=liveFund(code);if(!s)return null;const now=liveStyleAt(s,T),y1=liveStyleAt(s,lback(T,{years:1})),y3=liveStyleAt(s,lback(T,{years:3}));
  const drift=(a,b)=>a&&b?(Math.abs(a.L-b.L)+Math.abs(a.M-b.M)+Math.abs(a.S-b.S))/2:null;return{now,y1,y3,d1:drift(now,y1),d3:drift(now,y3)};}

// ── fund diagnostics from daily NAVs ──
function liveMonthEnds(T,n){const t=ldate(T),o=[];for(let k=n;k>=1;k--){const mm=t.m-k+1,y=t.y+Math.floor(mm/12),m=((mm%12)+12)%12;o.push(LDAY(y,m,0));}return o;} // n month-ends before T's month
function liveRollDist(s,bs,T,P,LB){ // monthly observation dates (independent-ish entry points)
  const ends=liveMonthEnds(T,LB*12+1).filter(d=>lfwd(d,0)<=T),o=[],beat=[];
  for(const st of ends){const en=lfwd(st,P);if(en>T||st<s.days[0])continue;const a=lon(s,st),z=lon(s,en);if(!fin(a)||!fin(z))continue;
    const r=(P===1?z/a-1:Math.pow(z/a,1/P)-1)*100;o.push(r);
    if(bs){const ba=lon(bs,st),bz=lon(bs,en);if(fin(ba)&&fin(bz)&&st>=bs.days[0]){const br=(P===1?bz/ba-1:Math.pow(bz/ba,1/P)-1)*100;beat.push(r>br);}}}
  if(o.length<6)return null;const q=[...o].sort((a,b)=>a-b),pq=p=>q[Math.min(q.length-1,Math.floor(p*(q.length-1)))];
  return{n:o.length,med:pq(.5),p25:pq(.25),p75:pq(.75),worst:q[0],avg:o.reduce((a,b)=>a+b,0)/o.length,pos:o.filter(x=>x>0).length/o.length*100,beat:beat.length?beat.filter(Boolean).length/beat.length*100:null};
}
function livePain(s,T,yrs=3){ // average fall below the running high, and share of days below it
  const a=lidx(s,lback(T,{years:yrs})),z=lidx(s,T);if(a<0||z-a<100)return null;
  let pk=s.vals[a],sum=0,under=0,n=0;for(let i=a;i<=z;i++){pk=Math.max(pk,s.vals[i]);const dd=s.vals[i]/pk-1;sum+=dd;if(dd<-0.02)under++;n++;}
  return{pain:-sum/n*100,under:under/n*100};
}
function liveConcentration(s,T,yrs=3){ // CAGR with the best / worst days removed (diagnostic path, not investable)
  const a=lidx(s,lback(T,{years:yrs})),z=lidx(s,T);if(a<0||z-a<250)return null;
  const r=[];for(let i=a+1;i<=z;i++)r.push(Math.log(s.vals[i]/s.vals[i-1]));const tot=r.reduce((x,y)=>x+y,0),so=[...r].sort((x,y)=>y-x),yr=(s.days[z]-s.days[a])/365;
  const cagr=lg=>(Math.exp(lg/yr)-1)*100,top=k=>so.slice(0,k).reduce((x,y)=>x+y,0),bot=k=>so.slice(-k).reduce((x,y)=>x+y,0);
  return{cagr:cagr(tot),exBest5:cagr(tot-top(5)),exBest10:cagr(tot-top(10)),exWorst5:cagr(tot-bot(5))};
}
function liveDownside(s,bs,T,n=36){ // months the benchmark fell
  if(!s||!bs)return null;const e=[...liveMonthEnds(T,n+1)];let down=0,less=0,pos=0,rel=0;
  for(let i=1;i<e.length;i++){const f0=lon(s,e[i-1]),f1=lon(s,e[i]),b0=lon(bs,e[i-1]),b1=lon(bs,e[i]);if(![f0,f1,b0,b1].every(fin)||e[i-1]<s.days[0])continue;
    const fr=f1/f0-1,br=b1/b0-1;if(br<0){down++;if(fr>br)less++;if(fr>0)pos++;rel+=(fr-br)*100;}}
  return down>=4?{down,less,pos,relAvg:rel/down,share:less/down*100}:null;
}
function liveIntel(name){ // everything the drawer card and the signals need, at the date shown
  const c=LIVE_MAP&&LIVE_MAP.get(name),s=c&&liveFund(c);if(!s)return null;
  const T=LIVE_T??lday(window.TCR_NAV.latest_nav_date),res=RES[name];
  const bn=res?benchKeyOf(fundBench(name,res.cat))||fundBench(name,res.cat):null,bs=bn?liveBenchSeries(bn,T):null;
  const cy=liveCycles(s,T),bcy=bs?liveCycles(bs,T):null;
  return{T,bn,r1:liveRollDist(s,bs,T,1,LIVE_RR_LB),r3:liveRollDist(s,bs,T,3,Math.max(LIVE_RR_LB,5)),pain:livePain(s,T),bpain:bs?livePain(bs,T):null,
    conc:liveConcentration(s,T),bconc:bs?liveConcentration(bs,T):null,down:liveDownside(s,bs,T),cy,bcy,style:/^Equity/.test(res?.homeCat||res?.cat||'')?liveStyle(c,T):null,mgr:liveMgrChange(name)};
}
function liveTags(name,I){ // behaviour fingerprint (a description, not a score)
  const t=[],d=RES[name]?.disp||{},uc=toN(d['UPSIDE CAPTURE']),dc=toN(d['DOWNSIDE CAPTURE']);
  if(I.r1&&I.r1.pos>=85&&I.r1.beat!=null&&I.r1.beat>=60&&I.pain&&I.bpain&&I.pain.pain<=I.bpain.pain)t.push(['Consistent compounder','positive in '+I.r1.pos.toFixed(0)+'% of 1Y windows, beat its benchmark in '+I.r1.beat.toFixed(0)+'%, shallower falls than the benchmark']);
  if((fin(dc)&&dc<85&&I.down&&I.down.share>=60)||(I.down&&I.down.share>=80))t.push(['Defensive','fell less than the benchmark in '+(I.down?I.down.less+' of '+I.down.down:'most')+' down months'+(fin(dc)?', downside capture '+dc.toFixed(0):'')]);
  if(fin(uc)&&fin(dc)&&uc>=110&&dc>=105)t.push(['High beta','upside capture '+uc.toFixed(0)+', downside capture '+dc.toFixed(0)+': amplifies the market both ways']);
  if(I.conc&&I.bconc){const f=I.conc.cagr-I.conc.exBest10,b=I.bconc.cagr-I.bconc.exBest10;  // CAGR lost without the 10 best days, fund vs benchmark
    if(f>b+3)t.push(['Return concentrated','losing its 10 best days cuts 3Y CAGR by '+f.toFixed(1)+' pts vs '+b.toFixed(1)+' for the benchmark']);}
  const last=I.cy?.cycles?.filter(x=>x.recovered).slice(-1)[0],blast=I.bcy?.cycles?.filter(x=>x.recovered).slice(-1)[0];
  if(last&&blast&&Math.abs(last.peak-blast.peak)<120&&(last.recovered-last.trough)<(blast.recovered-blast.trough)*0.8)t.push(['Recovery specialist','recovered its last major fall in '+Math.round((last.recovered-last.trough)/30.44)+' months vs '+Math.round((blast.recovered-blast.trough)/30.44)+' for the benchmark']);
  if(I.r1&&I.r1.beat!=null&&I.r1.beat<25&&RES[name]&&toN(RES[name].rawTr['3 YEARS'])>0)t.push(['Inconsistent','beat its benchmark in only '+I.r1.beat.toFixed(0)+'% of 1Y windows']);
  if(I.style&&I.style.d1!=null&&I.style.d1>=30&&I.style.now.r2>=0.85&&I.style.y1&&I.style.y1.r2>=0.85)t.push(['Style drift','effective large/mid/small mix moved '+I.style.d1.toFixed(0)+' pts in a year']);
  return t;
}
function liveIntelSection(name){
  if(!LIVE_HIST_READY||!window.TCR_NAV)return'';const I=liveIntel(name);if(!I)return'';
  const p=v=>fin(v)?v.toFixed(1)+'%':'—',col=v=>fin(v)&&v<0?'var(--red)':'var(--green)',tags=liveTags(name,I);
  const tg=tags.length?tags.map(([a,b])=>`<span title="${eh(b)}" style="display:inline-block;margin:0 6px 6px 0;padding:2px 8px;border-radius:10px;background:var(--bluelt);color:var(--blue);font-size:.66rem;font-weight:600;cursor:help">${a}</span>`).join(''):'<span style="color:var(--muted);font-size:.66rem">No distinctive pattern.</span>';
  const r=(x,l)=>x?dMini(l+' median',p(x.med),col(x.med))+dMini(l+' worst',p(x.worst),col(x.worst))+dMini(l+' positive',x.pos.toFixed(0)+'%')+dMini(l+' beat bench',x.beat!=null?x.beat.toFixed(0)+'%':'—'):'';
  const st=I.style,sty=st&&st.now?`${st.now.L.toFixed(0)}/${st.now.M.toFixed(0)}/${st.now.S.toFixed(0)}`:'—',sty1=st&&st.y1?`${st.y1.L.toFixed(0)}/${st.y1.M.toFixed(0)}/${st.y1.S.toFixed(0)}`:'—',sty3=st&&st.y3?`${st.y3.L.toFixed(0)}/${st.y3.M.toFixed(0)}/${st.y3.S.toFixed(0)}`:'—';
  const h=liveTSHistory(name),rep=h.length?h[h.length-1].v:null,mand=LIVE_MANDATE[RES[name]?.homeCat];
  let mandTxt='';if(rep&&mand){const chk=Array.isArray(mand[0])?mand:[mand];const bad=chk.filter(([i,min])=>fin(rep[i])&&rep[i]<min);mandTxt=bad.length?`<span style="color:var(--red)">below SEBI minimum: ${bad.map(([i,min])=>['','large','mid','small'][i]+' '+rep[i].toFixed(1)+'% (min '+min+'%)').join(', ')}</span>`:'<span style="color:var(--green)">within SEBI minimums</span>';}
  const mg=I.mgr?(I.mgr.none?`no change in ${I.mgr.months} monthly files`:`<b style="color:var(--orange)">changed ${I.mgr.when}</b>: ${eh(I.mgr.from)} → ${eh(I.mgr.to)}`):'needs two monthly Top Schemes files';
  return`<div class="drw-sec"><div class="drw-sec-lbl">🧭 Fund intelligence <span style="font-weight:400;color:var(--muted)">(daily NAVs to ${liveISO(I.T)}${I.bn?' · vs '+eh(I.bn):''})</span></div>
  <div style="margin-bottom:4px">${tg}</div>
  <div style="font-size:.64rem;color:var(--muted);margin:4px 0">Rolling returns, monthly entry points, last ${LIVE_RR_LB} years (3Y: last ${Math.max(LIVE_RR_LB,5)})</div>
  <div class="d-mini-grid">${r(I.r1,'1Y')}${r(I.r3,'3Y')}</div>
  <div class="d-mini-grid" style="margin-top:6px">${dMini('Pain index 3Y',I.pain?I.pain.pain.toFixed(1)+'%':'—')}${dMini('Bench pain 3Y',I.bpain?I.bpain.pain.toFixed(1)+'%':'—')}
  ${dMini('Days >2% below high',I.pain?I.pain.under.toFixed(0)+'%':'—')}${dMini('Down months fell less',I.down?I.down.less+' of '+I.down.down:'—')}
  ${dMini('3Y CAGR · w/o 10 best days',I.conc?p(I.conc.cagr)+' · '+p(I.conc.exBest10):'—')}${dMini('Bench · w/o 10 best days',I.bconc?p(I.bconc.cagr)+' · '+p(I.bconc.exBest10):'—')}</div>
  <div style="font-size:.68rem;margin-top:8px;line-height:1.6">
   <div><span style="color:var(--muted)">Style from NAV (large/mid/small):</span> now <b>${sty}</b> · 1Y ago ${sty1} · 3Y ago ${sty3}${st&&st.now?` <span style="color:var(--muted)">(fit R² ${st.now.r2.toFixed(2)}${st.d1!=null?', drift '+st.d1.toFixed(0)+' pts in 1Y':''})</span>`:''}</div>
   <div><span style="color:var(--muted)">Reported portfolio:</span> ${rep?`${fin(rep[1])?rep[1].toFixed(0):'—'}/${fin(rep[2])?rep[2].toFixed(0):'—'}/${fin(rep[3])?rep[3].toFixed(0):'—'} ${mandTxt}`:'—'}</div>
   <div><span style="color:var(--muted)">Fund manager:</span> ${rep?eh(rep[0]):'—'} · ${mg}</div></div></div>`;
}

// ── signals ──
function liveSignalRows(){
  const D=LIVE_SH.dates,L=D[D.length-1],at=k=>{const t=lback(L,{months:k});let b=null;for(const d of D)if(d<=t)b=d;return b;};
  const d6=at(6),d12=at(12),H=LIVE_SH.H,pos=v=>v&&v[5]&&v[6]>1?1-(v[5]-1)/(v[6]-1):NaN;
  const byCat={};for(const r of allResults)if(fin(r.composite))(byCat[r.cat]=byCat[r.cat]||[]).push(r);
  const T=L,mrows={};for(const x of liveMonthlyRows(T))mrows[x['SCHEME NAME']]=x;
  const lastM=livePeriods(T,'M',7).slice(0,6).map(p=>p.key),pil=[['Trailing',1,LIVE_W.t],['Calendar',2,LIVE_W.c],['Risk',3,LIVE_W.r],['Consistency',4,LIVE_W.k]];
  const rows=[];
  for(const[cat,rs]of Object.entries(byCat)){
    const r3=rs.map(r=>r.rawTr['3 YEARS']),r6=rs.map(r=>r.rawTr['6 MONTHS']),bn=getBench(cat),bm=mrows[benchKeyOf(bn)||bn];
    for(const r of rs){
      const now=H[L]?.[r.name],p6=d6!=null?H[d6]?.[r.name]:null,p12=d12!=null?H[d12]?.[r.name]:null;if(!now)continue;
      const fm=mrows[r.name];let hits=null,ok=0,ex6=null;
      if(fm&&bm){const ks=lastM.filter(k=>fin(fm[k])&&fin(bm[k]));if(ks.length>=6){ok=ks.length;hits=ks.filter(k=>fm[k]>bm[k]).length;
        ex6=(ks.reduce((a,k)=>a*(1+fm[k]/100),1)-ks.reduce((a,k)=>a*(1+bm[k]/100),1))*100;}}
      let drv='—';if(p6){const ds=pil.map(([l,i,w])=>fin(now[i])&&fin(p6[i])?[l,(now[i]-p6[i])*w]:null).filter(Boolean).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));if(ds[0])drv=ds[0][0]+' '+(ds[0][1]>=0?'+':'')+ds[0][1].toFixed(1);}
      rows.push({n:r.name,cat:r.catLbl||cat,s:now[0],ds6:p6?now[0]-p6[0]:NaN,ds12:p12?now[0]-p12[0]:NaN,pos:pos(now),pos6:pos(p6),pos12:pos(p12),
        rk:now[5]+'/'+now[6],rk6:p6?p6[5]+'/'+p6[6]:'—',rk12:p12?p12[5]+'/'+p12[6]:'—',p3:lpct(r.rawTr['3 YEARS'],r3),p6m:lpct(r.rawTr['6 MONTHS'],r6),hits,ok,ex6,drv});
    }
  }
  return rows;
}
function liveSignals(){
  if(!LIVE_SH||LIVE_SH.sig!==liveSHSig())
    return`<p class="lm-p">Signals need the score history (TCR re-scored at past month-ends).</p><button class="lp-btn" onclick="liveBuildScoreHistory().then(()=>liveModal('Signals',liveSignals()))">Build score history (~1 minute)</button>`;
  const rows=liveSignalRows(),L=LIVE_SH.dates[LIVE_SH.dates.length-1];
  // every signal needs evidence from returns as well as from the score; missing data never qualifies
  const rising=rows.filter(r=>r.ds6>=10&&r.pos>=0.6&&fin(r.p6m)&&r.p6m>=0.5&&r.ex6!=null&&r.ex6>0).sort((a,b)=>b.ds6-a.ds6).slice(0,25);
  const turn=rows.filter(r=>fin(r.p3)&&r.p3<0.5&&fin(r.pos12)&&r.pos12<0.4&&r.ds6>=8&&fin(r.p6m)&&r.p6m>=0.75&&r.hits!=null&&r.hits>=4).sort((a,b)=>b.ds6-a.ds6).slice(0,25);
  const fading=rows.filter(r=>r.pos>=0.6&&r.ds6<=-10).sort((a,b)=>a.ds6-b.ds6).slice(0,25);
  const early=[],recov=[],drift=[],mgr=[];
  for(const r of rows){
    const I=liveIntel(r.n);if(!I)continue;
    if(r.pos>=0.6&&!(r.ds6<=-10)){const why=[];
      if(fin(r.p6m)&&r.p6m<0.5)why.push('6M return below category median');
      if(r.hits!=null&&r.hits<=2)why.push(`beat benchmark in only ${r.hits}/6 months`);
      if(I.cy&&I.bcy&&I.cy.current<I.bcy.current-3)why.push(`${(-I.cy.current).toFixed(1)}% below its high vs ${(-I.bcy.current).toFixed(1)}% for the benchmark`);
      if(I.down&&I.down.share<40)why.push(`fell less than the benchmark in only ${I.down.less}/${I.down.down} down months`);
      if(why.length>=2)early.push({...r,why:why.join('; ')});}
    const big=I.cy?.cycles?.filter(x=>x.fall<=-15&&x.peak>=lback(I.T,{years:3})).slice(-1)[0];
    if(big){const s=liveFund(LIVE_MAP.get(r.n)),pk=lon(s,big.peak),tr=lon(s,big.trough),nw=lon(s,I.T),rec=(nw-tr)/(pk-tr)*100;
      let brec=null;const bn=I.bn&&liveBenchSeries(I.bn,I.T);if(bn){const bp=lon(bn,big.peak),bt=lon(bn,big.trough),bw=lon(bn,I.T);if([bp,bt,bw].every(fin)&&bp>bt)brec=(bw-bt)/(bp-bt)*100;}
      if(rec>=80&&(brec==null||rec>brec))recov.push({...r,fall:big.fall,rec,brec,mo:Math.round(((big.recovered||I.T)-big.trough)/30.44),done:!!big.recovered});}
    if(I.style&&I.style.d1!=null&&I.style.d1>=30&&I.style.now.r2>=0.85&&I.style.y1&&I.style.y1.r2>=0.85)drift.push({...r,st:I.style});
    if(I.mgr&&!I.mgr.none)mgr.push({...r,m:I.mgr});
  }
  const head=(extra)=>`<tr><th>Fund</th><th>Category</th><th>Score</th><th>Δ 6M</th><th>Driver</th><th>Rank now</th><th>6M ago</th><th>12M ago</th>${extra||''}</tr>`;
  const base=r=>`<td>${lnk(r.n)}</td><td>${eh(r.cat)}</td><td>${lf(r.s)}</td><td class="${r.ds6>=0?'lm-up':'lm-dn'}">${lf(r.ds6)}</td><td>${r.drv}</td><td>${r.rk}</td><td>${r.rk6}</td><td>${r.rk12}</td>`;
  const pc=v=>fin(v)?Math.round(v*100):'—',ex=r=>r.ex6!=null?((r.ex6>=0?'+':'')+r.ex6.toFixed(1)):'—';
  const tbl=(list,ext,cell)=>list.length?`<table class="lm-t">${head(ext)}${list.map(r=>`<tr>${base(r)}${cell?cell(r):''}</tr>`).join('')}</table>`:'<p class="lm-p">None right now.</p>';
  const st=x=>x?`${x.L.toFixed(0)}/${x.M.toFixed(0)}/${x.S.toFixed(0)}`:'—';
  return`<p class="lm-p">Signals from TCR's own scores at past month-ends (to ${liveISO(L)}), each confirmed by the fund's actual returns. Click a fund to open it. "Driver" = the pillar that moved the score most over 6 months (points of final score).</p>
  <h4>🚀 Rising stars <span class="lm-s">score up ≥10 in 6 months · now top 40% of category · 6M return at or above category median · ahead of benchmark over 6 months</span></h4>
  ${tbl(rising,'<th>6M pct</th><th>6M vs bench</th>',r=>`<td>${pc(r.p6m)}</td><td class="${r.ex6>=0?'lm-up':'lm-dn'}">${ex(r)}</td>`)}
  <h4>🔄 Turnaround candidates <span class="lm-s">weak 3Y record (bottom half) · was bottom 40% a year ago · score up ≥8 in 6 months · top-quartile 6M return · beat benchmark in ≥4 of the last 6 months</span></h4>
  ${tbl(turn,'<th>3Y pct</th><th>6M pct</th><th>Months beat</th><th>6M vs bench</th>',r=>`<td>${pc(r.p3)}</td><td>${pc(r.p6m)}</td><td>${r.hits}/6</td><td class="${r.ex6>=0?'lm-up':'lm-dn'}">${ex(r)}</td>`)}
  <h4>⚠️ Fading <span class="lm-s">still top 40% · score down ≥10 in 6 months</span></h4>${tbl(fading)}
  <h4>🟠 Early deterioration <span class="lm-s">top 40%, not yet fading, but at least two warning signs in its returns</span></h4>
  ${tbl(early.sort((a,b)=>a.ds6-b.ds6).slice(0,25),'<th>Warning signs</th>',r=>`<td style="white-space:normal;max-width:380px">${eh(r.why)}</td>`)}
  <h4>💪 Recovery leaders <span class="lm-s">fell ≥15% in the last 3 years and has recovered ≥80% of it, faster than its benchmark</span></h4>
  ${tbl(recov.sort((a,b)=>b.rec-a.rec).slice(0,25),'<th>Fall</th><th>Recovered</th><th>Bench recovered</th><th>Months</th>',r=>`<td class="lm-dn">${r.fall.toFixed(1)}%</td><td>${r.rec>=100?'new high':r.rec.toFixed(0)+'%'}</td><td>${r.brec!=null?(r.brec>=100?'new high':r.brec.toFixed(0)+'%'):'—'}</td><td>${r.mo}${r.done?'':'+'}</td>`)}
  <h4>🧭 Style drift <span class="lm-s">effective large/mid/small mix from daily NAV returns moved ≥30 pts in a year (fit R² ≥ 0.85 at both dates)</span></h4>
  ${tbl(drift.sort((a,b)=>b.st.d1-a.st.d1).slice(0,25),'<th>Now L/M/S</th><th>1Y ago</th><th>3Y ago</th><th>Drift</th>',r=>`<td>${st(r.st.now)}</td><td>${st(r.st.y1)}</td><td>${st(r.st.y3)}</td><td>${r.st.d1.toFixed(0)} pts</td>`)}
  <h4>👤 Fund manager changes <span class="lm-s">between monthly Top Schemes files (${Object.keys(LIVE_TS).length} saved so far)</span></h4>
  ${tbl(mgr,'<th>When</th><th>From → to</th>',r=>`<td>${r.m.when}</td><td style="white-space:normal">${eh(r.m.from)} → ${eh(r.m.to)}</td>`)}
  <h4>🧪 Does TCR pick winners?</h4>${liveBacktest()}`;
}

// ── backtest: score levels, score changes, market conditions ──
function liveBacktest(){
  const D=LIVE_SH.dates,L=D[D.length-1],H=LIVE_SH.H,cat={};for(const r of allResults)cat[r.name]=r.catLbl||r.cat;
  const fwd=(n,d,m)=>{const c=LIVE_MAP.get(n),s=c&&liveFund(c);if(!s)return NaN;const e=lback(d,{months:-m});if(e>L)return NaN;const a=lon(s,d),z=lon(s,e);return fin(a)&&fin(z)&&a>0?(z/a-1)*100:NaN;};
  const mkt=liveBenchSeries('NSE Nifty 500 TRI',L),regime=d=>{if(!mkt)return'—';const a=lon(mkt,lback(d,{months:6})),z=lon(mkt,d);return fin(a)&&fin(z)?(z>a?'rising':'falling'):'—';};
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN,pct=a=>a.length?Math.round(a.filter(Boolean).length/a.length*100):NaN;
  const lvl=[],byReg={rising:[],falling:[]},byYear={},byCat={},chg=[];
  for(const d of D){
    const snap=H[d];if(!snap||lback(d,{months:-12})>L)continue;
    const groups={};for(const[n,v]of Object.entries(snap)){if(!fin(v[0])||!cat[n])continue;const r=fwd(n,d,12);if(fin(r))(groups[cat[n]]=groups[cat[n]]||[]).push({n,s:v[0],r});}
    for(const[c,g]of Object.entries(groups)){
      if(g.length<8)continue;const m=avg(g.map(x=>x.r)),q=Math.max(2,Math.floor(g.length/4));
      const byS=[...g].sort((a,b)=>b.s-a.s),byR=[...g].sort((a,b)=>b.r-a.r),futTop=new Set(byR.slice(0,q).map(x=>x.n)),futHalf=new Set(byR.slice(0,Math.ceil(g.length/2)).map(x=>x.n));
      const top=byS.slice(0,q),bot=byS.slice(-q),o={d,c,top:avg(top.map(x=>x.r))-m,bot:avg(bot.map(x=>x.r))-m,prec:top.filter(x=>futTop.has(x.n)).length/q,half:top.filter(x=>futHalf.has(x.n)).length/q};
      lvl.push(o);const rg=regime(d);if(byReg[rg])byReg[rg].push(o);(byYear[ldate(d).y]=byYear[ldate(d).y]||[]).push(o);(byCat[c]=byCat[c]||[]).push(o);
    }
  }
  // score change over the previous 3 months → next 3/6/12-month return vs category average
  for(let i=0;i<D.length;i++){const d=D[i],p=D.find(x=>x>=lback(d,{months:3})&&x<d);if(p==null||!H[d]||!H[p])continue;
    const groups={};for(const[n,v]of Object.entries(H[d])){const pv=H[p][n];if(!pv||!fin(v[0])||!fin(pv[0])||!cat[n])continue;(groups[cat[n]]=groups[cat[n]]||[]).push({n,ds:v[0]-pv[0]});}
    for(const g of Object.values(groups)){if(g.length<8)continue;
      for(const h of[3,6,12]){const rs=g.map(x=>({...x,r:fwd(x.n,d,h)})).filter(x=>fin(x.r));if(rs.length<8)continue;const m=avg(rs.map(x=>x.r));for(const x of rs)chg.push({h,ds:x.ds,ex:x.r-m});}}}
  if(!lvl.length)return'<p class="lm-p">Not enough history yet.</p>';
  const s=v=>fin(v)?(v>=0?'+':'')+v.toFixed(2):'—',c=v=>v>=0?'lm-up':'lm-dn',sum=a=>({top:avg(a.map(x=>x.top)),bot:avg(a.map(x=>x.bot)),hit:pct(a.map(x=>x.top>0)),prec:avg(a.map(x=>x.prec))*100,half:avg(a.map(x=>x.half))*100,n:a.length});
  const A=sum(lvl),row=(lbl,x)=>`<tr><td>${lbl}</td><td>${x.n}</td><td class="${c(x.top)}">${s(x.top)}</td><td>${x.hit}%</td><td>${x.prec.toFixed(0)}%</td><td>${x.half.toFixed(0)}%</td><td class="${c(x.bot)}">${s(x.bot)}</td></tr>`;
  const th='<tr><th></th><th>Cases</th><th>Top quarter vs cat. avg (pts, next 12M)</th><th>Beat avg</th><th>Ended in future top quarter (random 25%)</th><th>Ended in top half (random 50%)</th><th>Bottom quarter vs avg</th></tr>';
  const buckets=[['score fell ≥10',-1e9,-10],['fell 5–10',-10,-5],['roughly flat (±5)',-5,5],['rose 5–10',5,10],['rose ≥10',10,1e9]];
  const ct=buckets.map(([l,a,b])=>{const cells=[3,6,12].map(h=>{const x=chg.filter(o=>o.h===h&&o.ds>=a&&o.ds<b);return x.length?`<td class="${c(avg(x.map(o=>o.ex)))}">${s(avg(x.map(o=>o.ex)))}</td>`:'<td>—</td>';}).join('');const n=chg.filter(o=>o.h===12&&o.ds>=a&&o.ds<b).length;return`<tr><td>${l}</td><td>${n}</td>${cells}</tr>`;}).join('');
  const cats=Object.entries(byCat).filter(([,v])=>v.length>=6).map(([k,v])=>[k,sum(v)]).sort((a,b)=>b[1].top-a[1].top);
  return`<p class="lm-p">Every past month-end with 12 months of future data, within each category of 8+ funds. <b>Top quarter by TCR score beat the category average by ${s(A.top)} pts over the next 12 months, in ${A.hit}% of cases</b>; ${A.prec.toFixed(0)}% of TCR's top quarter ended in the future top quarter (random: 25%) and ${A.half.toFixed(0)}% in the top half (random: 50%).
  <span class="lm-s">Caveats: only funds alive today are in the data (closed funds missing, which flatters the bottom of each category); past scores use today's file for corpus, ratings and categories; fund age, returns, benchmarks and risk ratios are as of each date.</span></p>
  <table class="lm-t">${th}${row('All',A)}${['rising','falling'].map(k=>byReg[k].length?row('Nifty 500 '+k+' over prior 6M',sum(byReg[k])):'').join('')}${Object.keys(byYear).sort().map(y=>row(y,sum(byYear[y]))).join('')}</table>
  <h4>Does a changing score lead returns? <span class="lm-s">score change over the previous 3 months → return vs category average afterwards (pts)</span></h4>
  <table class="lm-t"><tr><th>Score change (3M)</th><th>Cases</th><th>Next 3M</th><th>Next 6M</th><th>Next 12M</th></tr>${ct}</table>
  <h4>By category</h4><table class="lm-t">${th}${cats.map(([k,x])=>row(eh(k),x)).join('')}</table>`;
}

let LIVE_RR_KEY=null;
const _liveRunModel=runModel;
runModel=async function(keepView){
  // TCR decides which calendar year is still running from CY_ASON (the file title's date);
  // with live data on, the date being shown is the as-of date.
  const savedAsOn=CY_ASON,savedMo=SLOTS.mo,savedCap=[TS_CAPTURE,TS_CAPTURE_NK];
  if(LIVE_ON&&window.TCR_NAV){
    const iso=LIVE_T!=null?liveISO(LIVE_T):window.TCR_NAV.latest_nav_date;const[y,m,d]=iso.split('-').map(Number);CY_ASON=new Date(y,m-1,d);
    // Captures: past dates always, and latest when chosen, use TCR's own formula on NAV monthly returns
    if(LIVE_HIST_READY&&(LIVE_CAP==='nav'||LIVE_T!=null)){
      if(!LIVE_MAP)LIVE_MAP=new Map();
      SLOTS.mo={data:liveMonthlyRows(lday(iso)),name:'AMFI NAV monthly returns',count:1,asOn:new Date(y,m-1,d)};
      TS_CAPTURE={};TS_CAPTURE_NK={};
    }
  }
  try{await _liveRunModel(keepView);}finally{CY_ASON=savedAsOn;SLOTS.mo=savedMo;TS_CAPTURE=savedCap[0];TS_CAPTURE_NK=savedCap[1];}
  if(LIVE_SILENT)return;
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
  try{
    const body=document.getElementById('drw-body'),h1=liveScoreSection(name)+liveIntelSection(name),h2=liveDrawerSection(name);
    // score history right after TCR's pillar block; corrections at the end
    const pil=[...body.children].find(el=>/pillar scores/i.test(el.textContent||''));
    if(h1){if(pil)pil.insertAdjacentHTML('afterend',h1);else body.insertAdjacentHTML('beforeend',h1);}
    if(h2)body.insertAdjacentHTML('beforeend',h2);
  }catch(e){console.warn('[live] drawer',e);}
};
// After the feed loads, fetch the NAV history in the background, then re-run once so rolling
// returns, blank ratios and drawdowns appear.
LIVE_READY.then(async ok=>{
  if(!ok)return;await liveTSLoadAll();await liveLoadHistory();liveBadge();
  const wait=()=>new Promise(r=>{let n=0;const t=setInterval(()=>{n++;if((!LOAD_PENDING&&typeof allResults!=='undefined'&&allResults.length)||n>600){clearInterval(t);r();}},200);});
  await wait();
  if(LIVE_ON&&cyRaw&&trRaw&&document.getElementById('dashboard').style.display!=='none'){await runModel(true);if(typeof applyFilters==='function')applyFilters();}
});
// ═══ end LIVE ENGINE ═══
