const https = require('https');

// ═══════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════
const TG_TOKEN = process.env.TG_TOKEN || '8935289763:AAE6a671d7cAoOhssmIKi_aKz57APta4C6Y';
const TG_CHAT  = process.env.TG_CHAT  || '572971062';
const TF       = parseInt(process.env.TF       || '1');   // 1 or 5 minutes
const MIN_CONF = parseInt(process.env.MIN_CONF || '65');  // min confidence %

const PAIRS = [
  { s:'BTCUSDT',  d:'BTC/USD',  crypto:true  },
  { s:'ETHUSDT',  d:'ETH/USD',  crypto:true  },
  { s:'BNBUSDT',  d:'BNB/USD',  crypto:true  },
  { s:'SOLUSDT',  d:'SOL/USD',  crypto:true  },
  { s:'XRPUSDT',  d:'XRP/USD',  crypto:true  },
  { s:'ADAUSDT',  d:'ADA/USD',  crypto:true  },
  { s:'DOGEUSDT', d:'DOGE/USD', crypto:true  },
  { s:'LTCUSDT',  d:'LTC/USD',  crypto:true  },
  { s:'AVAXUSDT', d:'AVAX/USD', crypto:true  },
  { s:'DOTUSDT',  d:'DOT/USD',  crypto:true  },
  { s:'LINKUSDT', d:'LINK/USD', crypto:true  },
  { s:'MATICUSDT',d:'MATIC/USD',crypto:true  },
  { s:'EURUSDT',  d:'EUR/USD',  crypto:false },
  { s:'GBPUSDT',  d:'GBP/USD',  crypto:false },
  { s:'AUDUSDT',  d:'AUD/USD',  crypto:false },
  { s:'NZDUSDT',  d:'NZD/USD',  crypto:false },
];

// ═══════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════
let signalLog   = [];   // all signals ever
let hourlyLog   = [];   // signals since last hourly report
let scanCount   = 0;
let totalWins   = 0;
let totalLosses = 0;
let lastHourlyReset = Date.now();

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
  return isWeekend() ? PAIRS.filter(p => p.crypto) : PAIRS;
}

function utcTime() {
  return new Date().toUTCString().slice(17, 25) + ' UTC';
}

function utcDateTime() {
  return new Date().toUTCString().slice(5, 25) + ' UTC';
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
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML'
    });
  } catch(e) {
    console.error('TG error:', e.message);
  }
}

// ═══════════════════════════════════════════════
//  BINANCE
// ═══════════════════════════════════════════════
async function fetchCandles(sym) {
  try {
    const iv = TF === 1 ? '1m' : '5m';
    const d = await httpGet(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=50`);
    return d.map(c => ({ open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
  } catch(e) { return null; }
}

async function fetchPrice(sym) {
  try {
    const d = await httpGet(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
    return parseFloat(d.price);
  } catch(e) { return null; }
}

// ═══════════════════════════════════════════════
//  CANDLE PATTERN DETECTION
// ═══════════════════════════════════════════════
function detectPattern(cc) {
  if (!cc || cc.length < 4) return { name:'—', dir:'none' };
  const c=cc[cc.length-1], p=cc[cc.length-2], pp=cc[cc.length-3];
  const cb=Math.abs(c.close-c.open), pb=Math.abs(p.close-p.open);
  const cr=c.high-c.low;
  const cB=c.close>c.open, pB=p.close>p.open;
  const cu=c.high-Math.max(c.open,c.close), cd=Math.min(c.open,c.close)-c.low;
  const pu=p.high-Math.max(p.open,p.close), pd=Math.min(p.open,p.close)-p.low;

  if (cb < cr*0.08 && cr > 0)                                                          return { name:'DOJI',             dir:'none'  };
  if (!pB && cB && c.open<p.close && c.close>p.open && cb>pb*1.1)                     return { name:'BULLISH ENGULFING',dir:'call'  };
  if ( pB &&!cB && c.open>p.close && c.close<p.open && cb>pb*1.1)                     return { name:'BEARISH ENGULFING',dir:'put'   };
  if (cd > cb*2 && cu < cb*0.5 && cr > 0)                                             return { name:'HAMMER',           dir:'call'  };
  if (cu > cb*2 && cd < cb*0.5 && cr > 0)                                             return { name:'SHOOTING STAR',    dir:'put'   };
  if (!pB && pb<Math.abs(pp.close-pp.open)*0.5 && cB && c.close>(pp.open+pp.close)/2
      && !(pp.close>pp.open))                                                          return { name:'MORNING STAR',     dir:'call'  };
  if ( pB && pb<Math.abs(pp.close-pp.open)*0.5 &&!cB && c.close<(pp.open+pp.close)/2
      && pp.close>pp.open)                                                             return { name:'EVENING STAR',     dir:'put'   };
  if ( cB && cu<cb*0.05 && cd<cb*0.05 && cb>pb*1.2)                                  return { name:'BULL MARUBOZU',    dir:'call'  };
  if (!cB && cu<cb*0.05 && cd<cb*0.05 && cb>pb*1.2)                                  return { name:'BEAR MARUBOZU',    dir:'put'   };
  if (!pB && cB && c.open<p.low && c.close>(p.open+p.close)/2 && c.close<p.open)     return { name:'PIERCING LINE',    dir:'call'  };
  if ( pB &&!cB && c.open>p.high && c.close<(p.open+p.close)/2 && c.close>p.open)    return { name:'DARK CLOUD',       dir:'put'   };
  if (pd>pb*2 && pu<pb*0.5 && !cB && c.close<p.close)                                return { name:'HANGING MAN',      dir:'put'   };
  if (pu>pb*2 && pd<pb*0.5 &&  cB && c.close>p.close)                                return { name:'INV HAMMER',       dir:'call'  };
  const pp2 = cc[cc.length-4];
  if (pp2 && cB && pB && pp.close>pp.open && c.close>p.close && p.close>pp.close)    return { name:'3 WHITE SOLDIERS', dir:'call'  };
  if (pp2 &&!cB &&!pB &&!(pp.close>pp.open)&& c.close<p.close && p.close<pp.close)   return { name:'3 BLACK CROWS',    dir:'put'   };
  return { name:'—', dir:'none' };
}

// ═══════════════════════════════════════════════
//  INDICATORS
// ═══════════════════════════════════════════════
function calcRSI(cc, n=14) {
  if (cc.length < n+1) return 50;
  let g=0, l=0;
  for (let i=cc.length-n; i<cc.length; i++) {
    const d = cc[i].close - cc[i-1].close;
    d > 0 ? g+=d : l+=Math.abs(d);
  }
  return Math.round(100 - 100/(1+((g/n)/((l/n)||0.001))));
}

function calcTrend(cc, n=10) {
  if (cc.length < n) return 'neutral';
  const s = cc.slice(-n);
  const pct = (s[s.length-1].close - s[0].close) / s[0].close * 100;
  return pct > 0.3 ? 'up' : pct < -0.3 ? 'down' : 'neutral';
}

function calcVol(cc) {
  if (cc.length < 6) return true;
  const avg = cc.slice(-6,-1).reduce((s,c) => s+c.volume, 0) / 5;
  return cc[cc.length-1].volume > avg * 0.8;
}

function calcConf(pat, rsi, tr, vol) {
  let s = 50;
  const strong = ['BULLISH ENGULFING','BEARISH ENGULFING','MORNING STAR','EVENING STAR','BULL MARUBOZU','BEAR MARUBOZU','3 WHITE SOLDIERS','3 BLACK CROWS'];
  const med    = ['HAMMER','SHOOTING STAR','PIERCING LINE','DARK CLOUD','HANGING MAN','INV HAMMER'];
  if (strong.includes(pat.name)) s += 20;
  else if (med.includes(pat.name)) s += 12;
  if (pat.dir==='call') { if(rsi<30) s+=15; else if(rsi<45) s+=8; else if(rsi>70) s-=10; }
  else if (pat.dir==='put') { if(rsi>70) s+=15; else if(rsi>55) s+=8; else if(rsi<30) s-=10; }
  if (pat.dir==='call' && tr==='up')   s+=10;
  else if (pat.dir==='put' && tr==='down') s+=10;
  else if (pat.dir==='call' && tr==='down') s-=8;
  else if (pat.dir==='put'  && tr==='up')   s-=8;
  if (vol) s += 5;
  return Math.min(99, Math.max(10, s));
}

// ═══════════════════════════════════════════════
//  MAIN SCAN
// ═══════════════════════════════════════════════
async function runScan() {
  console.log(`[${utcTime()}] Starting scan — TF:${TF}min | Conf:${MIN_CONF}%`);
  const pairs = getActivePairs();
  let best = null, bestConf = 0;

  for (const pair of pairs) {
    const cc = await fetchCandles(pair.s);
    scanCount++;
    if (!cc || cc.length < 5) continue;

    const price  = cc[cc.length-1].close;
    const pat    = detectPattern(cc);
    const rsi    = calcRSI(cc);
    const tr     = calcTrend(cc);
    const vol    = calcVol(cc);
    const conf   = calcConf(pat, rsi, tr, vol);

    let sig = 'wait';
    if (pat.dir === 'call' && conf >= MIN_CONF) sig = 'call';
    else if (pat.dir === 'put'  && conf >= MIN_CONF) sig = 'put';

    if (sig !== 'wait' && conf > bestConf) {
      bestConf = conf;
      best = { pair, price: fmtP(price, pair.s), rawPrice: price, pat, sig, conf, rsi };
    }
    await sleep(120);
  }

  if (best) {
    await fireSignal(best);
  } else {
    console.log(`[${utcTime()}] No signal this scan`);
  }

  // Check pending results
  await checkPendingResults();
}

// ═══════════════════════════════════════════════
//  FIRE SIGNAL
// ═══════════════════════════════════════════════
async function fireSignal(s) {
  const entry = {
    id:         Date.now(),
    pair:       s.pair.d,
    sym:        s.pair.s,
    dir:        s.sig,
    pat:        s.pat.name,
    conf:       s.conf,
    rsi:        s.rsi,
    entryPrice: s.price,
    rawEntry:   s.rawPrice,
    entryTime:  new Date().toISOString(),
    result:     'pending',
    resultPrice: null,
    rawExit:    null,
    checkAfter: Date.now() + (TF * 2 * 60 * 1000)  // check after 2 candles
  };

  signalLog.unshift(entry);
  if (signalLog.length > 500) signalLog.pop();
  hourlyLog.unshift(entry);

  const arr = s.sig === 'call' ? '🟢' : '🔴';
  const dir = s.sig === 'call' ? '▲ CALL' : '▼ PUT';
  const enter = TF === 1 ? '25 seconds' : '90 seconds';

  console.log(`[${utcTime()}] SIGNAL: ${dir} ${s.pair.d} | ${s.pat.name} | ${s.conf}%`);

  await tgSend(
`🤖 <b>QXSIGNAL — LIVE SIGNAL</b>

${arr} <b>${dir} — ${s.pair.d}</b>

📊 Pattern: <b>${s.pat.name}</b>
💪 Confidence: <b>${s.conf}%</b>
📈 RSI: <b>${s.rsi}</b>
💰 Entry Price: <b>${s.price}</b>
⏱ Timeframe: <b>${TF} MIN</b>
⏳ Enter within: <b>${enter}</b>

🔔 Result will follow automatically`
  );
}

// ═══════════════════════════════════════════════
//  RESULT CHECKING
// ═══════════════════════════════════════════════
async function checkPendingResults() {
  const now  = Date.now();
  const due  = signalLog.filter(s => s.result === 'pending' && s.checkAfter <= now);

  for (const sig of due) {
    const price = await fetchPrice(sig.sym);
    if (!price) continue;

    const exitPrice = fmtP(price, sig.sym);
    const result    = sig.dir === 'call'
      ? (price > sig.rawEntry ? 'win' : 'loss')
      : (price < sig.rawEntry ? 'win' : 'loss');

    sig.result      = result;
    sig.resultPrice = exitPrice;
    sig.rawExit     = price;

    if (result === 'win') totalWins++;
    else totalLosses++;

    // Update hourly log entry too
    const hEntry = hourlyLog.find(h => h.id === sig.id);
    if (hEntry) { hEntry.result = result; hEntry.resultPrice = exitPrice; }

    const emoji  = result === 'win' ? '✅' : '❌';
    const res    = result === 'win' ? 'WIN 🏆' : 'LOSS 💔';
    const moved  = sig.dir === 'call'
      ? (price > sig.rawEntry ? '📈 Price went UP ✓' : '📉 Price went DOWN ✗')
      : (price < sig.rawEntry ? '📉 Price went DOWN ✓' : '📈 Price went UP ✗');

    console.log(`[${utcTime()}] RESULT: ${res} | ${sig.pair} | Entry:${sig.entryPrice} Exit:${exitPrice}`);

    await tgSend(
`${emoji} <b>SIGNAL RESULT — ${res}</b>

${sig.dir==='call'?'▲':'▼'} <b>${sig.dir.toUpperCase()} — ${sig.pair}</b>
📊 Pattern: ${sig.pat} (${sig.conf}%)
💰 Entry: <b>${sig.entryPrice}</b>
🏁 Exit: <b>${exitPrice}</b>
${moved}

<i>Result based on price at signal expiry</i>`
    );

    await sleep(300);
  }
}

// ═══════════════════════════════════════════════
//  HOURLY REPORT
// ═══════════════════════════════════════════════
async function sendHourlyReport() {
  const resolved = hourlyLog.filter(s => s.result !== 'pending');
  const pending  = hourlyLog.filter(s => s.result === 'pending');
  const wins     = resolved.filter(s => s.result === 'win').length;
  const losses   = resolved.filter(s => s.result === 'loss').length;
  const total    = resolved.length;
  const wr       = total > 0 ? Math.round(wins/total*100) : 0;
  const wrBar    = total > 0 ? '█'.repeat(Math.round(wr/10)) + '░'.repeat(10-Math.round(wr/10)) : '░░░░░░░░░░';

  // All-time stats
  const allTotal = totalWins + totalLosses;
  const allWR    = allTotal > 0 ? Math.round(totalWins/allTotal*100) : 0;

  // Performance emoji
  const perfEmoji = wr >= 70 ? '🔥' : wr >= 50 ? '📊' : '⚠️';

  // Build signal detail list
  let details = '';
  if (resolved.length > 0) {
    details = '\n<b>📋 Signal Breakdown:</b>\n';
    resolved.slice(0, 10).forEach((s, i) => {
      const r = s.result === 'win' ? '✅' : '❌';
      const arr = s.dir === 'call' ? '▲' : '▼';
      const time = new Date(s.entryTime).toUTCString().slice(17,22);
      details += `${r} ${arr} ${s.pair} — ${s.pat} (${s.conf}%) @ ${time}\n`;
      details += `   ${s.entryPrice} → ${s.resultPrice||'?'}\n`;
    });
  }

  const msg =
`${perfEmoji} <b>QXSIGNAL — HOURLY REPORT</b>
🕐 ${utcDateTime()}

━━━━━━━━━━━━━━━━━━━━
📊 <b>THIS HOUR</b>
━━━━━━━━━━━━━━━━━━━━
✅ Wins:    <b>${wins}</b>
❌ Losses:  <b>${losses}</b>
⏳ Pending: <b>${pending.length}</b>
📈 Total:   <b>${hourlyLog.length} signals</b>

🏆 Win Rate: <b>${wr}%</b>
[${wrBar}]

━━━━━━━━━━━━━━━━━━━━
📅 <b>ALL TIME</b>
━━━━━━━━━━━━━━━━━━━━
✅ Total Wins:   <b>${totalWins}</b>
❌ Total Losses: <b>${totalLosses}</b>
🏆 Overall WR:   <b>${allWR}%</b>
📊 Total Signals: <b>${signalLog.length}</b>
${details}
<i>Next report in 1 hour</i>`;

  await tgSend(msg);
  console.log(`[${utcTime()}] Hourly report sent — ${wins}W/${losses}L this hour`);

  // Reset hourly log
  hourlyLog = [];
  lastHourlyReset = Date.now();
}

// ═══════════════════════════════════════════════
//  STARTUP MESSAGE
// ═══════════════════════════════════════════════
async function sendStartupMessage() {
  const pairs = getActivePairs();
  const weekend = isWeekend() ? '⚠️ Weekend mode — Crypto only' : '✅ Full mode — Crypto + FX';
  await tgSend(
`🚀 <b>QXSIGNAL BOT STARTED</b>

⚙️ Timeframe: <b>${TF} MIN candles</b>
💪 Min Confidence: <b>${MIN_CONF}%</b>
📡 Scanning: <b>${pairs.length} pairs</b>
${weekend}

🕯 Patterns: 13 candle patterns
📈 Indicators: RSI + Trend + Volume
📊 Hourly report: Every 60 minutes
🔔 Results: Sent after each expiry

<i>Bot is now running 24/7 on Railway</i>`
  );
}

// ═══════════════════════════════════════════════
//  MAIN LOOP
// ═══════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════');
  console.log('  QXSIGNAL BOT — STARTING UP  ');
  console.log('═══════════════════════════════');
  console.log(`Timeframe : ${TF} min`);
  console.log(`Min Conf  : ${MIN_CONF}%`);
  console.log(`Token     : ${TG_TOKEN.slice(0,10)}...`);
  console.log(`Chat ID   : ${TG_CHAT}`);
  console.log('═══════════════════════════════');

  await sendStartupMessage();

  const SCAN_INTERVAL  = TF * 60 * 1000;        // scan every candle
  const HOURLY_INTERVAL = 60 * 60 * 1000;        // report every 1 hour

  // First scan immediately
  await runScan();

  // Scan every candle
  setInterval(async () => {
    await runScan();
  }, SCAN_INTERVAL);

  // Hourly report
  setInterval(async () => {
    await sendHourlyReport();
  }, HOURLY_INTERVAL);

  console.log(`[${utcTime()}] Bot running — scanning every ${TF} min`);
}

main().catch(async err => {
  console.error('Fatal error:', err);
  await tgSend(`🚨 <b>BOT ERROR</b>\n\n${err.message}\n\nRestarting...`);
  process.exit(1);
});
