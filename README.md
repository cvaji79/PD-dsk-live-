# TradeBook — Fyers Proxy Server

## Why this exists
Fyers' Data/Order REST APIs don't allow direct browser access (no CORS
headers) — that's why real-time prices and the option chain wouldn't load
even after a successful login. This small local server makes the same
calls from Node instead (which isn't subject to CORS) and relays the
response back to the page.

Your Fyers token still never leaves your machine — it goes from your
browser to this local server only, then straight to Fyers.

## Setup (one time)
Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
cd tradebook-server
npm install
```

## Run it
```bash
npm start
```
You'll see something like:
```
TradeBook proxy running.

On this PC:        http://localhost:5055
On your phone:      http://192.168.1.42:5055   (same Wi-Fi as this PC)
```

## Use it — on your PC
Open **http://localhost:5055** in your browser — not the old `index.html`
file directly.

## Use it — on your phone
1. Connect your phone to the **same Wi-Fi network** as your PC (this only
   works on the same local network — not over mobile data, and not from
   a different location).
2. On your phone's browser, open the "On your phone" address the server
   printed (e.g. `http://192.168.1.42:5055`).
3. If it doesn't load, your PC's firewall is probably blocking the
   connection — allow inbound connections on port 5055 for Node.js:
   - **Windows**: when Node first starts the server, Windows usually pops
     up a "Windows Defender Firewall" prompt — click **Allow access**. If
     you missed it, go to *Control Panel → Windows Defender Firewall →
     Allow an app*, find Node.js, and tick both Private and Public.
   - **Mac**: *System Settings → Network → Firewall* → allow incoming
     connections for `node`.
4. Your PC's LAN IP can change if it reconnects to Wi-Fi later — just
   check the terminal output again next time you run `npm start`.

Both your PC and phone just talk to this one server running on your PC —
nothing is uploaded anywhere, and it stops working the moment you close
the terminal or your PC sleeps.

## Use it — from anywhere (not on the same Wi-Fi)
If your phone won't always be on the same network as your PC, use a
**tunnel** — it gives your local server a public internet address, with
no separate hosting/server rental needed.

### Option A — Cloudflare Tunnel (recommended, no account needed)
1. Install `cloudflared`:
   - **Windows**: `winget install --id Cloudflare.cloudflared`
   - **Mac**: `brew install cloudflared`
   - **Linux / other**: download from
     https://github.com/cloudflare/cloudflared/releases
2. With `npm start` still running in one terminal, open a **second**
   terminal and run:
   ```bash
   cloudflared tunnel --url http://localhost:5055
   ```
3. It prints a public address like `https://random-words.trycloudflare.com`.
   Open that on your phone — works over mobile data, from anywhere.
4. This address changes every time you restart the tunnel (that's normal
   for the free "quick tunnel" — no account means no fixed address).

Keep **both** terminals open while trading: one running `npm start`,
one running `cloudflared`.

### Option B — ngrok (also free, needs a one-time signup)
1. Sign up free at https://ngrok.com and grab your authtoken.
2. Install ngrok, then run once: `ngrok config add-authtoken YOUR_TOKEN`
3. With `npm start` running, in a second terminal:
   ```bash
   ngrok http 5055 --basic-auth="yourname:yourpassword"
   ```
   The `--basic-auth` part is worth keeping — since the address is now
   reachable by anyone on the internet who finds it, this makes your
   phone (or anyone else) enter a username/password before it loads.
4. Open the printed `https://...ngrok-free.app` address from your phone.

Either option: the tunnel address is only good as long as that terminal
window stays running. Closing it (or your PC sleeping) takes it offline
until you start it again.

## What's inside
- `server.js` — the proxy (quotes, option chain, positions, orders)
- `public/index.html` — your TradeBook app, unchanged except it now calls
  `/api/...` (this server) instead of `api-t1.fyers.in` directly for
  live data and orders. Login still talks to Fyers directly, same as before.
