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
    res.status(502).json({ s: 'error', message: 'Proxy could not reach Fyers: ' + e.message });
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
