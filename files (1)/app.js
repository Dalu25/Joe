/* ============================== CONSTANTS ============================== */
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TRADE_HEADERS = ['Timestamp','Date','Account','Session','Setup','Direction','Entry','SL','TP1','TP2','RiskUSD','Outcome','R','CSD','SMT','Notes','Mood'];
const MOOD_OPTIONS = [
  {label:'😄 Great', value:'Great', score:5},
  {label:'🙂 Good', value:'Good', score:4},
  {label:'😐 Neutral', value:'Neutral', score:3},
  {label:'😕 Off', value:'Off', score:2},
  {label:'😣 Tilted', value:'Tilted', score:1},
];
function moodScore(v){ const m = MOOD_OPTIONS.find(o=>o.value===v); return m ? m.score : null; }
const MISSED_HEADERS = ['Timestamp','Account','Session','Setup','Direction','Reason','WouldHitFullTP','Notes'];
const ACCOUNT_HEADERS = ['Name','DDLimit','DailyRiskCap','TargetMin','TargetMax'];
const SESSIONS = ['Asia','London','NY AM','NY PM'];
const SETUPS = ['OTE','Model-1','KOD','Turtle Soup','CRT Continuation (FTM+CSD)','Other'];
const DEFAULT_ACCOUNTS = [
  {name:'Account 1 (Consistency Rule)', ddLimit:'', dailyRiskCap:'', targetMin:'', targetMax:''},
  {name:'Account 2 (No Rule)', ddLimit:'600', dailyRiskCap:'50', targetMin:'70', targetMax:'100'},
];

let tokenClient = null;

/* ============================== UTIL ============================== */
function $(sel, root){ return (root||document).querySelector(sel); }
function el(tag, attrs, children){
  const e = document.createElement(tag);
  attrs = attrs || {};
  for(const k in attrs){
    if(k === 'class') e.className = attrs[k];
    else if(k === 'html') e.innerHTML = attrs[k];
    else if(k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (children||[]).forEach(c => { if(c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return e;
}
function toast(msg, kind){
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(()=> t.className = 'toast', 2600);
}
function saveCfg(){
  localStorage.setItem('crt_client_id', CFG.clientId);
  localStorage.setItem('crt_sheet_id', CFG.sheetId);
}
function nowIso(){ return new Date().toISOString(); }
function estDateString(d){
  d = d || new Date();
  return new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false}).format(d).replace(',', '');
}
function fmtR(v){
  const n = Number(v);
  if(isNaN(n)) return '—';
  const s = (n>0?'+':'') + n.toFixed(2) + 'R';
  return s;
}
function csvSafe(v){ return (v===undefined||v===null) ? '' : String(v); }

/* ============================== GOOGLE AUTH ============================== */
function initGIS(){
  if(!window.google || !CFG.clientId) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.clientId,
    scope: SCOPE,
    callback: async (resp) => {
      if(resp.error){ toast('Sign-in failed: ' + resp.error, 'err'); return; }
      STATE.token = resp.access_token;
      STATE.tokenExp = Date.now() + (Number(resp.expires_in||3300) * 1000);
      sessionStorage.setItem('crt_token', STATE.token);
      sessionStorage.setItem('crt_token_exp', String(STATE.tokenExp));
      STATE.signedIn = true;
      await bootstrapAfterAuth();
    },
  });
}
function requestSignIn(){
  if(!tokenClient){ initGIS(); }
  if(!tokenClient){ toast('Google script still loading, try again in a moment', 'err'); return; }
  tokenClient.requestAccessToken({ prompt: STATE.token ? '' : 'consent' });
}
function signOut(){
  if(STATE.token){ try{ google.accounts.oauth2.revoke(STATE.token, ()=>{}); }catch(e){} }
  STATE.token = null; STATE.signedIn = false;
  sessionStorage.removeItem('crt_token'); sessionStorage.removeItem('crt_token_exp');
  render();
}
function tokenValid(){ return STATE.token && Date.now() < (STATE.tokenExp - 30000); }

/* ============================== SHEETS API ============================== */
async function sheetsFetch(path, opts){
  opts = opts || {};
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + CFG.sheetId + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + STATE.token,
      'Content-Type': 'application/json',
      ...(opts.headers||{}),
    },
  });
  if(res.status === 401){
    STATE.signedIn = false; STATE.token = null;
    throw new Error('Session expired — please sign in again.');
  }
  if(!res.ok){
    const body = await res.text();
    throw new Error('Sheets API error (' + res.status + '): ' + body.slice(0,200));
  }
  return res.status === 204 ? null : res.json();
}
async function getMeta(){ return sheetsFetch(''); }
async function getValues(range){
  const d = await sheetsFetch('/values/' + encodeURIComponent(range));
  return (d && d.values) || [];
}
async function updateValues(range, values){
  return sheetsFetch('/values/' + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED', {
    method:'PUT', body: JSON.stringify({ range, values }),
  });
}
async function appendValues(range, values){
  return sheetsFetch('/values/' + encodeURIComponent(range) + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', {
    method:'POST', body: JSON.stringify({ range, values }),
  });
}
async function batchUpdate(requests){
  return sheetsFetch(':batchUpdate', { method:'POST', body: JSON.stringify({ requests }) });
}
async function clearValues(range){
  return sheetsFetch('/values/' + encodeURIComponent(range) + ':clear', { method:'POST', body: '{}' });
}

/* Make sure Trades / Missed / Accounts tabs exist with header rows */
async function ensureSheetStructure(){
  const meta = await getMeta();
  const existing = (meta.sheets||[]).map(s => s.properties.title);
  const toAdd = [];
  if(!existing.includes('Trades')) toAdd.push({addSheet:{properties:{title:'Trades'}}});
  if(!existing.includes('Missed')) toAdd.push({addSheet:{properties:{title:'Missed'}}});
  if(!existing.includes('Accounts')) toAdd.push({addSheet:{properties:{title:'Accounts'}}});
  if(toAdd.length){ await batchUpdate(toAdd); }

  // header rows (only set if row 1 is empty)
  const checks = [
    {name:'Trades', headers: TRADE_HEADERS},
    {name:'Missed', headers: MISSED_HEADERS},
    {name:'Accounts', headers: ACCOUNT_HEADERS},
  ];
  for(const c of checks){
    const row1 = await getValues(c.name + '!A1:Z1');
    if(!row1.length || !row1[0].length){
      await updateValues(c.name + '!A1', [c.headers]);
    }
  }
  // seed default accounts if Accounts tab has only the header
  const accRows = await getValues('Accounts!A2:E');
  if(!accRows.length){
    await appendValues('Accounts!A1', DEFAULT_ACCOUNTS.map(a => [a.name,a.ddLimit,a.dailyRiskCap,a.targetMin,a.targetMax]));
  }
}

/* ============================== DATA LOAD ============================== */
async function loadAllData(){
  STATE.loading = true; render();
  try{
    await ensureSheetStructure();
    const [tradeRows, missedRows, accRows] = await Promise.all([
      getValues('Trades!A2:Q'),
      getValues('Missed!A2:H'),
      getValues('Accounts!A2:E'),
    ]);
    STATE.trades = tradeRows.map((r,i) => rowToTrade(r, i+2));
    STATE.missed = missedRows.map((r,i) => rowToMissed(r, i+2));
    STATE.accounts = accRows.map(r => ({name:r[0]||'', ddLimit:r[1]||'', dailyRiskCap:r[2]||'', targetMin:r[3]||'', targetMax:r[4]||''})).filter(a=>a.name);
    if(!STATE.accounts.length) STATE.accounts = DEFAULT_ACCOUNTS.slice();
  }catch(err){
    toast(err.message || 'Failed to load sheet data', 'err');
  }
  STATE.loading = false; render();
}
function rowToTrade(r, sheetRow){
  return {
    sheetRow, timestamp:r[0]||'', date:r[1]||'', account:r[2]||'', session:r[3]||'', setup:r[4]||'',
    direction:r[5]||'', entry:r[6]||'', sl:r[7]||'', tp1:r[8]||'', tp2:r[9]||'', riskUsd:r[10]||'',
    outcome:r[11]||'', r:r[12]||'', csd:r[13]||'', smt:r[14]||'', notes:r[15]||'', mood:r[16]||'',
  };
}
function rowToMissed(r, sheetRow){
  return {
    sheetRow, timestamp:r[0]||'', account:r[1]||'', session:r[2]||'', setup:r[3]||'',
    direction:r[4]||'', reason:r[5]||'', wouldHit:r[6]||'', notes:r[7]||'',
  };
}
function tradeToRow(t){
  return [t.timestamp,t.date,t.account,t.session,t.setup,t.direction,t.entry,t.sl,t.tp1,t.tp2,t.riskUsd,t.outcome,t.r,t.csd,t.smt,t.notes,t.mood||''];
}
function missedToRow(t){
  return [t.timestamp,t.account,t.session,t.setup,t.direction,t.reason,t.wouldHit,t.notes];
}

async function bootstrapAfterAuth(){
  saveCfg();
  await loadAllData();
  render();
}

/* ============================== STATS ============================== */
function filteredTrades(){
  if(STATE.activeAccountFilter === 'All') return STATE.trades;
  return STATE.trades.filter(t => t.account === STATE.activeAccountFilter);
}
function computeStats(trades){
  const n = trades.length;
  const wins = trades.filter(t => t.outcome === 'Win').length;
  const losses = trades.filter(t => t.outcome === 'Loss').length;
  const totalR = trades.reduce((s,t) => s + (parseFloat(t.r)||0), 0);
  const winRate = n ? (wins / n * 100) : 0;
  const avgR = n ? totalR / n : 0;
  // running equity (cumulative R) + max drawdown in R terms
  let cum = 0, peak = 0, maxDD = 0;
  const curve = trades.map(t => { cum += (parseFloat(t.r)||0); peak = Math.max(peak, cum); maxDD = Math.min(maxDD, cum-peak); return cum; });
  return {n, wins, losses, totalR, winRate, avgR, curve, maxDD};
}
function rDistribution(trades){
  // buckets: <-2, -2..-1, -1..0, 0..1, 1..2, 2..3, 3+
  const buckets = [
    {label:'≤ -2R', min:-Infinity, max:-2, count:0},
    {label:'-2 to -1R', min:-2, max:-1, count:0},
    {label:'-1 to 0R', min:-1, max:0, count:0},
    {label:'0 to 1R', min:0, max:1, count:0},
    {label:'1 to 2R', min:1, max:2, count:0},
    {label:'2 to 3R', min:2, max:3, count:0},
    {label:'3R+', min:3, max:Infinity, count:0},
  ];
  trades.forEach(t => {
    const v = parseFloat(t.r); if(isNaN(v)) return;
    for(const b of buckets){ if(v>b.min && v<=b.max){ b.count++; return; } }
    if(v === 0) buckets[3].count++;
  });
  return buckets;
}

/* ============================== RENDER: ROOT ============================== */
function render(){
  const app = $('#app');
  app.innerHTML = '';
  if(!CFG.clientId || !CFG.sheetId || !STATE.signedIn){
    app.appendChild(renderSetup());
    return;
  }
  app.appendChild(renderTopbar());
  app.appendChild(renderNav());
  const body = el('div', {id:'tab-body'});
  if(STATE.loading){
    body.appendChild(el('div', {class:'panel'}, [el('div', {class:'empty'}, ['Syncing with Google Sheets…'])]));
  } else if(STATE.tab === 'dashboard'){
    body.appendChild(renderDashboard());
  } else if(STATE.tab === 'calendar'){
    body.appendChild(renderCalendarTab());
  } else if(STATE.tab === 'log'){
    body.appendChild(renderLogTab());
  } else if(STATE.tab === 'missed'){
    body.appendChild(renderMissedTab());
  } else if(STATE.tab === 'accounts'){
    body.appendChild(renderAccountsTab());
  }
  app.appendChild(body);
  app.appendChild(el('div', {class:'note', html:'Data lives in your Google Sheet — open this page on any device signed into the same Google account to see the same log.'}));
}

/* ============================== SETUP SCREEN ============================== */
function renderSetup(){
  const wrap = el('div', {class:'setup-wrap'});
  const card = el('div', {class:'setup-card'});
  card.appendChild(el('h1', {}, ['CRT Journal']));
  card.appendChild(el('p', {class:'lead'}, ['Connect a Google Sheet once. From then on, this page reads and writes your trades straight to that sheet, so your phone and laptop always show the same log.']));

  const steps = el('details', {class:'steps'});
  steps.appendChild(el('summary', {}, ['One-time Google Cloud setup (~3 min) — do this before signing in']));
  const ol = el('ol');
  [
    'Go to console.cloud.google.com/apis/credentials (create/select a project).',
    'Click "Create Credentials" → "OAuth client ID" → type "Web application".',
    'Under "Authorized JavaScript origins," add the exact URL this page is hosted at (e.g. https://yourname.github.io or http://localhost:8000).',
    'Copy the generated Client ID and paste it below.',
    'In the same project, open "APIs & Services" → "Library," search "Google Sheets API," and click Enable.',
    'Go to sheets.google.com, create a blank spreadsheet, and copy its ID from the URL — the long string between /d/ and /edit.',
  ].forEach(s => ol.appendChild(el('li', {}, [s])));
  steps.appendChild(ol);
  card.appendChild(steps);

  const f1 = el('div', {class:'field'});
  f1.appendChild(el('label', {}, ['Google OAuth Client ID']));
  const in1 = el('input', {placeholder:'xxxxxxxx.apps.googleusercontent.com', value:CFG.clientId});
  f1.appendChild(in1);
  card.appendChild(f1);

  const f2 = el('div', {class:'field'});
  f2.appendChild(el('label', {}, ['Google Sheet ID']));
  const in2 = el('input', {placeholder:'1a2B3c... (from the sheet URL)', value:CFG.sheetId});
  f2.appendChild(in2);
  f2.appendChild(el('div', {class:'hint'}, ['The sheet can be completely blank — three tabs (Trades, Missed, Accounts) will be created automatically on first sign-in.']));
  card.appendChild(f2);

  const btn = el('button', {class:'btn primary', style:'width:100%; padding:12px; font-size:14px;'}, ['Save & sign in with Google']);
  btn.addEventListener('click', () => {
    CFG.clientId = in1.value.trim();
    CFG.sheetId = in2.value.trim();
    if(!CFG.clientId || !CFG.sheetId){ toast('Enter both the Client ID and Sheet ID', 'err'); return; }
    saveCfg();
    initGIS();
    requestSignIn();
  });
  card.appendChild(btn);
  wrap.appendChild(card);
  return wrap;
}

/* ============================== TOPBAR / NAV ============================== */
function renderTopbar(){
  const bar = el('div', {class:'topbar'});
  const brand = el('div', {class:'brand'});
  brand.appendChild(el('div', {class:'brand-mark', html:candleSvg()}));
  brand.appendChild(el('div', {class:'brand-text'}, ['CRT Journal', el('span', {class:'sub'}, ['ICT MODEL LOG'])]));
  bar.appendChild(brand);

  const right = el('div', {style:'display:flex; align-items:center; gap:10px;'});
  const pill = el('div', {class:'sync-pill'}, [
    el('span', {class:'dot ' + (tokenValid() ? 'on' : 'off')}),
    tokenValid() ? 'Synced to Sheet' : 'Reconnecting…',
  ]);
  right.appendChild(pill);
  const refreshBtn = el('button', {class:'btn small'}, ['↻ Refresh']);
  refreshBtn.addEventListener('click', loadAllData);
  right.appendChild(refreshBtn);
  const signOutBtn = el('button', {class:'btn small ghost'}, ['Sign out']);
  signOutBtn.addEventListener('click', signOut);
  right.appendChild(signOutBtn);
  bar.appendChild(right);
  return bar;
}
function candleSvg(){
  return `<svg viewBox="0 0 26 26" width="26" height="26" fill="none">
    <line x1="6" y1="2" x2="6" y2="24" stroke="#E1596B" stroke-width="1.4"/>
    <rect x="3.2" y="9" width="5.6" height="8" rx="1" fill="#E1596B"/>
    <line x1="14" y1="4" x2="14" y2="22" stroke="#3FBF7F" stroke-width="1.4"/>
    <rect x="11.2" y="6" width="5.6" height="9" rx="1" fill="#3FBF7F"/>
    <line x1="22" y1="6" x2="22" y2="20" stroke="#E3A94A" stroke-width="1.4"/>
    <rect x="19.2" y="12" width="5.6" height="6" rx="1" fill="#E3A94A"/>
  </svg>`;
}
function renderNav(){
  const nav = el('div', {class:'nav'});
  const tabs = [['dashboard','Dashboard'],['calendar','Calendar'],['log','Trade Log'],['missed','Missed Trades'],['accounts','Accounts']];
  tabs.forEach(([key,label]) => {
    const b = el('button', {class: STATE.tab===key ? 'active':''}, [label]);
    b.addEventListener('click', () => { STATE.tab = key; render(); });
    nav.appendChild(b);
  });
  return nav;
}

/* ============================== DASHBOARD ============================== */
function renderDashboard(){
  const wrap = el('div');
  const trades = filteredTrades();
  const stats = computeStats(trades);

  const accSel = el('select');
  accSel.appendChild(el('option', {value:'All'}, ['All Accounts']));
  STATE.accounts.forEach(a => accSel.appendChild(el('option', {value:a.name, ...(STATE.activeAccountFilter===a.name?{selected:'selected'}:{})}, [a.name])));
  accSel.value = STATE.activeAccountFilter;
  accSel.addEventListener('change', () => { STATE.activeAccountFilter = accSel.value; render(); });

  const filterBar = el('div', {style:'display:flex; justify-content:flex-end; margin-bottom:12px;'}, [el('div', {class:'acc-switch'}, [accSel])]);
  wrap.appendChild(filterBar);

  const grid = el('div', {class:'grid'});
  grid.appendChild(statCard('Total Trades', String(stats.n), null));
  grid.appendChild(statCard('Win Rate', stats.n ? stats.winRate.toFixed(1)+'%' : '—', null));
  grid.appendChild(statCard('Total R', fmtR(stats.totalR), stats.totalR>=0?'pos':'neg'));
  grid.appendChild(statCard('Max Drawdown', stats.n ? fmtR(stats.maxDD) : '—', 'neg'));
  wrap.appendChild(grid);

  const two = el('div', {class:'two-col'});
  const eqPanel = el('div', {class:'panel'});
  eqPanel.appendChild(el('h2', {}, ['Cumulative R (Equity Curve)']));
  const eqBox = el('div', {class:'chart-box'});
  const eqCanvas = el('canvas');
  eqBox.appendChild(eqCanvas);
  eqPanel.appendChild(eqBox);
  two.appendChild(eqPanel);

  const distPanel = el('div', {class:'panel'});
  distPanel.appendChild(el('h2', {}, ['R-Multiple Distribution']));
  const distBox = el('div', {class:'chart-box'});
  const distCanvas = el('canvas');
  distBox.appendChild(distCanvas);
  distPanel.appendChild(distBox);
  two.appendChild(distPanel);
  wrap.appendChild(two);

  // account drawdown watch panel
  if(STATE.activeAccountFilter !== 'All'){
    const acc = STATE.accounts.find(a => a.name === STATE.activeAccountFilter);
    if(acc && acc.ddLimit){
      const usedUsd = trades.reduce((s,t)=> s + (t.outcome==='Loss' ? Math.abs(parseFloat(t.riskUsd)||0) - 0 : 0), 0);
      const netUsd = trades.reduce((s,t)=> {
        const r = parseFloat(t.r)||0, risk = Math.abs(parseFloat(t.riskUsd)||0);
        return s + r*risk;
      }, 0);
      const ddLeft = parseFloat(acc.ddLimit) + Math.min(0,netUsd);
      const p = el('div', {class:'panel'});
      p.appendChild(el('h2', {}, ['Account Drawdown Watch']));
      const g2 = el('div', {class:'grid'});
      g2.appendChild(statCard('DD Limit', '$'+acc.ddLimit, null));
      g2.appendChild(statCard('Net P&L (est.)', (netUsd>=0?'+':'') + '$'+netUsd.toFixed(0), netUsd>=0?'pos':'neg'));
      g2.appendChild(statCard('Est. Cushion Left', '$'+ddLeft.toFixed(0), ddLeft > parseFloat(acc.ddLimit)*0.3 ? 'pos':'neg'));
      g2.appendChild(statCard('Daily Risk Cap', acc.dailyRiskCap ? '$'+acc.dailyRiskCap : '—', null));
      p.appendChild(g2);
      p.appendChild(el('div', {class:'hint', style:'margin-top:6px; color:var(--muted-2); font-size:11.5px;'}, ['Estimated from RiskUSD × R per trade — treat as directional, not a substitute for your prop firm\'s official equity.']));
      wrap.appendChild(p);
    }
  }

  setTimeout(() => drawCharts(eqCanvas, distCanvas, stats, trades), 0);
  return wrap;
}
function statCard(label, value, cls){
  return el('div', {class:'stat'}, [
    el('div', {class:'label'}, [label]),
    el('div', {class:'value' + (cls?(' '+cls):'')}, [value]),
  ]);
}
let _eqChart=null, _distChart=null;
function drawCharts(eqCanvas, distCanvas, stats, trades){
  if(_eqChart) _eqChart.destroy();
  if(_distChart) _distChart.destroy();
  const commonGrid = { color:'#1A2330' };
  _eqChart = new Chart(eqCanvas, {
    type:'line',
    data:{ labels: trades.map((_,i)=>i+1), datasets:[{ data: stats.curve, borderColor:'#E3A94A', backgroundColor:'rgba(227,169,74,0.12)', fill:true, tension:0.25, pointRadius:0, borderWidth:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{ grid:commonGrid, ticks:{color:'#748094', font:{size:10}} }, y:{ grid:commonGrid, ticks:{color:'#748094', font:{size:10}} } } }
  });
  const buckets = rDistribution(trades);
  _distChart = new Chart(distCanvas, {
    type:'bar',
    data:{ labels: buckets.map(b=>b.label), datasets:[{ data: buckets.map(b=>b.count), backgroundColor: buckets.map(b=> b.max<=0 ? '#E1596B' : '#3FBF7F'), borderRadius:4 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{ grid:{display:false}, ticks:{color:'#748094', font:{size:9.5}} }, y:{ grid:commonGrid, ticks:{color:'#748094', font:{size:10}, precision:0} } } }
  });
}

/* ============================== CALENDAR TAB (additive) ============================== */
function estDateKeyFromIso(iso){
  const d = new Date(iso);
  if(isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York' }).format(d); // YYYY-MM-DD
}
function tradeDateKey(t){
  if(t.timestamp){ const k = estDateKeyFromIso(t.timestamp); if(k) return k; }
  if(t.date){
    const mdY = t.date.split(' ')[0].split('/');
    if(mdY.length===3) return mdY[2]+'-'+mdY[0].padStart(2,'0')+'-'+mdY[1].padStart(2,'0');
  }
  return null;
}
function tradePnl(t){
  const r = parseFloat(t.r), risk = parseFloat(t.riskUsd);
  if(isNaN(r) || isNaN(risk)) return 0;
  return r * risk;
}
function monthLabel(y,m){
  return new Date(y, m, 1).toLocaleString('en-US', {month:'long', year:'numeric'});
}
function renderCalendarTab(){
  const wrap = el('div');
  const trades = filteredTrades();
  const y = STATE.calYear, m = STATE.calMonth;

  // top: nav + month pill
  const top = el('div', {class:'cal-top'});
  const nav = el('div', {class:'cal-nav'});
  const prev = el('button', {type:'button'}, ['←']);
  const next = el('button', {type:'button'}, ['→']);
  prev.addEventListener('click', ()=>{ STATE.calMonth--; if(STATE.calMonth<0){STATE.calMonth=11; STATE.calYear--;} render(); });
  next.addEventListener('click', ()=>{ STATE.calMonth++; if(STATE.calMonth>11){STATE.calMonth=0; STATE.calYear++;} render(); });
  nav.appendChild(prev); nav.appendChild(el('h2', {}, [monthLabel(y,m)])); nav.appendChild(next);
  top.appendChild(nav);

  // bucket trades by day for this month
  const daysN = new Date(y, m+1, 0).getDate();
  const byDay = {}; // day-of-month -> {pnl, count, wins}
  let monthPnl = 0, activeDays = 0;
  trades.forEach(t => {
    const key = tradeDateKey(t);
    if(!key) return;
    const [ky,km,kd] = key.split('-').map(Number);
    if(ky !== y || (km-1) !== m) return;
    if(!byDay[kd]) byDay[kd] = {pnl:0, count:0, wins:0};
    const pnl = tradePnl(t);
    byDay[kd].pnl += pnl;
    byDay[kd].count += 1;
    if(t.outcome === 'Win') byDay[kd].wins += 1;
    monthPnl += pnl;
  });
  activeDays = Object.keys(byDay).length;

  const pill = el('div', {class:'cal-pill'}, [
    el('span', {class:'pnl ' + (monthPnl>=0?'pos':'neg')}, [(monthPnl>=0?'++$':'−$') + Math.abs(monthPnl).toFixed(2)]),
    el('span', {}, [activeDays + ' day' + (activeDays===1?'':'s')]),
  ]);
  top.appendChild(pill);
  wrap.appendChild(top);

  // layout: calendar grid + weekly rail
  const layout = el('div', {class:'cal-layout'});
  const calCol = el('div');
  const dayNames = el('div', {class:'cal-daynames'});
  ['SUN','MON','TUE','WED','THU','FRI','SAT'].forEach(d => dayNames.appendChild(el('div', {}, [d])));
  calCol.appendChild(dayNames);

  const grid = el('div', {class:'cal-grid'});
  const firstDow = new Date(y, m, 1).getDay();
  for(let i=0;i<firstDow;i++) grid.appendChild(el('div', {class:'cal-cell empty'}));
  const weeks = []; // array of {days:[dayNum...], pnl, count, activeDays}
  let curWeek = { days:[], pnl:0, count:0, activeDays:0 };
  for(let i=0;i<firstDow;i++) curWeek.days.push(null);
  for(let d=1; d<=daysN; d++){
    const data = byDay[d];
    const cls = ['cal-cell'];
    if(data){ cls.push('has-data'); cls.push(data.pnl>=0 ? 'pos':'neg'); }
    const cell = el('div', {class:cls.join(' ')});
    cell.appendChild(el('div', {class:'daynum'}, [String(d)]));
    if(data){
      cell.appendChild(el('div', {class:'cpnl ' + (data.pnl>=0?'pos':'neg')}, [(data.pnl>=0?'+$':'−$') + Math.abs(data.pnl).toFixed(2)]));
      const wr = data.count ? Math.round(data.wins/data.count*100) : 0;
      cell.appendChild(el('div', {class:'cmeta'}, [data.count + (data.count===1?' trade':' trades') + ' · ' + wr + '%']));
      cell.appendChild(el('div', {class:'cdot ' + (data.pnl>=0?'pos':'neg')}));
      curWeek.pnl += data.pnl; curWeek.count += data.count; curWeek.activeDays += 1;
    }
    grid.appendChild(cell);
    curWeek.days.push(d);
    if(curWeek.days.length === 7){ weeks.push(curWeek); curWeek = {days:[], pnl:0, count:0, activeDays:0}; }
  }
  if(curWeek.days.length){ while(curWeek.days.length<7){ curWeek.days.push(null); grid.appendChild(el('div', {class:'cal-cell empty'})); } weeks.push(curWeek); }
  calCol.appendChild(grid);
  layout.appendChild(calCol);

  const rail = el('div', {class:'week-rail'});
  weeks.forEach((w, idx) => {
    const block = el('div', {class:'week-block'});
    block.appendChild(el('div', {class:'wl'}, ['Week ' + (idx+1)]));
    block.appendChild(el('div', {class:'wpnl ' + (w.pnl>=0?'pos':'neg')}, [(w.count ? ((w.pnl>=0?'+$':'−$')+Math.abs(w.pnl).toFixed(2)) : '$0')]));
    block.appendChild(el('div', {class:'wmeta'}, [w.count + ' trades']));
    block.appendChild(el('div', {class:'wmeta'}, [w.activeDays + ' active day' + (w.activeDays===1?'':'s')]));
    rail.appendChild(block);
  });
  layout.appendChild(rail);
  wrap.appendChild(layout);

  // bottom analytics banner
  const monthTrades = trades.filter(t => { const k=tradeDateKey(t); if(!k) return false; const [ky,km]=k.split('-').map(Number); return ky===y && (km-1)===m; });
  const wins = monthTrades.filter(t=>t.outcome==='Win').length;
  const winRate = monthTrades.length ? (wins/monthTrades.length*100) : 0;
  let grossProfit=0, grossLoss=0;
  monthTrades.forEach(t => { const p = tradePnl(t); if(p>=0) grossProfit += p; else grossLoss += Math.abs(p); });
  const profitFactor = grossLoss>0 ? (grossProfit/grossLoss) : (grossProfit>0 ? Infinity : 0);
  const moodScores = monthTrades.map(t=>moodScore(t.mood)).filter(v=>v!==null);
  const avgMood = moodScores.length ? (moodScores.reduce((a,b)=>a+b,0)/moodScores.length) : null;

  const banner = el('div', {class:'banner-grid'});
  banner.appendChild(statCard('Month P&L', (monthPnl>=0?'+$':'−$')+Math.abs(monthPnl).toFixed(2), monthPnl>=0?'pos':'neg'));
  banner.appendChild(statCard('Trades', String(monthTrades.length), null));
  banner.appendChild(statCard('Win Rate', monthTrades.length ? winRate.toFixed(1)+'%' : '—', null));
  banner.appendChild(statCard('Profit Factor', profitFactor===Infinity ? '∞' : (monthTrades.length ? profitFactor.toFixed(2) : '—'), null));
  banner.appendChild(statCard('Avg Mood', avgMood!==null ? avgMood.toFixed(1)+' / 5' : '—', null));
  wrap.appendChild(banner);

  return wrap;
}

/* ============================== TRADE LOG TAB ============================== */
function renderLogTab(){
  const wrap = el('div');
  wrap.appendChild(renderTradeForm());
  const panel = el('div', {class:'panel'});
  panel.appendChild(el('h2', {}, ['Trade Log (' + filteredTrades().length + ')']));
  panel.appendChild(renderTradeTable());
  wrap.appendChild(panel);
  return wrap;
}
function renderTradeForm(){
  const t = STATE.editingRow ? STATE.trades.find(x=>x.sheetRow===STATE.editingRow) : null;
  const panel = el('div', {class:'panel'});
  panel.appendChild(el('h2', {}, [t ? 'Edit Trade' : 'Log a Trade']));
  const form = el('div', {class:'form-grid'});

  const accWrap = fieldSelect('Account', STATE.accounts.map(a=>a.name), t? t.account : (STATE.accounts[0]?.name||''));
  form.appendChild(accWrap.wrap);

  const sessWrap = fieldSelect('Session', SESSIONS, t? t.session : SESSIONS[2]);
  form.appendChild(sessWrap.wrap);

  const setupWrap = fieldSelect('Setup / Model', SETUPS, t? t.setup : SETUPS[0]);
  form.appendChild(setupWrap.wrap);

  const outcomeWrap = fieldSelect('Outcome', ['Win','Loss','BE'], t? t.outcome : 'Win');
  form.appendChild(outcomeWrap.wrap);

  // direction segmented control
  let direction = t ? (t.direction || 'Long') : 'Long';
  const dirField = el('div', {class:'field'});
  dirField.appendChild(el('label', {}, ['Direction']));
  const seg = el('div', {class:'seg'});
  const bLong = el('button', {class: direction==='Long' ? 'on long':'', type:'button'}, ['Long']);
  const bShort = el('button', {class: direction==='Short' ? 'on short':'', type:'button'}, ['Short']);
  bLong.addEventListener('click', ()=>{ direction='Long'; bLong.className='on long'; bShort.className=''; });
  bShort.addEventListener('click', ()=>{ direction='Short'; bShort.className='on short'; bLong.className=''; });
  seg.appendChild(bLong); seg.appendChild(bShort);
  dirField.appendChild(seg);
  form.appendChild(dirField);

  const entryIn = numField('Entry', t?.entry);
  const slIn = numField('Stop Loss', t?.sl);
  const tp1In = numField('TP1', t?.tp1);
  const tp2In = numField('TP2', t?.tp2);
  form.appendChild(entryIn.wrap); form.appendChild(slIn.wrap); form.appendChild(tp1In.wrap); form.appendChild(tp2In.wrap);

  const riskIn = numField('Risk ($)', t?.riskUsd);
  const rIn = numField('R Achieved', t?.r);
  form.appendChild(riskIn.wrap); form.appendChild(rIn.wrap);

  // confluence chips
  let csdOn = t ? t.csd === 'Y' : false;
  let smtOn = t ? t.smt === 'Y' : false;
  const confField = el('div', {class:'field span2'});
  confField.appendChild(el('label', {}, ['Confluence']));
  const chips = el('div', {class:'chip-row'});
  const csdChip = el('button', {type:'button', class:'chip' + (csdOn?' on':'')}, ['CSD confirmed']);
  const smtChip = el('button', {type:'button', class:'chip' + (smtOn?' on':'')}, ['SMT aligned']);
  csdChip.addEventListener('click', ()=>{ csdOn=!csdOn; csdChip.className='chip'+(csdOn?' on':''); });
  smtChip.addEventListener('click', ()=>{ smtOn=!smtOn; smtChip.className='chip'+(smtOn?' on':''); });
  chips.appendChild(csdChip); chips.appendChild(smtChip);
  confField.appendChild(chips);
  form.appendChild(confField);

  const moodWrap = fieldSelect('Mood (optional)', ['', ...MOOD_OPTIONS.map(m=>m.value)], t? (t.mood||'') : '');
  // relabel the blank option
  moodWrap.wrap.querySelector('select option[value=""]').textContent = '— not set —';
  MOOD_OPTIONS.forEach(m => { moodWrap.wrap.querySelector('select option[value="'+m.value+'"]').textContent = m.label; });
  form.appendChild(moodWrap.wrap);

  const notesField = el('div', {class:'field span4'});
  notesField.appendChild(el('label', {}, ['Notes']));
  const notesArea = el('textarea', {rows:'2'}, []);
  notesArea.value = t?.notes || '';
  notesField.appendChild(notesArea);
  form.appendChild(notesField);

  panel.appendChild(form);

  const actions = el('div', {class:'row-actions'});
  if(t){
    const cancelBtn = el('button', {class:'btn'}, ['Cancel']);
    cancelBtn.addEventListener('click', ()=>{ STATE.editingRow=null; render(); });
    actions.appendChild(cancelBtn);
    const delBtn = el('button', {class:'btn ghost', style:'color:var(--short); border-color:var(--short);'}, ['Delete']);
    delBtn.addEventListener('click', ()=> deleteTrade(t));
    actions.appendChild(delBtn);
  }
  const saveBtn = el('button', {class:'btn primary'}, [t ? 'Update Trade' : 'Save Trade']);
  saveBtn.addEventListener('click', async () => {
    const payload = {
      timestamp: t? t.timestamp : nowIso(),
      date: t? t.date : estDateString(),
      account: accWrap.get(), session: sessWrap.get(), setup: setupWrap.get(), direction,
      entry: entryIn.get(), sl: slIn.get(), tp1: tp1In.get(), tp2: tp2In.get(),
      riskUsd: riskIn.get(), outcome: outcomeWrap.get(), r: rIn.get(),
      csd: csdOn?'Y':'N', smt: smtOn?'Y':'N', notes: notesArea.value, mood: moodWrap.get(),
    };
    await saveTrade(payload, t?.sheetRow);
  });
  actions.appendChild(saveBtn);
  panel.appendChild(actions);
  return panel;
}
function fieldSelect(label, options, value){
  const wrap = el('div', {class:'field'});
  wrap.appendChild(el('label', {}, [label]));
  const sel = el('select');
  options.forEach(o => sel.appendChild(el('option', {value:o, ...(o===value?{selected:'selected'}:{})}, [o])));
  sel.value = value;
  wrap.appendChild(sel);
  return { wrap, get: () => sel.value };
}
function numField(label, value){
  const wrap = el('div', {class:'field'});
  wrap.appendChild(el('label', {}, [label]));
  const inp = el('input', {type:'text', inputmode:'decimal', value: value!==undefined ? value : ''});
  wrap.appendChild(inp);
  return { wrap, get: () => inp.value };
}
async function saveTrade(payload, sheetRow){
  try{
    if(sheetRow){
      await updateValues('Trades!A'+sheetRow+':Q'+sheetRow, [tradeToRow(payload)]);
      toast('Trade updated', 'ok');
    } else {
      await appendValues('Trades!A1', [tradeToRow(payload)]);
      toast('Trade saved', 'ok');
    }
    STATE.editingRow = null;
    await loadAllData();
  }catch(err){ toast(err.message, 'err'); }
}
async function deleteTrade(t){
  if(!confirm('Delete this trade? This cannot be undone.')) return;
  try{
    const meta = await getMeta();
    const sheetId = meta.sheets.find(s=>s.properties.title==='Trades').properties.sheetId;
    await batchUpdate([{ deleteDimension: { range: { sheetId, dimension:'ROWS', startIndex:t.sheetRow-1, endIndex:t.sheetRow } } }]);
    toast('Trade deleted', 'ok');
    STATE.editingRow = null;
    await loadAllData();
  }catch(err){ toast(err.message, 'err'); }
}
function renderTradeTable(){
  const trades = filteredTrades().slice().sort((a,b) => (b.timestamp||'').localeCompare(a.timestamp||''));
  if(!trades.length) return el('div', {class:'empty'}, ['No trades logged yet — use the form above to add your first one.']);
  const wrap = el('div', {class:'table-wrap'});
  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  ['Date','Account','Session','Setup','Dir','Entry','SL','Risk','Outcome','R','Notes'].forEach(h => headRow.appendChild(el('th', {}, [h])));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody');
  trades.forEach(t => {
    const tr = el('tr', {class:'row'});
    tr.addEventListener('click', () => { STATE.editingRow = t.sheetRow; STATE.tab='log'; render(); window.scrollTo({top:0, behavior:'smooth'}); });
    tr.appendChild(el('td', {}, [t.date || '—']));
    tr.appendChild(el('td', {}, [t.account]));
    tr.appendChild(el('td', {}, [t.session]));
    tr.appendChild(el('td', {}, [t.setup]));
    tr.appendChild(el('td', {}, [t.direction]));
    tr.appendChild(el('td', {}, [t.entry]));
    tr.appendChild(el('td', {}, [t.sl]));
    tr.appendChild(el('td', {}, [t.riskUsd ? '$'+t.riskUsd : '—']));
    const outCls = t.outcome==='Win'?'win':(t.outcome==='Loss'?'loss':'be');
    tr.appendChild(el('td', {}, [el('span', {class:'tag '+outCls}, [t.outcome||'—'])]));
    const rNum = parseFloat(t.r);
    tr.appendChild(el('td', {class: rNum>0?'r-pos':(rNum<0?'r-neg':'')}, [fmtR(t.r)]));
    tr.appendChild(el('td', {style:'font-family:var(--body); max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'}, [t.notes||'']));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/* ============================== MISSED TRADES TAB ============================== */
function renderMissedTab(){
  const wrap = el('div');
  wrap.appendChild(renderMissedForm());
  const panel = el('div', {class:'panel'});
  panel.appendChild(el('h2', {}, ['Missed Trades (' + STATE.missed.length + ')']));
  panel.appendChild(renderMissedTable());
  wrap.appendChild(panel);
  return wrap;
}
function renderMissedForm(){
  const t = STATE.editingMissedRow ? STATE.missed.find(x=>x.sheetRow===STATE.editingMissedRow) : null;
  const panel = el('div', {class:'panel'});
  panel.appendChild(el('h2', {}, [t ? 'Edit Missed Trade' : 'Log a Missed Trade']));
  const form = el('div', {class:'form-grid'});
  const accWrap = fieldSelect('Account', STATE.accounts.map(a=>a.name), t? t.account : (STATE.accounts[0]?.name||''));
  const sessWrap = fieldSelect('Session', SESSIONS, t? t.session : SESSIONS[2]);
  const setupWrap = fieldSelect('Setup / Model', SETUPS, t? t.setup : SETUPS[0]);
  const dirWrap = fieldSelect('Direction', ['Long','Short'], t? t.direction : 'Long');
  form.appendChild(accWrap.wrap); form.appendChild(sessWrap.wrap); form.appendChild(setupWrap.wrap); form.appendChild(dirWrap.wrap);

  const reasonField = el('div', {class:'field span2'});
  reasonField.appendChild(el('label', {}, ['Reason Missed']));
  const reasonIn = el('input', {type:'text', value: t?.reason||'', placeholder:'e.g. hesitated on entry, away from desk'});
  reasonField.appendChild(reasonIn);
  form.appendChild(reasonField);

  let wouldHit = t ? t.wouldHit === 'Y' : false;
  const whField = el('div', {class:'field'});
  whField.appendChild(el('label', {}, ['Would it have hit full TP?']));
  const whChip = el('button', {type:'button', class:'chip'+(wouldHit?' on':''), style:'width:100%;'}, [wouldHit ? 'Yes — full TP' : 'Mark as yes']);
  whChip.addEventListener('click', ()=>{ wouldHit=!wouldHit; whChip.className='chip'+(wouldHit?' on':''); whChip.textContent = wouldHit ? 'Yes — full TP' : 'Mark as yes'; });
  whField.appendChild(whChip);
  form.appendChild(whField);

  const notesField = el('div', {class:'field span4'});
  notesField.appendChild(el('label', {}, ['Notes']));
  const notesArea = el('textarea', {rows:'2'});
  notesArea.value = t?.notes || '';
  notesField.appendChild(notesArea);
  form.appendChild(notesField);

  panel.appendChild(form);
  const actions = el('div', {class:'row-actions'});
  if(t){
    const cancelBtn = el('button', {class:'btn'}, ['Cancel']);
    cancelBtn.addEventListener('click', ()=>{ STATE.editingMissedRow=null; render(); });
    actions.appendChild(cancelBtn);
    const delBtn = el('button', {class:'btn ghost', style:'color:var(--short); border-color:var(--short);'}, ['Delete']);
    delBtn.addEventListener('click', ()=> deleteMissed(t));
    actions.appendChild(delBtn);
  }
  const saveBtn = el('button', {class:'btn primary'}, [t ? 'Update' : 'Save']);
  saveBtn.addEventListener('click', async () => {
    const payload = {
      timestamp: t? t.timestamp : nowIso(), account: accWrap.get(), session: sessWrap.get(),
      setup: setupWrap.get(), direction: dirWrap.get(), reason: reasonIn.value,
      wouldHit: wouldHit?'Y':'N', notes: notesArea.value,
    };
    try{
      if(t){ await updateValues('Missed!A'+t.sheetRow+':H'+t.sheetRow, [missedToRow(payload)]); toast('Updated','ok'); }
      else { await appendValues('Missed!A1', [missedToRow(payload)]); toast('Saved','ok'); }
      STATE.editingMissedRow = null;
      await loadAllData();
    }catch(err){ toast(err.message,'err'); }
  });
  actions.appendChild(saveBtn);
  panel.appendChild(actions);
  return panel;
}
async function deleteMissed(t){
  if(!confirm('Delete this missed trade?')) return;
  try{
    const meta = await getMeta();
    const sheetId = meta.sheets.find(s=>s.properties.title==='Missed').properties.sheetId;
    await batchUpdate([{ deleteDimension: { range: { sheetId, dimension:'ROWS', startIndex:t.sheetRow-1, endIndex:t.sheetRow } } }]);
    toast('Deleted','ok');
    STATE.editingMissedRow = null;
    await loadAllData();
  }catch(err){ toast(err.message,'err'); }
}
function renderMissedTable(){
  const rows = STATE.missed.slice().sort((a,b)=> (b.timestamp||'').localeCompare(a.timestamp||''));
  if(!rows.length) return el('div', {class:'empty'}, ['No missed trades logged.']);
  const wrap = el('div', {class:'table-wrap'});
  const table = el('table');
  const thead = el('thead'); const hr = el('tr');
  ['Account','Session','Setup','Dir','Reason','Full TP?','Notes'].forEach(h=>hr.appendChild(el('th',{},[h])));
  thead.appendChild(hr); table.appendChild(thead);
  const tbody = el('tbody');
  rows.forEach(t => {
    const tr = el('tr', {class:'row'});
    tr.addEventListener('click', ()=>{ STATE.editingMissedRow = t.sheetRow; render(); window.scrollTo({top:0,behavior:'smooth'}); });
    tr.appendChild(el('td',{},[t.account]));
    tr.appendChild(el('td',{},[t.session]));
    tr.appendChild(el('td',{},[t.setup]));
    tr.appendChild(el('td',{},[t.direction]));
    tr.appendChild(el('td',{style:'font-family:var(--body);'},[t.reason||'']));
    tr.appendChild(el('td',{}, [el('span', {class:'tag '+(t.wouldHit==='Y'?'win':'be')}, [t.wouldHit==='Y'?'Yes':'No'])]));
    tr.appendChild(el('td',{style:'font-family:var(--body); max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'},[t.notes||'']));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); wrap.appendChild(table);
  return wrap;
}

/* ============================== ACCOUNTS TAB ============================== */
function renderAccountsTab(){
  const panel = el('div', {class:'panel'});
  panel.appendChild(el('h2', {}, ['Accounts']));
  const editor = el('div', {class:'accounts-editor'});
  const rows = STATE.accounts.map(a => ({...a}));

  function drawRows(){
    editor.innerHTML = '';
    rows.forEach((a, idx) => {
      const line = el('div', {class:'acc-line'});
      const nameIn = el('input', {value:a.name, placeholder:'Account name'});
      const ddIn = el('input', {value:a.ddLimit, placeholder:'DD limit $'});
      const capIn = el('input', {value:a.dailyRiskCap, placeholder:'Daily risk cap $'});
      const tgtIn = el('input', {value:(a.targetMin||'')+(a.targetMax?('-'+a.targetMax):''), placeholder:'Target $ (e.g. 70-100)'});
      nameIn.addEventListener('input', ()=> a.name=nameIn.value);
      ddIn.addEventListener('input', ()=> a.ddLimit=ddIn.value);
      capIn.addEventListener('input', ()=> a.dailyRiskCap=capIn.value);
      tgtIn.addEventListener('input', ()=>{ const [mn,mx]=tgtIn.value.split('-'); a.targetMin=(mn||'').trim(); a.targetMax=(mx||'').trim(); });
      const rm = el('button', {class:'rm', type:'button'}, ['×']);
      rm.addEventListener('click', ()=>{ rows.splice(idx,1); drawRows(); });
      line.appendChild(nameIn); line.appendChild(ddIn); line.appendChild(capIn); line.appendChild(tgtIn); line.appendChild(rm);
      editor.appendChild(line);
    });
  }
  drawRows();
  panel.appendChild(editor);

  const addBtn = el('button', {class:'btn small', style:'margin-top:10px;'}, ['+ Add account']);
  addBtn.addEventListener('click', ()=>{ rows.push({name:'',ddLimit:'',dailyRiskCap:'',targetMin:'',targetMax:''}); drawRows(); });
  panel.appendChild(addBtn);

  const actions = el('div', {class:'row-actions'});
  const saveBtn = el('button', {class:'btn primary'}, ['Save Accounts']);
  saveBtn.addEventListener('click', async () => {
    const clean = rows.filter(a => a.name.trim());
    try{
      await clearValues('Accounts!A2:E10000');
      if(clean.length) await appendValues('Accounts!A1', clean.map(a=>[a.name,a.ddLimit,a.dailyRiskCap,a.targetMin,a.targetMax]));
      toast('Accounts saved','ok');
      await loadAllData();
    }catch(err){ toast(err.message,'err'); }
  });
  actions.appendChild(saveBtn);
  panel.appendChild(actions);
  return panel;
}

/* ============================== BOOT ============================== */
window.addEventListener('load', () => {
  try{
    const estKey = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York'}).format(new Date());
    const [ey, em] = estKey.split('-').map(Number);
    STATE.calYear = ey; STATE.calMonth = em - 1;
  }catch(e){}
  if(CFG.clientId){ 
    const tryInit = setInterval(() => {
      if(window.google && window.google.accounts){
        clearInterval(tryInit);
        initGIS();
        if(STATE.token && tokenValid()){
          STATE.signedIn = true;
          bootstrapAfterAuth();
        } else {
          render();
        }
      }
    }, 100);
  } else {
    render();
  }
});
