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
  return[f,trRaw?trRaw.length:0,cyRaw?cyRaw.length:0,LIVE_GRAN,LIVE_CAP,LIVE_RF_USER??'',INCLUDE_PASSIVE?1:0,INCLUDE_FOF?1:0].join('#');
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
function liveSignals(){
  if(!LIVE_SH||LIVE_SH.sig!==liveSHSig())
    return`<p class="lm-p">Signals need the score history (TCR re-scored at past month-ends).</p><button class="lp-btn" onclick="liveBuildScoreHistory().then(()=>liveModal('Signals',liveSignals()))">Build score history (~1 minute)</button>`;
  const D=LIVE_SH.dates,L=D[D.length-1],at=k=>{const t=lback(L,{months:k});let b=null;for(const d of D)if(d<=t)b=d;return b;};
  const d6=at(6),d12=at(12),H=LIVE_SH.H;
  const pos=v=>v&&v[5]&&v[6]>1?1-(v[5]-1)/(v[6]-1):NaN;
  const byCat={};for(const r of allResults)if(fin(r.composite))(byCat[r.cat]=byCat[r.cat]||[]).push(r);
  const T=L,mrows={};for(const x of liveMonthlyRows(T))mrows[x['SCHEME NAME']]=x;
  const lastM=livePeriods(T,'M',7).slice(0,6).map(p=>p.key); // last 6 complete months
  const rows=[];
  for(const[cat,rs]of Object.entries(byCat)){
    const r3=rs.map(r=>r.rawTr['3 YEARS']),r6=rs.map(r=>r.rawTr['6 MONTHS']);
    const bn=getBench(cat),bm=mrows[benchKeyOf(bn)||bn];
    for(const r of rs){
      const now=H[L]?.[r.name],p6=d6!=null?H[d6]?.[r.name]:null,p12=d12!=null?H[d12]?.[r.name]:null;if(!now)continue;
      const fm=mrows[r.name];let hit=null;
      if(fm&&bm){const ok=lastM.filter(k=>fin(fm[k])&&fin(bm[k]));if(ok.length>=4)hit=ok.filter(k=>fm[k]>bm[k]).length+'/'+ok.length;}
      rows.push({n:r.name,cat:r.catLbl||cat,s:now[0],ds6:p6?now[0]-p6[0]:NaN,ds12:p12?now[0]-p12[0]:NaN,pos:pos(now),pos6:pos(p6),pos12:pos(p12),
        rk:now[5]+'/'+now[6],rk6:p6?p6[5]+'/'+p6[6]:'—',rk12:p12?p12[5]+'/'+p12[6]:'—',p3:lpct(r.rawTr['3 YEARS'],r3),p6m:lpct(r.rawTr['6 MONTHS'],r6),hit,hitN:hit?+hit.split('/')[0]/+hit.split('/')[1]:NaN});
    }
  }
  const rising=rows.filter(r=>r.ds6>=10&&r.pos>=0.6).sort((a,b)=>b.ds6-a.ds6).slice(0,25);
  const turn=rows.filter(r=>r.p3<0.5&&(r.pos12<0.4||!fin(r.pos12))&&r.ds6>=8&&r.p6m>=0.75&&(r.hitN>=4/6||!fin(r.hitN))).sort((a,b)=>b.ds6-a.ds6).slice(0,25);
  const fading=rows.filter(r=>r.pos>=0.6&&r.ds6<=-10).sort((a,b)=>a.ds6-b.ds6).slice(0,25);
  const tbl=(list,extra)=>list.length?`<table class="lm-t"><tr><th>Fund</th><th>Category</th><th>Score</th><th>Δ 6M</th><th>Δ 12M</th><th>Rank now</th><th>6M ago</th><th>12M ago</th>${extra?'<th>3Y pct</th><th>6M pct</th><th>Beat bench (6 mo)</th>':''}</tr>
    ${list.map(r=>`<tr><td>${lnk(r.n)}</td><td>${eh(r.cat)}</td><td>${lf(r.s)}</td><td class="${r.ds6>=0?'lm-up':'lm-dn'}">${lf(r.ds6)}</td><td class="${r.ds12>=0?'lm-up':'lm-dn'}">${lf(r.ds12)}</td><td>${r.rk}</td><td>${r.rk6}</td><td>${r.rk12}</td>${extra?`<td>${fin(r.p3)?Math.round(r.p3*100):'—'}</td><td>${fin(r.p6m)?Math.round(r.p6m*100):'—'}</td><td>${r.hit||'—'}</td>`:''}</tr>`).join('')}</table>`:'<p class="lm-p">None right now.</p>';
  // backtest: top vs bottom quartile by TCR score at each past month-end, next-12-month return vs category average
  const bt=liveBacktest();
  return`<p class="lm-p">From TCR's own scores at past month-ends (score history to ${liveISO(L)}). Click a fund to open it.</p>
  <h4>🚀 Rising stars <span class="lm-s">score up ≥10 in 6 months, now in the top 40% of its category</span></h4>${tbl(rising)}
  <h4>🔄 Turnaround candidates <span class="lm-s">weak 3Y record (bottom half), was bottom 40% a year ago, score up ≥8 in 6 months, top-quartile 6-month return, beat its benchmark in ≥4 of the last 6 months</span></h4>${tbl(turn,true)}
  <h4>⚠️ Fading <span class="lm-s">still in the top 40% but score down ≥10 in 6 months</span></h4>${tbl(fading)}
  <h4>🧪 Does TCR pick winners? <span class="lm-s">backtest of the score history</span></h4>${bt}`;
}
function liveBacktest(){
  const D=LIVE_SH.dates,L=D[D.length-1],H=LIVE_SH.H;
  const fwd=(n,d)=>{const c=LIVE_MAP.get(n),s=c&&liveFund(c);if(!s)return NaN;const a=lon(s,d),e=lfwd(d,1);if(e>L)return NaN;const z=lon(s,e);return fin(a)&&fin(z)&&a>0?(z/a-1)*100:NaN;};
  const cat={};for(const r of allResults)cat[r.name]=r.catLbl||r.cat;
  const per=[];const byCat={};
  for(const d of D){
    if(lfwd(d,1)>L)continue;const snap=H[d];if(!snap)continue;
    const groups={};for(const[n,v]of Object.entries(snap)){if(!fin(v[0])||!cat[n])continue;const r=fwd(n,d);if(!fin(r))continue;(groups[cat[n]]=groups[cat[n]]||[]).push([v[0],r]);}
    for(const[c,g]of Object.entries(groups)){
      if(g.length<8)continue;g.sort((a,b)=>b[0]-a[0]);const q=Math.max(2,Math.floor(g.length/4));
      const avg=a=>a.reduce((x,y)=>x+y,0)/a.length,m=avg(g.map(x=>x[1])),top=avg(g.slice(0,q).map(x=>x[1]))-m,bot=avg(g.slice(-q).map(x=>x[1]))-m;
      per.push({d,c,top,bot});(byCat[c]=byCat[c]||[]).push({top,bot});
    }
  }
  if(!per.length)return'<p class="lm-p">Not enough history yet.</p>';
  const avg=a=>a.reduce((x,y)=>x+y,0)/a.length,hit=a=>Math.round(a.filter(x=>x>0).length/a.length*100);
  const dates=new Set(per.map(p=>p.d)).size;
  const cats=Object.entries(byCat).filter(([,v])=>v.length>=6).map(([c,v])=>({c,n:v.length,top:avg(v.map(x=>x.top)),bot:avg(v.map(x=>x.bot)),h:hit(v.map(x=>x.top))})).sort((a,b)=>b.top-a.top);
  return`<p class="lm-p">At each of ${dates} past month-ends, within every category with 8+ funds: the top quarter by TCR score vs the bottom quarter, next-12-month return minus the category average.
  <b>Top quarter: ${(avg(per.map(p=>p.top))>=0?'+':'')+avg(per.map(p=>p.top)).toFixed(2)} pts/yr</b> (beat the category in ${hit(per.map(p=>p.top))}% of cases) ·
  <b>bottom quarter: ${(avg(per.map(p=>p.bot))>=0?'+':'')+avg(per.map(p=>p.bot)).toFixed(2)} pts/yr</b>.
  <span class="lm-s">Caveats: only funds alive today are in the data (closed funds are missing), and past scores use today's file for corpus, ratings and categories.</span></p>
  <table class="lm-t"><tr><th>Category</th><th>Month-ends</th><th>Top quarter vs avg</th><th>Beat avg</th><th>Bottom quarter vs avg</th></tr>${cats.map(x=>`<tr><td>${eh(x.c)}</td><td>${x.n}</td><td class="${x.top>=0?'lm-up':'lm-dn'}">${(x.top>=0?'+':'')+x.top.toFixed(2)}</td><td>${x.h}%</td><td class="${x.bot>=0?'lm-up':'lm-dn'}">${(x.bot>=0?'+':'')+x.bot.toFixed(2)}</td></tr>`).join('')}</table>`;
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
    const body=document.getElementById('drw-body'),h1=liveScoreSection(name),h2=liveDrawerSection(name);
    // score history right after TCR's pillar block; corrections at the end
    const pil=[...body.children].find(el=>/pillar scores/i.test(el.textContent||''));
    if(h1){if(pil)pil.insertAdjacentHTML('afterend',h1);else body.insertAdjacentHTML('beforeend',h1);}
    if(h2)body.insertAdjacentHTML('beforeend',h2);
  }catch(e){console.warn('[live] drawer',e);}
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
