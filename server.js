// ================================================================
// TradeBook Fyers Proxy Server
// Fyers' Data/Order REST APIs don't send CORS headers permitting
// direct browser access, so calls made straight from index.html
// get silently blocked by the browser. This tiny server makes the
// exact same calls from Node (no CORS applies server-to-server)
// and relays the response back to the page.
//
// Your Fyers access token never leaves your machine — it's sent
// from the browser to this local server only, then forwarded to
// Fyers with the same Authorization header the page already used.
// ================================================================
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { ProxyAgent, setGlobalDispatcher } = require('undici');

// Route ALL outbound fetch() calls (quotes, option chain, orders, login, etc.)
// through the staticip.in static IP so Fyers' IP whitelist accepts them.
// Without this, Render assigns a shared/rotating IP and both login and
// order placement get rejected as "not from a whitelisted IP".
if (process.env.STATIC_PROXY_URL) {
  setGlobalDispatcher(new ProxyAgent(process.env.STATIC_PROXY_URL));
  console.log('  Routing all outbound Fyers calls through static proxy IP.');
} else {
  console.log('  WARNING: STATIC_PROXY_URL not set — outbound calls will use Render\'s shared IP range, which Fyers will reject.');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

const FYERS_BASE = 'https://api-t1.fyers.in';
const FYERS_APP_ID = process.env.FYERS_APP_ID || '5WESGP23O5-200';
const FYERS_SECRET = process.env.FYERS_SECRET || ''; // set this in Render → Environment

function authHeader(req) {
  return req.header('Authorization') || req.query.auth || '';
}

async function relay(res, url, opts) {
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) {}
    const looksBad = !r.ok || (parsed && (parsed.s === 'error' || (typeof parsed.code === 'number' && parsed.code < 0)));
    if (looksBad) {
      const bodyInfo = opts && opts.body ? `\n  sent body: ${opts.body}` : '';
      console.log(`\n  [Fyers ${r.status}] ${opts && opts.method || 'GET'} ${url}${bodyInfo}\n  → ${text.slice(0, 500)}\n`);
    }
    if (parsed === null) {
      // Upstream (Fyers, or a gateway/proxy in between) sent back something
      // that isn't JSON at all — an HTML error page, a timeout page, etc.
      // Never forward that raw: it crashes the frontend's res.json() with
      // "Unexpected token '<'". Wrap it in a proper JSON error instead.
      res.status(r.status >= 400 ? r.status : 502).json({
        s: 'error',
        message: 'Fyers (or the network) returned a non-JSON response — likely a temporary gateway/rate-limit hiccup. Try again in a moment.'
      });
      return;
    }
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    // Node's fetch throws a generic "fetch failed" here for every kind of
    // transport failure (DNS lookup failed, connection refused, TLS error,
    // timeout, the STATIC_PROXY_URL host being unreachable, ...) — the
    // actual reason lives one level down, in e.cause. Surface it instead
    // of just "fetch failed", which told us nothing.
    const cause = e.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : '';
    console.log(`\n  [Fyers unreachable] ${opts && opts.method || 'GET'} ${url}\n  → ${e.message}${cause}\n`);
    res.status(502).json({ s: 'error', message: 'Proxy could not reach Fyers: ' + e.message + cause });
  }
}

// Live quotes (index ticker, watchlist, open positions LTP)
app.get('/api/quotes', (req, res) => {
  const symbols = req.query.symbols || '';
  const url = `${FYERS_BASE}/data/quotes?symbols=${encodeURIComponent(symbols)}`;
  relay(res, url, { headers: { Authorization: authHeader(req) } });
});

// Option chain (weekly + monthly, per selected expiry)
// Path/params confirmed against Fyers' own official Go SDK source (api.go/data.go):
// OptionChainURl = BaseDataURL + "/options-chain-v3?" — always sends symbol,
// strikecount, timestamp, and greeks (timestamp/greeks empty when unused).
app.get('/api/optionchain', (req, res) => {
  const { symbol, strikecount, timestamp } = req.query;
  const params = new URLSearchParams({
    symbol: symbol || '',
    strikecount: String(strikecount || 15),
    timestamp: timestamp || '',
    greeks: ''
  });
  relay(res, `${FYERS_BASE}/data/options-chain-v3?${params.toString()}`, { headers: { Authorization: authHeader(req) } });
});

// Historical candles (for RVI breadth scan and COC's 3m CE/PE meeting-point board)
app.get('/api/history', (req, res) => {
  const { symbol, resolution, date_format, range_from, range_to, cont_flag } = req.query;
  const params = new URLSearchParams({
    symbol: symbol || '',
    resolution: resolution || '1',
    date_format: date_format || '1',
    range_from: range_from || '',
    range_to: range_to || '',
    cont_flag: cont_flag || '1'
  });
  relay(res, `${FYERS_BASE}/data/history?${params.toString()}`, { headers: { Authorization: authHeader(req) } });
});

// Real broker positions (for syncFyersPositions)
app.get('/api/positions', (req, res) => {
  relay(res, `${FYERS_BASE}/api/v3/positions`, { headers: { Authorization: authHeader(req) } });
});

// Real account funds/margin (for showing actual Capital in Live mode)
app.get('/api/funds', (req, res) => {
  relay(res, `${FYERS_BASE}/api/v3/funds`, { headers: { Authorization: authHeader(req) } });
});

// Real order book (for showing actual Orders in Live mode)
app.get('/api/orderbook', (req, res) => {
  relay(res, `${FYERS_BASE}/api/v3/orders`, { headers: { Authorization: authHeader(req) } });
});

// Daily login: exchange auth_code for access_token, server-side.
// This goes out through the same static IP as every order/data call, and
// keeps FYERS_SECRET off the browser entirely.
app.post('/api/auth/token', async (req, res) => {
  const { code } = req.body || {};
  if (!code) {
    return res.status(400).json({ s: 'error', message: 'Missing auth code' });
  }
  if (!FYERS_SECRET) {
    return res.status(500).json({ s: 'error', message: 'FYERS_SECRET is not set on the server (Render → Environment).' });
  }
  const appIdHash = crypto.createHash('sha256').update(`${FYERS_APP_ID}:${FYERS_SECRET}`).digest('hex');
  relay(res, `${FYERS_BASE}/api/v3/validate-authcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code })
  });
});

// Place / exit orders
app.post('/api/orders', (req, res) => {
  relay(res, `${FYERS_BASE}/api/v3/orders/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(req) },
    body: JSON.stringify(req.body)
  });
});

// F&O underlying stock list, for the Breadth scanner. Sourced from Fyers'
// public (no-auth) symbol master file, which lists every NSE F&O contract —
// we just pull out the unique underlying stock symbols from it. This barely
// ever changes (only on NSE's periodic F&O list revisions), so it's cached
// in memory for 24h. If Fyers' file is unreachable or its format changes,
// this fails safe: the frontend already falls back to its own bundled list
// whenever this endpoint doesn't return a clean { s:'ok', symbols:[...] }.
let fnoListCache = null; // { ts, symbols }
const FNO_LIST_TTL = 24 * 60 * 60 * 1000;
const FNO_INDEX_NAMES = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX']);

app.get('/api/fno-list', async (req, res) => {
  try {
    if (fnoListCache && (Date.now() - fnoListCache.ts) < FNO_LIST_TTL) {
      return res.json({ s: 'ok', symbols: fnoListCache.symbols, cached: true });
    }
    const r = await fetch('https://public.fyers.in/sym_details/NSE_FO.csv');
    if (!r.ok) throw new Error('Fyers symbol master returned HTTP ' + r.status);
    const text = await r.text();
    const seen = new Set();
    const symbols = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const f = line.split(',');
      const underlying = (f[13] || '').trim().toUpperCase();
      if (!underlying || FNO_INDEX_NAMES.has(underlying) || seen.has(underlying)) continue;
      seen.add(underlying);
      symbols.push(underlying);
    }
    // Sanity check — if Fyers changes their CSV column layout, we'd silently
    // extract garbage instead of stock symbols. A too-short list is a signal
    // something's off, so bail out and let the frontend use its fallback.
    if (symbols.length < 20) throw new Error('parsed only ' + symbols.length + ' symbols — CSV format may have changed');
    symbols.sort();
    fnoListCache = { ts: Date.now(), symbols };
    res.json({ s: 'ok', symbols });
  } catch (e) {
    console.log(`\n  [fno-list] ${e.message} — frontend will use its bundled fallback list\n`);
    res.status(502).json({ s: 'error', message: e.message });
  }
});

// ================================================================
// OI TRACKER — every 5 minutes, fetch each tracked stock's ATM CE/PE
// (LTP + OI) and append one row per stock to a log kept ON THIS SERVER.
//
// Why server-side and not just in the browser: a setInterval() living only
// in the page would (a) stop the moment the tab/laptop sleeps, and (b) give
// your phone and PC two completely separate logs, since each browser's
// localStorage is private to that device. Running the poll here instead,
// and writing the log to a file, means there's exactly ONE shared log that
// both your PC and phone read from the same server — that's what makes
// "check it on mobile too" actually work.
//
// Trade-off: this endpoint needs a Fyers access token to call Fyers with,
// and (per the rest of this app) that token only ever lives in the browser
// after you log in — the server never generates one on its own. So the
// frontend calls POST /api/oi-tracker/register right after every login
// (and whenever you edit the tracked list) to hand the current token +
// symbol list to the server. If nobody has logged in yet today, or the
// token has expired, polls simply fail quietly and get logged to the
// console — nothing crashes, the next successful poll just picks up again.
// ================================================================
const OI_LOG_FILE = path.join(__dirname, 'oi-log.json');
const OI_STATE_FILE = path.join(__dirname, 'oi-state.json');
const OI_LOG_MAX = 20000;      // hard cap so the file can't grow forever
const OI_MAX_SYMBOLS = 30;     // keeps each 5-min cycle fast + within Fyers rate limits
const OI_POLL_MS = 5 * 60 * 1000;
const OI_FETCH_PACE_MS = 300;  // spacing between each stock's request, same spirit as COC's pacing

function loadJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function saveJsonSafe(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { console.log(`  [oi-tracker] failed to save ${path.basename(file)}: ${e.message}`); }
}

let oiLog = loadJsonSafe(OI_LOG_FILE, []);
let oiState = Object.assign({ token: '', symbols: [], lastPoll: null, nextPoll: null }, loadJsonSafe(OI_STATE_FILE, {}));

// Detects CE/PE the same reliable way the frontend does (trading-symbol
// suffix first, option_type field as fallback) — keeps this endpoint
// correct even if Fyers' option_type casing/field ever shifts.
function oiOptType(x) {
  const s = (x.symbol || x.fy_symbol || x.tradingsymbol || '').toUpperCase();
  if (s.endsWith('CE')) return 'CE';
  if (s.endsWith('PE')) return 'PE';
  const t = (x.option_type || x.optionType || '').toString().toUpperCase();
  return (t === 'CE' || t === 'PE') ? t : null;
}

async function fetchAtmChain(sym) {
  const params = new URLSearchParams({ symbol: 'NSE:' + sym + '-EQ', strikecount: '2', timestamp: '', greeks: '' });
  const r = await fetch(`${FYERS_BASE}/data/options-chain-v3?${params.toString()}`, { headers: { Authorization: oiState.token } });
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error('non-JSON response'); }
  if (!r.ok || d.s === 'error') throw new Error(d.message || ('HTTP ' + r.status));
  const chain = d.data && d.data.optionsChain || [];
  if (!chain.length) throw new Error('empty option chain');
  const spot = chain[0] && chain[0].ltp || 0;
  // Strike step varies a lot per stock (2.5 to 1000+), so rather than assume
  // one, just pick whichever strike actually present is closest to spot.
  let atm = null, atmDist = Infinity;
  chain.forEach(x => {
    if (x.strike_price == null) return;
    const dist = Math.abs(x.strike_price - spot);
    if (dist < atmDist) { atmDist = dist; atm = x.strike_price; }
  });
  let ce = null, pe = null;
  chain.forEach(x => {
    if (x.strike_price !== atm) return;
    const t = oiOptType(x);
    if (t === 'CE') ce = x; else if (t === 'PE') pe = x;
  });
  return {
    sym, spot, atm,
    ceLtp: ce ? ce.ltp : null, ceOi: ce ? ce.oi : null, ceOiChg: ce ? ce.oi_change : null, ceVol: ce ? ce.volume : null,
    peLtp: pe ? pe.ltp : null, peOi: pe ? pe.oi : null, peOiChg: pe ? pe.oi_change : null, peVol: pe ? pe.volume : null
  };
}

let oiPolling = false;
async function pollOiOnce() {
  if (oiPolling) return { s: 'skip', message: 'a poll is already running' };
  if (!oiState.token) return { s: 'error', message: 'No Fyers token registered yet — open the app and log in once, on any device.' };
  if (!oiState.symbols.length) return { s: 'error', message: 'No stocks tracked yet — add some in the OI Tracker tab.' };
  oiPolling = true;
  const time = new Date().toISOString();
  const rows = [];
  const errors = [];
  for (const sym of oiState.symbols) {
    try {
      const row = await fetchAtmChain(sym);
      rows.push(Object.assign({ time }, row));
    } catch (e) {
      errors.push(sym + ': ' + e.message);
    }
    await new Promise(res => setTimeout(res, OI_FETCH_PACE_MS));
  }
  if (rows.length) {
    oiLog.push(...rows);
    if (oiLog.length > OI_LOG_MAX) oiLog = oiLog.slice(-OI_LOG_MAX);
    saveJsonSafe(OI_LOG_FILE, oiLog);
  }
  oiState.lastPoll = time;
  oiState.nextPoll = new Date(Date.now() + OI_POLL_MS).toISOString();
  saveJsonSafe(OI_STATE_FILE, oiState);
  oiPolling = false;
  if (errors.length) console.log(`\n  [oi-tracker] poll finished with ${errors.length} error(s): ${errors.join(' | ')}\n`);
  return { s: 'ok', added: rows.length, errors, time };
}

// Frontend calls this right after login, and whenever the tracked-symbol
// chip list changes — keeps the server's copy of the token/watchlist current.
app.post('/api/oi-tracker/register', (req, res) => {
  const { token, symbols } = req.body || {};
  if (typeof token === 'string' && token) oiState.token = token;
  if (Array.isArray(symbols)) {
    oiState.symbols = symbols
      .filter(s => typeof s === 'string' && s.trim())
      .map(s => s.trim().toUpperCase())
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .slice(0, OI_MAX_SYMBOLS);
  }
  saveJsonSafe(OI_STATE_FILE, oiState);
  res.json({ s: 'ok', tracking: oiState.symbols, hasToken: !!oiState.token });
});

// Read-only — cheap, no Fyers call — this is what both PC and phone poll
// every 30s or so to display the (shared, server-held) log.
app.get('/api/oi-tracker/log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, OI_LOG_MAX);
  res.json({ s: 'ok', log: oiLog.slice(-limit), symbols: oiState.symbols, lastPoll: oiState.lastPoll, nextPoll: oiState.nextPoll });
});

// Manual "poll now" button — runs one cycle immediately instead of waiting
// for the next 5-minute tick.
app.post('/api/oi-tracker/poll-now', async (req, res) => {
  res.json(await pollOiOnce());
});

app.delete('/api/oi-tracker/log', (req, res) => {
  oiLog = [];
  saveJsonSafe(OI_LOG_FILE, oiLog);
  res.json({ s: 'ok' });
});

setInterval(pollOiOnce, OI_POLL_MS);
// If the server restarts mid-session with a token/watchlist already saved
// from before, don't make it wait a full 5 minutes for the first snapshot.
if (oiState.token && oiState.symbols.length) setTimeout(pollOiOnce, 5000);

// Lightweight health check — point an external uptime monitor (see README)
// at this so Render's free tier never sees enough idle time to sleep.
// Deliberately does nothing but respond instantly: no Fyers call, no auth
// needed, so it can't itself burn into your API rate limit.
app.get('/api/ping', (req, res) => {
  res.json({ s: 'ok', t: Date.now() });
});

const PORT = process.env.PORT || 5055;
app.listen(PORT, '0.0.0.0', () => {
  const lanIps = getLanIps();
  console.log(`\n  TradeBook proxy running.\n`);
  console.log(`  On this PC:        http://localhost:${PORT}`);
  if (lanIps.length) {
    lanIps.forEach(ip => console.log(`  On your phone:      http://${ip}:${PORT}   (same Wi-Fi as this PC)`));
  } else {
    console.log(`  On your phone:      couldn't detect a LAN IP — run 'ipconfig' (Windows) or 'ifconfig'/'ip addr' (Mac/Linux) and use that IP instead of localhost.`);
  }
  console.log(`\n  Keep this window open while trading. Ctrl+C to stop.\n`);
});
