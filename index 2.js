const https = require('https');

// ═══════════════════════════════════════════════
//  CREDENTIALS
// ═══════════════════════════════════════════════
const TG_TOKEN = process.env.TG_TOKEN || '8935289763:AAE6a671d7cAoOhssmIKi_aKz57APta4C6Y';
const TG_CHAT  = process.env.TG_CHAT  || '572971062';

// ═══════════════════════════════════════════════
//  SETTINGS — changeable via Telegram
// ═══════════════════════════════════════════════
let cfg = {
  tf:       1,        // 1 or 5 minutes
  minConf:  50,       // start at 50% — fire more signals
  mode:     'both',   // crypto / fx / both
  running:  true,
  maxSigs:  3,        // fire top 3 per scan
};

// ═══════════════════════════════════════════════
//  PAIRS
// ═══════════════════════════════════════════════
const PAIRS = [
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

// ═══════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════
let signalLog   = [];
let hourlyLog   = [];
let totalWins   = 0;
let totalLosses = 0;
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
function isWeekend() { const d=new Date().getDay(); return d===0||d===6; }
function getActivePairs() {
  if (isWeekend()) return PAIRS.filter(p=>p.crypto);
  if (cfg.mode==='crypto') return PAIRS.filter(p=>p.crypto);
  if (cfg.mode==='fx') return PAIRS.filter(p=>!p.crypto);
  return PAIRS;
}
function utcTime() { return new Date().toUTCString().slice(17,25)+' UTC'; }
function utcFull() { return new Date().toUTCString().slice(5,25)+' UTC'; }
function wrBar(wr) { const f=Math.min(10,Math.max(0,Math.round(wr/10))); return '█'.repeat(f)+'░'.repeat(10-f); }
function cfgLine() {
  return `⏱ <b>${cfg.tf}MIN</b> | 💪 <b>${cfg.minConf}%</b> | 📡 <b>${cfg.mode.toUpperCase()}</b> | 🔢 <b>Top ${cfg.maxSigs}/scan</b>`;
}

// ═══════════════════════════════════════════════
//  HTTP
// ═══════════════════════════════════════════════
function httpGet(url) {
  return new Promise((resolve,reject) => {
    https.get(url, res => {
      let d='';
      res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} });
    }).on('error',reject);
  });
}
function httpPost(url,body) {
  return new Promise((resolve,reject) => {
    const data=JSON.stringify(body);
    const opts={method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}};
    const req=https.request(url,opts,res=>{
      let d='';
      res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} });
    });
    req.on('error',reject);
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════
async function tgSend(text) {
  try {
    await httpPost(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      {chat_id:TG_CHAT, text, parse_mode:'HTML'});
  } catch(e) { console.error('TG error:',e.message); }
}

// ═══════════════════════════════════════════════
//  POLLING
// ═══════════════════════════════════════════════
async function poll() {
  try {
    const d=await httpGet(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${pollOffset}&timeout=5&limit=20`);
    if(!d.ok)return;
    for(const u of d.result){
      pollOffset=u.update_id+1;
      if(u.message&&u.message.text&&String(u.message.chat.id)===TG_CHAT){
        await handleCmd(u.message.text.trim().toLowerCase().split('@')[0]);
      }
    }
  } catch(e){}
}

// ═══════════════════════════════════════════════
//  COMMANDS
// ═══════════════════════════════════════════════
async function handleCmd(cmd) {
  console.log(`[${utcTime()}] CMD: ${cmd}`);
  const reply = async (txt) => await tgSend(txt+'\n\n'+cfgLine());

  if(cmd==='/tf1'){cfg.tf=1;restartLoop();await reply('✅ <b>Timeframe → 1 MIN</b>');await runScan();return;}
  if(cmd==='/tf5'){cfg.tf=5;restartLoop();await reply('✅ <b>Timeframe → 5 MIN</b>');await runScan();return;}

  if(cmd==='/conf50'){cfg.minConf=50;await reply('✅ <b>Confidence → 50%</b> — Max signals');return;}
  if(cmd==='/conf55'){cfg.minConf=55;await reply('✅ <b>Confidence → 55%</b>');return;}
  if(cmd==='/conf60'){cfg.minConf=60;await reply('✅ <b>Confidence → 60%</b>');return;}
  if(cmd==='/conf65'){cfg.minConf=65;await reply('✅ <b>Confidence → 65%</b> ⭐ Recommended');return;}
  if(cmd==='/conf70'){cfg.minConf=70;await reply('✅ <b>Confidence → 70%</b>');return;}
  if(cmd==='/conf75'){cfg.minConf=75;await reply('✅ <b>Confidence → 75%</b> — High quality');return;}
  if(cmd==='/conf80'){cfg.minConf=80;await reply('✅ <b>Confidence → 80%</b>');return;}
  if(cmd==='/conf85'){cfg.minConf=85;await reply('✅ <b>Confidence → 85%</b> — Very selective');return;}
  if(cmd==='/conf90'){cfg.minConf=90;await reply('✅ <b>Confidence → 90%</b> — Elite only');return;}

  if(cmd==='/freq1'){cfg.maxSigs=1;await reply('✅ <b>Frequency → 1 signal/scan</b>');return;}
  if(cmd==='/freq3'){cfg.maxSigs=3;await reply('✅ <b>Frequency → 3 signals/scan</b>');return;}
  if(cmd==='/freq5'){cfg.maxSigs=5;await reply('✅ <b>Frequency → 5 signals/scan</b>');return;}
  if(cmd==='/freqall'){cfg.maxSigs=99;await reply('✅ <b>Frequency → All signals</b>');return;}

  if(cmd==='/crypto'){cfg.mode='crypto';await reply('✅ <b>Mode → Crypto Only</b>\n12 pairs — 24/7');return;}
  if(cmd==='/fx'){
    if(isWeekend()){await tgSend('⚠️ FX closed on weekends. Using crypto.');return;}
    cfg.mode='fx';await reply('✅ <b>Mode → FX Only</b>\n4 pairs — weekdays only');return;
  }
  if(cmd==='/both'){cfg.mode='both';await reply('✅ <b>Mode → Crypto + FX</b>');return;}

  if(cmd==='/stop'){cfg.running=false;clearInterval(scanTimer);await tgSend('⏹ <b>Bot paused.</b> Send /start to resume.');return;}
  if(cmd==='/start'){
    if(cfg.running){await tgSend('ℹ️ Already running.');return;}
    cfg.running=true;restartLoop();await tgSend('▶️ <b>Bot resumed!</b>');await runScan();return;
  }
  if(cmd==='/scan'){await tgSend('🔍 Scanning now...');await runScan();return;}

  if(cmd==='/status'){
    const t=totalWins+totalLosses;
    const wr=t>0?Math.round(totalWins/t*100):0;
    await tgSend(
`📊 <b>BOT STATUS</b>

▶️ Running: <b>${cfg.running?'YES ✅':'PAUSED ⏸'}</b>
${cfgLine()}
📡 Active Pairs: <b>${getActivePairs().length}</b>
${isWeekend()?'⚠️ Weekend — Crypto only':'✅ Full market hours'}

✅ Wins: <b>${totalWins}</b> | ❌ Losses: <b>${totalLosses}</b>
🏆 Win Rate: <b>${wr}%</b> [${wrBar(wr)}]
📊 Total Signals: <b>${signalLog.length}</b>`);
    return;
  }

  if(cmd==='/results'){await tgSend(buildResults());return;}
  if(cmd==='/stats'){await tgSend(buildStats());return;}
  if(cmd==='/report'){await sendReport();return;}
  if(cmd==='/pairs'){
    const p=getActivePairs();
    await tgSend(`📡 <b>ACTIVE PAIRS (${p.length})</b>\n\n🪙 Crypto: ${p.filter(x=>x.crypto).map(x=>x.d).join(', ')}\n\n💱 FX: ${p.filter(x=>!x.crypto).map(x=>x.d).join(', ')||'None'}`);
    return;
  }

  if(cmd==='/help'){
    await tgSend(
`🤖 <b>QXSIGNAL — ALL COMMANDS</b>

<b>⏱ TIMEFRAME</b>
/tf1 /tf5

<b>💪 ACCURACY</b>
/conf50 /conf55 /conf60
/conf65 /conf70 /conf75
/conf80 /conf85 /conf90

<b>🔢 FREQUENCY</b>
/freq1 /freq3 /freq5 /freqall

<b>📡 PAIRS</b>
/crypto /fx /both

<b>🎮 CONTROL</b>
/start /stop /scan

<b>📊 INFO</b>
/status /pairs /results /stats /report /help`);
    return;
  }

  await tgSend('❓ Unknown command. Type /help');
}

// ═══════════════════════════════════════════════
//  FETCH CANDLES
// ═══════════════════════════════════════════════
async function fetchCandles(sym) {
  try {
    const iv=cfg.tf===1?'1m':'5m';
    const d=await httpGet(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=60`);
    if(!Array.isArray(d))return null;
    return d.map(c=>({o:+c[1],h:+c[2],l:+c[3],c:+c[4],v:+c[5]}));
  } catch(e){return null;}
}

async function fetchPrice(sym) {
  try {
    const d=await httpGet(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
    return parseFloat(d.price);
  } catch(e){return null;}
}

// ═══════════════════════════════════════════════
//  SIGNAL ANALYSIS — simplified & reliable
// ═══════════════════════════════════════════════
function analyze(candles) {
  if(!candles||candles.length<10) return null;

  const last  = candles[candles.length-1]; // current candle
  const prev  = candles[candles.length-2]; // previous candle
  const prev2 = candles[candles.length-3]; // 2 candles ago

  // Body sizes
  const lastBody = Math.abs(last.c - last.o);
  const prevBody = Math.abs(prev.c - prev.o);
  const lastRange = last.h - last.l;
  const prevRange = prev.h - prev.l;

  // Wicks
  const lastUpper = last.h - Math.max(last.o, last.c);
  const lastLower = Math.min(last.o, last.c) - last.l;
  const prevUpper = prev.h - Math.max(prev.o, prev.c);
  const prevLower = Math.min(prev.o, prev.c) - prev.l;

  // Candle direction
  const lastBull = last.c > last.o;
  const prevBull = prev.c > prev.o;
  const prev2Bull = prev2.c > prev2.o;

  // RSI (14)
  let gains=0, losses=0;
  for(let i=candles.length-14; i<candles.length; i++){
    const diff = candles[i].c - candles[i-1].c;
    if(diff>0) gains+=diff; else losses+=Math.abs(diff);
  }
  const rsi = Math.round(100 - 100/(1+((gains/14)/((losses/14)||0.001))));

  // Trend (last 10 candles)
  const slice10 = candles.slice(-10);
  const trendPct = (slice10[9].c - slice10[0].c) / slice10[0].c * 100;
  const trend = trendPct > 0.2 ? 'up' : trendPct < -0.2 ? 'down' : 'flat';

  // Volume confirmation
  const avgVol = candles.slice(-6,-1).reduce((s,c)=>s+c.v,0)/5;
  const volOk = last.v > avgVol * 0.7;

  let signal = null;
  let pattern = null;
  let score = 0;

  // ── PATTERN CHECKS ──────────────────────────

  // 1. Bullish Engulfing
  if(!prevBull && lastBull && last.o<=prev.c && last.c>=prev.o && lastBody>prevBody*0.8){
    pattern='BULLISH ENGULFING'; signal='call'; score=70;
  }
  // 2. Bearish Engulfing
  else if(prevBull && !lastBull && last.o>=prev.c && last.c<=prev.o && lastBody>prevBody*0.8){
    pattern='BEARISH ENGULFING'; signal='put'; score=70;
  }
  // 3. Hammer
  else if(lastLower>lastBody*1.5 && lastUpper<lastBody*0.8 && lastRange>0){
    pattern='HAMMER'; signal='call'; score=62;
  }
  // 4. Shooting Star
  else if(lastUpper>lastBody*1.5 && lastLower<lastBody*0.8 && lastRange>0){
    pattern='SHOOTING STAR'; signal='put'; score=62;
  }
  // 5. Morning Star
  else if(!prev2Bull && Math.abs(prev.c-prev.o)<prevBody*0.6 && lastBull && last.c>(prev2.o+prev2.c)/2){
    pattern='MORNING STAR'; signal='call'; score=72;
  }
  // 6. Evening Star
  else if(prev2Bull && Math.abs(prev.c-prev.o)<prevBody*0.6 && !lastBull && last.c<(prev2.o+prev2.c)/2){
    pattern='EVENING STAR'; signal='put'; score=72;
  }
  // 7. Bull Marubozu
  else if(lastBull && lastUpper<lastBody*0.1 && lastLower<lastBody*0.1 && lastBody>prevBody){
    pattern='BULL MARUBOZU'; signal='call'; score=68;
  }
  // 8. Bear Marubozu
  else if(!lastBull && lastUpper<lastBody*0.1 && lastLower<lastBody*0.1 && lastBody>prevBody){
    pattern='BEAR MARUBOZU'; signal='put'; score=68;
  }
  // 9. Piercing Line
  else if(!prevBull && lastBull && last.o<prev.l && last.c>(prev.o+prev.c)/2){
    pattern='PIERCING LINE'; signal='call'; score=65;
  }
  // 10. Dark Cloud Cover
  else if(prevBull && !lastBull && last.o>prev.h && last.c<(prev.o+prev.c)/2){
    pattern='DARK CLOUD'; signal='put'; score=65;
  }
  // 11. Three White Soldiers
  else if(lastBull && prevBull && prev2Bull && last.c>prev.c && prev.c>prev2.c){
    pattern='3 WHITE SOLDIERS'; signal='call'; score=75;
  }
  // 12. Three Black Crows
  else if(!lastBull && !prevBull && !prev2Bull && last.c<prev.c && prev.c<prev2.c){
    pattern='3 BLACK CROWS'; signal='put'; score=75;
  }
  // 13. Doji reversal
  else if(lastBody<lastRange*0.1 && lastRange>0){
    // Doji after uptrend = put, after downtrend = call
    if(trend==='up'&&prevBull){pattern='DOJI REVERSAL';signal='put';score=55;}
    else if(trend==='down'&&!prevBull){pattern='DOJI REVERSAL';signal='call';score=55;}
  }
  // 14. Strong momentum — big candle in trend direction
  else if(lastBull && lastBody>prevBody*1.5 && trend==='up' && rsi<70){
    pattern='BULL MOMENTUM'; signal='call'; score=60;
  }
  else if(!lastBull && lastBody>prevBody*1.5 && trend==='down' && rsi>30){
    pattern='BEAR MOMENTUM'; signal='put'; score=60;
  }
  // 15. RSI oversold bounce
  else if(rsi<30 && lastBull && lastLower>lastUpper){
    pattern='RSI OVERSOLD'; signal='call'; score=58;
  }
  // 16. RSI overbought drop
  else if(rsi>70 && !lastBull && lastUpper>lastLower){
    pattern='RSI OVERBOUGHT'; signal='put'; score=58;
  }

  if(!signal) return null;

  // ── SCORE ADJUSTMENTS ────────────────────────

  // RSI confirmation
  if(signal==='call'){
    if(rsi<35) score+=12;
    else if(rsi<50) score+=6;
    else if(rsi>65) score-=8;
  } else {
    if(rsi>65) score+=12;
    else if(rsi>50) score+=6;
    else if(rsi<35) score-=8;
  }

  // Trend alignment
  if(signal==='call'&&trend==='up') score+=8;
  else if(signal==='put'&&trend==='down') score+=8;
  else if(signal==='call'&&trend==='down') score-=6;
  else if(signal==='put'&&trend==='up') score-=6;

  // Volume confirmation
  if(volOk) score+=5;

  score = Math.min(99, Math.max(30, score));

  return { signal, pattern, score, rsi, trend };
}

// ═══════════════════════════════════════════════
//  MAIN SCAN
// ═══════════════════════════════════════════════
async function runScan() {
  if(!cfg.running) return;
  const pairs = getActivePairs();
  console.log(`[${utcTime()}] Scanning ${pairs.length} pairs | conf:${cfg.minConf}%`);

  let candidates = [];

  for(const pair of pairs){
    try{
      const candles = await fetchCandles(pair.s);
      if(!candles||candles.length<15){ await sleep(200); continue; }

      const result = analyze(candles);
      if(!result){ await sleep(150); continue; }

      const {signal,pattern,score,rsi,trend} = result;
      const price = candles[candles.length-1].c;

      if(score >= cfg.minConf){
        candidates.push({
          pair, signal, pattern, score, rsi, trend,
          price: fmtP(price, pair.s), rawPrice: price
        });
        console.log(`[${utcTime()}] CANDIDATE: ${signal.toUpperCase()} ${pair.d} | ${pattern} | ${score}%`);
      }
    } catch(e){
      console.error(`Error scanning ${pair.s}:`, e.message);
    }
    await sleep(150);
  }

  // Sort by score, take top N
  candidates.sort((a,b)=>b.score-a.score);
  const toFire = candidates.slice(0, cfg.maxSigs);

  if(toFire.length===0){
    console.log(`[${utcTime()}] No signals (${candidates.length} candidates below ${cfg.minConf}%)`);
  } else {
    console.log(`[${utcTime()}] Firing ${toFire.length} signal(s)`);
    for(const s of toFire){
      await fireSignal(s);
      await sleep(800);
    }
  }

  await checkResults();
}

// ═══════════════════════════════════════════════
//  FIRE SIGNAL
// ═══════════════════════════════════════════════
async function fireSignal(s) {
  const entry = {
    id:          Date.now()+ Math.random(),
    pair:        s.pair.d,
    sym:         s.pair.s,
    dir:         s.signal,
    pat:         s.pattern,
    conf:        s.score,
    rsi:         s.rsi,
    entryPrice:  s.price,
    rawEntry:    s.rawPrice,
    entryTime:   new Date().toISOString(),
    result:      'pending',
    resultPrice: null,
    rawExit:     null,
    checkAfter:  Date.now()+(cfg.tf*2*60*1000)
  };

  signalLog.unshift(entry);
  if(signalLog.length>500) signalLog.pop();
  hourlyLog.unshift(entry);

  const arr   = s.signal==='call'?'🟢':'🔴';
  const dir   = s.signal==='call'?'▲ CALL':'▼ PUT';
  const enter = cfg.tf===1?'25 seconds':'90 seconds';

  console.log(`[${utcTime()}] SIGNAL SENT: ${dir} ${s.pair.d} | ${s.pattern} | ${s.score}%`);

  await tgSend(
`🤖 <b>QXSIGNAL — LIVE SIGNAL</b>

${arr} <b>${dir} — ${s.pair.d}</b>

📊 Pattern: <b>${s.pattern}</b>
💪 Confidence: <b>${s.score}%</b>
📈 RSI: <b>${s.rsi}</b>
📉 Trend: <b>${s.trend.toUpperCase()}</b>
💰 Entry Price: <b>${s.price}</b>
⏱ Timeframe: <b>${cfg.tf} MIN</b>
⏳ Enter within: <b>${enter}</b>

🔔 Result follows after expiry`
  );
}

// ═══════════════════════════════════════════════
//  CHECK RESULTS
// ═══════════════════════════════════════════════
async function checkResults() {
  const now = Date.now();
  const due = signalLog.filter(s=>s.result==='pending'&&s.checkAfter<=now);
  for(const sig of due){
    try{
      const price = await fetchPrice(sig.sym);
      if(!price) continue;
      const exit   = fmtP(price, sig.sym);
      const result = sig.dir==='call'?(price>sig.rawEntry?'win':'loss'):(price<sig.rawEntry?'win':'loss');
      sig.result=result; sig.resultPrice=exit; sig.rawExit=price;
      if(result==='win') totalWins++; else totalLosses++;
      const h=hourlyLog.find(x=>x.id===sig.id);
      if(h){h.result=result;h.resultPrice=exit;}
      const emoji  = result==='win'?'✅':'❌';
      const res    = result==='win'?'WIN 🏆':'LOSS 💔';
      const moved  = sig.dir==='call'?(price>sig.rawEntry?'📈 UP ✓':'📉 DOWN ✗'):(price<sig.rawEntry?'📉 DOWN ✓':'📈 UP ✗');
      const t      = totalWins+totalLosses;
      const wr     = t>0?Math.round(totalWins/t*100):0;
      await tgSend(
`${emoji} <b>RESULT — ${res}</b>

${sig.dir==='call'?'▲':'▼'} <b>${sig.dir.toUpperCase()} — ${sig.pair}</b>
📊 ${sig.pat} (${sig.conf}%)
💰 Entry: <b>${sig.entryPrice}</b> → Exit: <b>${exit}</b>
${moved}

📊 Session: ${totalWins}W/${totalLosses}L | WR: ${wr}%`
      );
      await sleep(400);
    }catch(e){console.error('Result check error:',e.message);}
  }
}

// ═══════════════════════════════════════════════
//  RESULTS & STATS
// ═══════════════════════════════════════════════
function buildResults() {
  const last=signalLog.slice(0,10);
  if(!last.length) return '📊 <b>RESULTS</b>\n\nNo signals yet.';
  let msg='📊 <b>LAST 10 RESULTS</b>\n\n';
  last.forEach(s=>{
    const e=s.result==='win'?'✅':s.result==='loss'?'❌':'⏳';
    const r=s.result==='win'?'WIN':s.result==='loss'?'LOSS':'PENDING';
    const t=new Date(s.entryTime).toUTCString().slice(17,22);
    msg+=`${e} <b>${s.dir==='call'?'▲':'▼'} ${s.pair}</b> — <b>${r}</b>\n`;
    msg+=`   ${s.pat} (${s.conf}%) | ${s.entryPrice}→${s.resultPrice||'?'} @${t}\n\n`;
  });
  return msg;
}

function buildStats() {
  const t=totalWins+totalLosses;
  const wr=t>0?Math.round(totalWins/t*100):0;
  const pend=signalLog.filter(s=>s.result==='pending').length;
  return `📈 <b>QXSIGNAL STATS</b>

🏆 Win Rate: <b>${wr}%</b>
[${wrBar(wr)}]

✅ Wins: <b>${totalWins}</b>
❌ Losses: <b>${totalLosses}</b>
⏳ Pending: <b>${pend}</b>
📊 Total: <b>${signalLog.length}</b>

${cfgLine()}`;
}

// ═══════════════════════════════════════════════
//  HOURLY REPORT
// ═══════════════════════════════════════════════
async function sendReport() {
  const res  = hourlyLog.filter(s=>s.result!=='pending');
  const pend = hourlyLog.filter(s=>s.result==='pending');
  const wins = res.filter(s=>s.result==='win').length;
  const loss = res.filter(s=>s.result==='loss').length;
  const wr   = res.length>0?Math.round(wins/res.length*100):0;
  const aT   = totalWins+totalLosses;
  const aWR  = aT>0?Math.round(totalWins/aT*100):0;
  const perf = wr>=70?'🔥 Excellent!':wr>=60?'✅ Good':wr>=50?'📊 Average':wins===0&&loss===0?'😴 Quiet hour':'⚠️ Tough hour';

  let details='';
  if(res.length>0){
    details='\n<b>Signals:</b>\n';
    res.slice(0,8).forEach(s=>{
      const r=s.result==='win'?'✅':'❌';
      const t=new Date(s.entryTime).toUTCString().slice(17,22);
      details+=`${r} ${s.dir==='call'?'▲':'▼'} ${s.pair} | ${s.pat} | ${s.entryPrice}→${s.resultPrice||'?'} @${t}\n`;
    });
  }

  await tgSend(
`📊 <b>HOURLY REPORT</b>
🕐 ${utcFull()}

${perf}

<b>THIS HOUR</b>
✅ Wins: <b>${wins}</b> | ❌ Losses: <b>${loss}</b>
⏳ Pending: <b>${pend.length}</b> | 📈 Total: <b>${hourlyLog.length}</b>
🏆 Win Rate: <b>${wr}%</b> [${wrBar(wr)}]

<b>ALL TIME</b>
✅ <b>${totalWins}</b> | ❌ <b>${totalLosses}</b> | 🏆 <b>${aWR}%</b> | 📊 <b>${signalLog.length}</b>
${details}
${cfgLine()}
<i>Next report in 1 hour | /help for commands</i>`
  );
  hourlyLog=[];
  console.log(`[${utcTime()}] Hourly report: ${wins}W/${loss}L | Overall: ${aWR}%`);
}

// ═══════════════════════════════════════════════
//  LOOP
// ═══════════════════════════════════════════════
function restartLoop(){
  if(scanTimer) clearInterval(scanTimer);
  scanTimer=setInterval(async()=>{ await runScan(); }, cfg.tf*60*1000);
  console.log(`[${utcTime()}] Loop: every ${cfg.tf} min`);
}

// ═══════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════
async function main(){
  console.log('════════════════════════════');
  console.log('  QXSIGNAL BOT — STARTING  ');
  console.log('════════════════════════════');

  await tgSend(
`🚀 <b>QXSIGNAL BOT STARTED</b>

${cfgLine()}
📡 Pairs: <b>${getActivePairs().length}</b>
${isWeekend()?'⚠️ Weekend — Crypto only':'✅ Full market hours'}

🕯 16 pattern types detected
📊 Hourly report every 60 min
🔔 Results after each expiry

<b>Commands:</b> /help
<i>Running 24/7 on Railway ☁️</i>`
  );

  await runScan();
  restartLoop();
  setInterval(poll, 2000);
  setInterval(sendReport, 60*60*1000);

  console.log(`[${utcTime()}] All systems go`);
}

main().catch(async err=>{
  console.error('Fatal:',err);
  await tgSend(`🚨 <b>BOT ERROR</b>\n${err.message}`);
  process.exit(1);
});
