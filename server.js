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

// Place / exit orders
app.post('/api/orders', (req, res) => {
  relay(res, `${FYERS_BASE}/api/v3/orders/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(req) },
    body: JSON.stringify(req.body)
  });
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
