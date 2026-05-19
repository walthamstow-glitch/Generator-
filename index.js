const https = require('https');

// ═══════════════════════════════════════════════
//  CREDENTIALS
// ═══════════════════════════════════════════════
const TG_TOKEN = process.env.TG_TOKEN || '8935289763:AAE6a671d7cAoOhssmIKi_aKz57APta4C6Y';
const TG_CHAT  = process.env.TG_CHAT  || '572971062';

// ═══════════════════════════════════════════════
//  BOT SETTINGS — all changeable via Telegram
// ═══════════════════════════════════════════════
let settings = {
  tf:           1,         // candle timeframe: 1 or 5
  minConf:      65,        // minimum confidence %
  mode:         'both',    // 'crypto', 'fx', 'both'
  running:      true,      // bot on/off
  maxSignals:   1,         // max signals per scan (frequency)
  patternMode:  'all',     // 'all' or 'strong'
  rsiMode:      'normal',  // 'normal' or 'strict'
};

// ═══════════════════════════════════════════════
//  PAIRS
// ═══════════════════════════════════════════════
const ALL_PAIRS = [
  { s:'BTCUSDT',   d:'BTC/USD',   crypto:true  },
  { s:'ETHUSDT',   d:'ETH/USD',   crypto:true  },
  { s:'BNBUSDT',   d:'BNB/USD',   crypto:true  },
  { s:'SOLUSDT',   d:'SOL/USD',   crypto:true  },
  { s:'XRPUSDT',   d:'XRP/USD',   crypto:true  },
  { s:'ADAUSDT',   d:'ADA/USD',   crypto:true  },
  { s:'DOGEUSDT',  d:'DOGE/USD',  crypto:true  },
  { s:'LTCUSDT',   d:'LTC/USD',   crypto:true  },
  { s:'AVAXUSDT',  d:'AVAX/USD',  crypto:true  },
  { s:'DOTUSDT',   d:'DOT/USD',   crypto:true  },
  { s:'LINKUSDT',  d:'LINK/USD',  crypto:true  },
  { s:'MATICUSDT', d:'MATIC/USD', crypto:true  },
  { s:'EURUSDT',   d:'EUR/USD',   crypto:false },
  { s:'GBPUSDT',   d:'GBP/USD',   crypto:false },
  { s:'AUDUSDT',   d:'AUD/USD',   crypto:false },
  { s:'NZDUSDT',   d:'NZD/USD',   crypto:false },
];

const STRONG_PATTERNS = [
  'BULLISH ENGULFING','BEARISH ENGULFING',
  'MORNING STAR','EVENING STAR',
  'BULL MARUBOZU','BEAR MARUBOZU',
  '3 WHITE SOLDIERS','3 BLACK CROWS'
];

const ALL_PATTERNS = [
  ...STRONG_PATTERNS,
  'HAMMER','SHOOTING STAR','PIERCING LINE',
  'DARK CLOUD','HANGING MAN','INV HAMMER'
];

// ═══════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════
let signalLog   = [];
let hourlyLog   = [];
let totalWins   = 0;
let totalLosses = 0;
let scanCount   = 0;
let pollOffset  = 0;
let scanTimer   = null;

// ═══════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtP(p, s) {
  if (s.includes('BTC') || p > 1000) return p.toFixed(2);
  if (p > 1) return p.toFixed(4);
  return p.toFixed(6);
}

function isWeekend() {
  const d = new Date().getDay();
  return d === 0 || d === 6;
}

function getActivePairs() {
  if (isWeekend()) return ALL_PAIRS.filter(p => p.crypto);
  if (settings.mode === 'crypto') return ALL_PAIRS.filter(p => p.crypto);
  if (settings.mode === 'fx')     return ALL_PAIRS.filter(p => !p.crypto);
  return ALL_PAIRS;
}

function utcTime() { return new Date().toUTCString().slice(17,25) + ' UTC'; }
function utcFull()  { return new Date().toUTCString().slice(5,25)  + ' UTC'; }

function wrBar(wr) {
  const f = Math.min(10, Math.max(0, Math.round(wr/10)));
  return '█'.repeat(f) + '░'.repeat(10-f);
}

function settingsSummary() {
  const patLabel = settings.patternMode === 'strong' ? 'Strong only' : 'All 13 patterns';
  const rsiLabel = settings.rsiMode === 'strict' ? 'Strict (OB/OS only)' : 'Normal';
  const freqLabel = settings.maxSignals >= 99 ? 'All signals' : `Max ${settings.maxSignals}/scan`;
  return `⏱ TF: <b>${settings.tf}MIN</b> | 💪 Conf: <b>${settings.minConf}%</b> | 📡 Mode: <b>${settings.mode.toUpperCase()}</b>\n🕯 Patterns: <b>${patLabel}</b> | 📈 RSI: <b>${rsiLabel}</b> | 🔢 Freq: <b>${freqLabel}</b>`;
}

// ═══════════════════════════════════════════════
//  HTTP
// ═══════════════════════════════════════════════
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(url, opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════
async function tgSend(text) {
  try {
    await httpPost(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT, text, parse_mode: 'HTML'
    });
  } catch(e) { console.error('TG error:', e.message); }
}

// ═══════════════════════════════════════════════
//  POLLING
// ═══════════════════════════════════════════════
async function pollUpdates() {
  try {
    const d = await httpGet(
      `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${pollOffset}&timeout=10&limit=20`
    );
    if (!d.ok) return;
    for (const upd of d.result) {
      pollOffset = upd.update_id + 1;
      if (upd.message && upd.message.text) {
        if (String(upd.message.chat.id) === TG_CHAT) {
          await handleCommand(upd.message.text.trim().toLowerCase().split('@')[0]);
        }
      }
    }
  } catch(e) { console.error('Poll error:', e.message); }
}

// ═══════════════════════════════════════════════
//  COMMAND HANDLER
// ═══════════════════════════════════════════════
async function handleCommand(cmd) {
  console.log(`[${utcTime()}] CMD: ${cmd}`);

  switch(cmd) {

    // ── TIMEFRAME ──────────────────────────────
    case '/tf1':
      settings.tf = 1;
      restartScanLoop();
      await tgSend(`✅ <b>Timeframe → 1 MIN candles</b>\nSignals every 1 minute.\n\n${settingsSummary()}`);
      await runScan();
      break;

    case '/tf5':
      settings.tf = 5;
      restartScanLoop();
      await tgSend(`✅ <b>Timeframe → 5 MIN candles</b>\nSignals every 5 minutes.\n\n${settingsSummary()}`);
      await runScan();
      break;

    // ── CONFIDENCE / ACCURACY ──────────────────
    case '/conf50':
      settings.minConf = 50;
      await tgSend(`✅ <b>Confidence → 50%</b>\n⚠️ Many signals — lower accuracy.\n\n${settingsSummary()}`);
      break;

    case '/conf55':
      settings.minConf = 55;
      await tgSend(`✅ <b>Confidence → 55%</b>\nMore signals, moderate accuracy.\n\n${settingsSummary()}`);
      break;

    case '/conf60':
      settings.minConf = 60;
      await tgSend(`✅ <b>Confidence → 60%</b>\nGood balance of signals.\n\n${settingsSummary()}`);
      break;

    case '/conf65':
      settings.minConf = 65;
      await tgSend(`✅ <b>Confidence → 65%</b>\n⭐ Recommended balanced setting.\n\n${settingsSummary()}`);
      break;

    case '/conf70':
      settings.minConf = 70;
      await tgSend(`✅ <b>Confidence → 70%</b>\nGood quality signals.\n\n${settingsSummary()}`);
      break;

    case '/conf75':
      settings.minConf = 75;
      await tgSend(`✅ <b>Confidence → 75%</b>\nHigh quality signals only.\n\n${settingsSummary()}`);
      break;

    case '/conf80':
      settings.minConf = 80;
      await tgSend(`✅ <b>Confidence → 80%</b>\nVery high quality — fewer signals.\n\n${settingsSummary()}`);
      break;

    case '/conf85':
      settings.minConf = 85;
      await tgSend(`✅ <b>Confidence → 85%</b>\nElite signals — very rare.\n\n${settingsSummary()}`);
      break;

    case '/conf90':
      settings.minConf = 90;
      await tgSend(`✅ <b>Confidence → 90%</b>\n🎯 Only the strongest setups.\n\n${settingsSummary()}`);
      break;

    // ── FREQUENCY ─────────────────────────────
    case '/freq1':
      settings.maxSignals = 1;
      await tgSend(`✅ <b>Frequency → Max 1 signal per scan</b>\nOnly the best signal each candle.\n\n${settingsSummary()}`);
      break;

    case '/freq3':
      settings.maxSignals = 3;
      await tgSend(`✅ <b>Frequency → Max 3 signals per scan</b>\nTop 3 signals each candle.\n\n${settingsSummary()}`);
      break;

    case '/freq5':
      settings.maxSignals = 5;
      await tgSend(`✅ <b>Frequency → Max 5 signals per scan</b>\nTop 5 signals each candle.\n\n${settingsSummary()}`);
      break;

    case '/freqall':
      settings.maxSignals = 99;
      await tgSend(`✅ <b>Frequency → All valid signals</b>\nEvery pair that meets criteria fires.\n\n${settingsSummary()}`);
      break;

    // ── PATTERN MODE ──────────────────────────
    case '/strong':
      settings.patternMode = 'strong';
      await tgSend(
`✅ <b>Pattern Mode → Strong Patterns Only</b>

Only firing on:
• Bullish/Bearish Engulfing
• Morning/Evening Star
• Bull/Bear Marubozu
• 3 White Soldiers / 3 Black Crows

Higher accuracy — fewer signals.

${settingsSummary()}`
      );
      break;

    case '/allpatterns':
      settings.patternMode = 'all';
      await tgSend(
`✅ <b>Pattern Mode → All 13 Patterns</b>

Includes all patterns:
Strong + Hammer + Shooting Star
+ Piercing Line + Dark Cloud
+ Hanging Man + Inv Hammer

More signals — slightly lower accuracy.

${settingsSummary()}`
      );
      break;

    // ── RSI MODE ──────────────────────────────
    case '/rsistrict':
      settings.rsiMode = 'strict';
      await tgSend(
`✅ <b>RSI Mode → Strict</b>

CALL signals: RSI must be below 35 (oversold)
PUT signals: RSI must be above 65 (overbought)

Highest accuracy — fewest signals.

${settingsSummary()}`
      );
      break;

    case '/rsinormal':
      settings.rsiMode = 'normal';
      await tgSend(
`✅ <b>RSI Mode → Normal</b>

Standard RSI confirmation.
More signals allowed through.

${settingsSummary()}`
      );
      break;

    // ── PAIR MODE ─────────────────────────────
    case '/crypto':
      settings.mode = 'crypto';
      await tgSend(
`✅ <b>Mode → Crypto Only</b>

Scanning 12 pairs:
BTC · ETH · BNB · SOL · XRP
ADA · DOGE · LTC · AVAX
DOT · LINK · MATIC

📅 Available 24/7 including weekends.

${settingsSummary()}`
      );
      break;

    case '/fx':
      if (isWeekend()) {
        await tgSend('⚠️ <b>FX markets are closed on weekends</b>\n\nBot stays in Crypto mode.\nTry again Monday.');
        break;
      }
      settings.mode = 'fx';
      await tgSend(
`✅ <b>Mode → FX Only</b>

Scanning 4 FX pairs:
EUR/USD · GBP/USD
AUD/USD · NZD/USD

⚠️ FX available weekdays only.

${settingsSummary()}`
      );
      break;

    case '/both':
      settings.mode = 'both';
      await tgSend(
`✅ <b>Mode → Crypto + FX</b>

Scanning all ${getActivePairs().length} pairs.
${isWeekend() ? '⚠️ Weekend — showing crypto only until Monday.' : '✅ All pairs active.'}

${settingsSummary()}`
      );
      break;

    // ── BOT CONTROL ───────────────────────────
    case '/stop':
      settings.running = false;
      clearInterval(scanTimer);
      await tgSend('⏹ <b>Bot paused</b>\n\nNo signals until you type /start.\nPending results still tracked.');
      break;

    case '/start':
      if (settings.running) { await tgSend('ℹ️ Bot is already running.'); break; }
      settings.running = true;
      restartScanLoop();
      await tgSend('▶️ <b>Bot resumed!</b>\nScanning now...');
      await runScan();
      break;

    case '/scan':
      await tgSend('🔍 Manual scan triggered...');
      await runScan();
      break;

    // ── INFO ──────────────────────────────────
    case '/status':
      const pairs = getActivePairs();
      const allTotal = totalWins + totalLosses;
      const wr = allTotal > 0 ? Math.round(totalWins/allTotal*100) : 0;
      await tgSend(
`📊 <b>BOT STATUS</b>

▶️ Running: <b>${settings.running ? 'YES ✅' : 'PAUSED ⏸'}</b>
${settingsSummary()}

📈 Session Stats:
✅ Wins: <b>${totalWins}</b>  ❌ Losses: <b>${totalLosses}</b>
🏆 Win Rate: <b>${wr}%</b>  [${wrBar(wr)}]
📊 Total Signals: <b>${signalLog.length}</b>
${isWeekend() ? '\n⚠️ Weekend — Crypto only active' : ''}`
      );
      break;

    case '/pairs':
      const active = getActivePairs();
      const cp = active.filter(p=>p.crypto).map(p=>p.d).join(' · ');
      const fp = active.filter(p=>!p.crypto).map(p=>p.d).join(' · ');
      await tgSend(
`📡 <b>ACTIVE PAIRS (${active.length})</b>

🪙 <b>Crypto (${active.filter(p=>p.crypto).length}):</b>
${cp || 'None'}

💱 <b>FX (${active.filter(p=>!p.crypto).length}):</b>
${fp || 'None'}

<i>Use /crypto /fx /both to change</i>`
      );
      break;

    case '/results':
      await tgSend(buildResultsMsg());
      break;

    case '/stats':
      await tgSend(buildStatsMsg());
      break;

    case '/report':
      await sendHourlyReport();
      break;

    case '/help':
      await tgSend(
`🤖 <b>QXSIGNAL BOT — ALL COMMANDS</b>

<b>⏱ TIMEFRAME</b>
/tf1 — 1 minute candles
/tf5 — 5 minute candles

<b>💪 ACCURACY (CONFIDENCE)</b>
/conf50 — 50% (max signals)
/conf55 — 55%
/conf60 — 60%
/conf65 — 65% ⭐ recommended
/conf70 — 70%
/conf75 — 75% (high quality)
/conf80 — 80%
/conf85 — 85% (very selective)
/conf90 — 90% (elite only)

<b>🔢 FREQUENCY (signals per scan)</b>
/freq1 — Max 1 signal per candle
/freq3 — Max 3 signals per candle
/freq5 — Max 5 signals per candle
/freqall — All valid signals

<b>🕯 PATTERN FILTER</b>
/strong — Strong patterns only
/allpatterns — All 13 patterns

<b>📈 RSI FILTER</b>
/rsistrict — Strict OB/OS only
/rsinormal — Standard RSI

<b>📡 PAIR MODE</b>
/crypto — Crypto pairs only
/fx — FX pairs only (weekdays)
/both — Crypto + FX together

<b>🎮 BOT CONTROL</b>
/start — Resume bot
/stop — Pause bot
/scan — Force scan now

<b>📊 INFO & REPORTS</b>
/status — Current settings
/pairs — Active pairs list
/results — Last 10 signal results
/stats — Win rate & performance
/report — Get hourly report now
/help — This menu`
      );
      break;

    default:
      await tgSend('❓ Unknown command.\nType /help to see all available commands.');
  }
}

// ═══════════════════════════════════════════════
//  RESULTS MESSAGES
// ═══════════════════════════════════════════════
function buildResultsMsg() {
  const last10 = signalLog.slice(0,10);
  if (!last10.length) return '📊 <b>RESULTS</b>\n\nNo signals yet.';
  let msg = '📊 <b>LAST 10 SIGNAL RESULTS</b>\n\n';
  last10.forEach(s => {
    const arr   = s.dir==='call'?'▲':'▼';
    const emoji = s.result==='win'?'✅':s.result==='loss'?'❌':'⏳';
    const res   = s.result==='win'?'WIN':s.result==='loss'?'LOSS':'PENDING';
    const t     = new Date(s.entryTime).toUTCString().slice(17,22)+' UTC';
    msg += `${emoji} <b>${arr} ${s.dir.toUpperCase()} ${s.pair}</b> — <b>${res}</b>\n`;
    msg += `   📊 ${s.pat} (${s.conf}%) | RSI:${s.rsi}\n`;
    msg += `   💰 ${s.entryPrice} → ${s.resultPrice||'...'} | ${t}\n\n`;
  });
  return msg;
}

function buildStatsMsg() {
  const total   = totalWins+totalLosses;
  const wr      = total>0?Math.round(totalWins/total*100):0;
  const pending = signalLog.filter(s=>s.result==='pending').length;
  const perf    = wr>=70?'🔥 Excellent':wr>=60?'✅ Good':wr>=50?'📊 Average':'⚠️ Below average';
  return `📈 <b>QXSIGNAL BOT — FULL STATS</b>

🏆 Win Rate: <b>${wr}%</b> — ${perf}
[${wrBar(wr)}]

✅ Total Wins:    <b>${totalWins}</b>
❌ Total Losses:  <b>${totalLosses}</b>
⏳ Pending:       <b>${pending}</b>
📊 Total Signals: <b>${signalLog.length}</b>

${settingsSummary()}

<i>Results based on price direction at expiry</i>`;
}

// ═══════════════════════════════════════════════
//  HOURLY REPORT
// ═══════════════════════════════════════════════
async function sendHourlyReport() {
  const resolved = hourlyLog.filter(s=>s.result!=='pending');
  const pending  = hourlyLog.filter(s=>s.result==='pending');
  const wins     = resolved.filter(s=>s.result==='win').length;
  const losses   = resolved.filter(s=>s.result==='loss').length;
  const total    = resolved.length;
  const wr       = total>0?Math.round(wins/total*100):0;
  const allTotal = totalWins+totalLosses;
  const allWR    = allTotal>0?Math.round(totalWins/allTotal*100):0;
  const perf     = wr>=70?'🔥 Excellent hour!':wr>=60?'✅ Good hour':wr>=50?'📊 Average hour':wins===0&&losses===0?'😴 Quiet hour':'⚠️ Tough hour';

  let details = '';
  if (resolved.length > 0) {
    details = '\n<b>📋 Signals This Hour:</b>\n';
    resolved.slice(0,8).forEach(s => {
      const r   = s.result==='win'?'✅':'❌';
      const arr = s.dir==='call'?'▲':'▼';
      const t   = new Date(s.entryTime).toUTCString().slice(17,22);
      details += `${r} ${arr} ${s.pair} | ${s.pat} | ${s.entryPrice}→${s.resultPrice||'?'} @${t}\n`;
    });
  }

  await tgSend(
`📊 <b>QXSIGNAL — HOURLY REPORT</b>
🕐 ${utcFull()}

━━━━━━━━━━━━━━━━━━━━
${perf}
━━━━━━━━━━━━━━━━━━━━

<b>THIS HOUR</b>
✅ Wins:     <b>${wins}</b>
❌ Losses:   <b>${losses}</b>
⏳ Pending:  <b>${pending.length}</b>
📈 Signals:  <b>${hourlyLog.length}</b>
🏆 Win Rate: <b>${wr}%</b>
[${wrBar(wr)}]

<b>ALL TIME</b>
✅ Wins:     <b>${totalWins}</b>
❌ Losses:   <b>${totalLosses}</b>
🏆 Win Rate: <b>${allWR}%</b>
📊 Total:    <b>${signalLog.length} signals</b>
${details}
<b>⚙️ Active Settings:</b>
${settingsSummary()}

<i>Next report in 1 hour | /help for commands</i>`
  );

  console.log(`[${utcTime()}] Hourly report: ${wins}W/${losses}L | Overall: ${allWR}%`);
  hourlyLog = [];
}

// ═══════════════════════════════════════════════
//  BINANCE DATA
// ═══════════════════════════════════════════════
async function fetchCandles(sym) {
  try {
    const iv = settings.tf===1?'1m':'5m';
    const d  = await httpGet(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=50`);
    return d.map(c=>({open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5]}));
  } catch(e) { return null; }
}

async function fetchPrice(sym) {
  try {
    const d = await httpGet(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
    return parseFloat(d.price);
  } catch(e) { return null; }
}

// ═══════════════════════════════════════════════
//  PATTERN DETECTION
// ═══════════════════════════════════════════════
function detectPattern(cc) {
  if (!cc||cc.length<4) return{name:'—',dir:'none'};
  const c=cc[cc.length-1],p=cc[cc.length-2],pp=cc[cc.length-3];
  const cb=Math.abs(c.close-c.open),pb=Math.abs(p.close-p.open);
  const cr=c.high-c.low;
  const cB=c.close>c.open,pB=p.close>p.open;
  const cu=c.high-Math.max(c.open,c.close),cd=Math.min(c.open,c.close)-c.low;
  const pu=p.high-Math.max(p.open,p.close),pd=Math.min(p.open,p.close)-p.low;

  if(cb<cr*0.08&&cr>0)                                                                    return{name:'DOJI',             dir:'none'};
  if(!pB&&cB&&c.open<p.close&&c.close>p.open&&cb>pb*1.1)                                return{name:'BULLISH ENGULFING',dir:'call'};
  if( pB&&!cB&&c.open>p.close&&c.close<p.open&&cb>pb*1.1)                               return{name:'BEARISH ENGULFING',dir:'put' };
  if(cd>cb*2&&cu<cb*0.5&&cr>0)                                                           return{name:'HAMMER',           dir:'call'};
  if(cu>cb*2&&cd<cb*0.5&&cr>0)                                                           return{name:'SHOOTING STAR',    dir:'put' };
  if(!pB&&pb<Math.abs(pp.close-pp.open)*0.5&&cB&&c.close>(pp.open+pp.close)/2&&!(pp.close>pp.open)) return{name:'MORNING STAR',dir:'call'};
  if( pB&&pb<Math.abs(pp.close-pp.open)*0.5&&!cB&&c.close<(pp.open+pp.close)/2&&pp.close>pp.open)   return{name:'EVENING STAR',dir:'put' };
  if( cB&&cu<cb*0.05&&cd<cb*0.05&&cb>pb*1.2)                                            return{name:'BULL MARUBOZU',    dir:'call'};
  if(!cB&&cu<cb*0.05&&cd<cb*0.05&&cb>pb*1.2)                                            return{name:'BEAR MARUBOZU',    dir:'put' };
  if(!pB&&cB&&c.open<p.low&&c.close>(p.open+p.close)/2&&c.close<p.open)                 return{name:'PIERCING LINE',    dir:'call'};
  if( pB&&!cB&&c.open>p.high&&c.close<(p.open+p.close)/2&&c.close>p.open)               return{name:'DARK CLOUD',       dir:'put' };
  if(pd>pb*2&&pu<pb*0.5&&!cB&&c.close<p.close)                                          return{name:'HANGING MAN',      dir:'put' };
  if(pu>pb*2&&pd<pb*0.5&& cB&&c.close>p.close)                                          return{name:'INV HAMMER',       dir:'call'};
  const pp2=cc[cc.length-4];
  if(pp2&&cB&&pB&&pp.close>pp.open&&c.close>p.close&&p.close>pp.close)                  return{name:'3 WHITE SOLDIERS', dir:'call'};
  if(pp2&&!cB&&!pB&&!(pp.close>pp.open)&&c.close<p.close&&p.close<pp.close)             return{name:'3 BLACK CROWS',    dir:'put' };
  return{name:'—',dir:'none'};
}

// ═══════════════════════════════════════════════
//  INDICATORS
// ═══════════════════════════════════════════════
function calcRSI(cc,n=14){
  if(cc.length<n+1)return 50;
  let g=0,l=0;
  for(let i=cc.length-n;i<cc.length;i++){
    const d=cc[i].close-cc[i-1].close;
    d>0?g+=d:l+=Math.abs(d);
  }
  return Math.round(100-100/(1+((g/n)/((l/n)||0.001))));
}

function calcTrend(cc,n=10){
  if(cc.length<n)return'neutral';
  const s=cc.slice(-n),pct=(s[s.length-1].close-s[0].close)/s[0].close*100;
  return pct>0.3?'up':pct<-0.3?'down':'neutral';
}

function calcVol(cc){
  if(cc.length<6)return true;
  return cc[cc.length-1].volume>cc.slice(-6,-1).reduce((s,c)=>s+c.volume,0)/5*0.8;
}

function calcConf(pat,rsi,tr,vol){
  let s=50;
  if(STRONG_PATTERNS.includes(pat.name))s+=20;
  else if(ALL_PATTERNS.includes(pat.name))s+=12;

  // RSI scoring — strict mode raises the bar
  if(settings.rsiMode==='strict'){
    if(pat.dir==='call'){if(rsi<35)s+=18;else if(rsi<45)s+=5;else if(rsi>60)s-=15;else s-=10;}
    else if(pat.dir==='put'){if(rsi>65)s+=18;else if(rsi>55)s+=5;else if(rsi<40)s-=15;else s-=10;}
  } else {
    if(pat.dir==='call'){if(rsi<30)s+=15;else if(rsi<45)s+=8;else if(rsi>70)s-=10;}
    else if(pat.dir==='put'){if(rsi>70)s+=15;else if(rsi>55)s+=8;else if(rsi<30)s-=10;}
  }

  if(pat.dir==='call'&&tr==='up')   s+=10;
  else if(pat.dir==='put'&&tr==='down') s+=10;
  else if(pat.dir==='call'&&tr==='down')s-=8;
  else if(pat.dir==='put' &&tr==='up')  s-=8;
  if(vol)s+=5;
  return Math.min(99,Math.max(10,s));
}

function passesPatternFilter(pat){
  if(pat.dir==='none')return false;
  if(settings.patternMode==='strong')return STRONG_PATTERNS.includes(pat.name);
  return ALL_PATTERNS.includes(pat.name);
}

function passesRsiFilter(pat,rsi){
  if(settings.rsiMode!=='strict')return true;
  if(pat.dir==='call')return rsi<45;
  if(pat.dir==='put') return rsi>55;
  return false;
}

// ═══════════════════════════════════════════════
//  MAIN SCAN
// ═══════════════════════════════════════════════
async function runScan(){
  if(!settings.running)return;
  console.log(`[${utcTime()}] Scan | TF:${settings.tf}m | Conf:${settings.minConf}% | Mode:${settings.mode} | Pat:${settings.patternMode} | RSI:${settings.rsiMode} | Freq:${settings.maxSignals}`);

  const pairs = getActivePairs();
  let candidates = [];

  for(const pair of pairs){
    const cc = await fetchCandles(pair.s);
    scanCount++;
    if(!cc||cc.length<5){await sleep(80);continue;}

    const price = cc[cc.length-1].close;
    const pat   = detectPattern(cc);
    const rsi   = calcRSI(cc);
    const tr    = calcTrend(cc);
    const vol   = calcVol(cc);
    const conf  = calcConf(pat,rsi,tr,vol);

    // Apply all filters
    if(!passesPatternFilter(pat)){await sleep(80);continue;}
    if(!passesRsiFilter(pat,rsi)){await sleep(80);continue;}
    if(conf<settings.minConf){await sleep(80);continue;}

    let sig='wait';
    if(pat.dir==='call')sig='call';
    else if(pat.dir==='put')sig='put';

    if(sig!=='wait'){
      candidates.push({pair,price:fmtP(price,pair.s),rawPrice:price,pat,sig,conf,rsi});
    }
    await sleep(120);
  }

  // Sort by confidence, take top N based on frequency setting
  candidates.sort((a,b)=>b.conf-a.conf);
  const toFire = candidates.slice(0, settings.maxSignals);

  if(toFire.length===0){
    console.log(`[${utcTime()}] No signals this scan`);
  } else {
    for(const sig of toFire){
      await fireSignal(sig);
      await sleep(500);
    }
  }

  await checkPendingResults();
}

// ═══════════════════════════════════════════════
//  FIRE SIGNAL
// ═══════════════════════════════════════════════
async function fireSignal(s){
  const entry={
    id:          Date.now(),
    pair:        s.pair.d,
    sym:         s.pair.s,
    dir:         s.sig,
    pat:         s.pat.name,
    conf:        s.conf,
    rsi:         s.rsi,
    tf:          settings.tf,
    entryPrice:  s.price,
    rawEntry:    s.rawPrice,
    entryTime:   new Date().toISOString(),
    result:      'pending',
    resultPrice: null,
    rawExit:     null,
    checkAfter:  Date.now()+(settings.tf*2*60*1000)
  };

  signalLog.unshift(entry);
  if(signalLog.length>500)signalLog.pop();
  hourlyLog.unshift(entry);

  const arr   = s.sig==='call'?'🟢':'🔴';
  const dir   = s.sig==='call'?'▲ CALL':'▼ PUT';
  const enter = settings.tf===1?'25 seconds':'90 seconds';

  console.log(`[${utcTime()}] SIGNAL: ${dir} ${s.pair.d} | ${s.pat.name} | ${s.conf}%`);

  await tgSend(
`🤖 <b>QXSIGNAL — LIVE SIGNAL</b>

${arr} <b>${dir} — ${s.pair.d}</b>

📊 Pattern: <b>${s.pat.name}</b>
💪 Confidence: <b>${s.conf}%</b>
📈 RSI: <b>${s.rsi}</b>
💰 Entry Price: <b>${s.price}</b>
⏱ Timeframe: <b>${settings.tf} MIN</b>
⏳ Enter within: <b>${enter}</b>

🔔 Result will follow after expiry
<i>/help for all commands</i>`
  );
}

// ═══════════════════════════════════════════════
//  CHECK RESULTS
// ═══════════════════════════════════════════════
async function checkPendingResults(){
  const now = Date.now();
  const due = signalLog.filter(s=>s.result==='pending'&&s.checkAfter<=now);
  for(const sig of due){
    const price = await fetchPrice(sig.sym);
    if(!price)continue;
    const exitPrice = fmtP(price,sig.sym);
    const result    = sig.dir==='call'?(price>sig.rawEntry?'win':'loss'):(price<sig.rawEntry?'win':'loss');
    sig.result=result; sig.resultPrice=exitPrice; sig.rawExit=price;
    if(result==='win')totalWins++;else totalLosses++;
    const h=hourlyLog.find(x=>x.id===sig.id);
    if(h){h.result=result;h.resultPrice=exitPrice;}
    const emoji  = result==='win'?'✅':'❌';
    const res    = result==='win'?'WIN 🏆':'LOSS 💔';
    const moved  = sig.dir==='call'?(price>sig.rawEntry?'📈 Price went UP ✓':'📉 Price went DOWN ✗'):(price<sig.rawEntry?'📉 Price went DOWN ✓':'📈 Price went UP ✗');
    const allT   = totalWins+totalLosses;
    const wr     = allT>0?Math.round(totalWins/allT*100):0;
    console.log(`[${utcTime()}] RESULT: ${res} | ${sig.pair} | ${sig.entryPrice}→${exitPrice}`);
    await tgSend(
`${emoji} <b>SIGNAL RESULT — ${res}</b>

${sig.dir==='call'?'▲':'▼'} <b>${sig.dir.toUpperCase()} — ${sig.pair}</b>
📊 Pattern: ${sig.pat} (${sig.conf}%)
💰 Entry: <b>${sig.entryPrice}</b>
🏁 Exit:  <b>${exitPrice}</b>
${moved}

📊 Session: ${totalWins}W / ${totalLosses}L | WR: ${wr}%`
    );
    await sleep(300);
  }
}

// ═══════════════════════════════════════════════
//  SCAN LOOP
// ═══════════════════════════════════════════════
function restartScanLoop(){
  if(scanTimer)clearInterval(scanTimer);
  const interval=settings.tf*60*1000;
  scanTimer=setInterval(async()=>{await runScan();},interval);
  console.log(`[${utcTime()}] Scan loop: every ${settings.tf} min`);
}

// ═══════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════
async function sendStartup(){
  const pairs=getActivePairs();
  const weekend=isWeekend()?'⚠️ Weekend — Crypto only':'✅ Full market hours';
  await tgSend(
`🚀 <b>QXSIGNAL BOT STARTED</b>

${settingsSummary()}
📡 Active Pairs: <b>${pairs.length}</b>
${weekend}

<b>📲 KEY COMMANDS:</b>
/tf1 /tf5 — Timeframe
/conf65 /conf75 /conf85 — Accuracy
/freq1 /freq3 /freqall — Frequency
/strong /allpatterns — Pattern filter
/rsistrict /rsinormal — RSI filter
/crypto /fx /both — Pair mode
/status — Current settings
/help — All commands

<i>Running 24/7 on Railway ☁️</i>`
  );
}

// ═══════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════
async function main(){
  console.log('══════════════════════════════════');
  console.log('   QXSIGNAL BOT — STARTING UP    ');
  console.log('══════════════════════════════════');

  await sendStartup();
  await runScan();
  restartScanLoop();

  // Poll commands every 2 seconds
  setInterval(pollUpdates, 2000);

  // Hourly report
  setInterval(sendHourlyReport, 60*60*1000);

  console.log(`[${utcTime()}] All systems running`);
}

main().catch(async err=>{
  console.error('Fatal:', err);
  await tgSend(`🚨 <b>BOT ERROR</b>\n\n${err.message}\n\nRestarting...`);
  process.exit(1);
});
