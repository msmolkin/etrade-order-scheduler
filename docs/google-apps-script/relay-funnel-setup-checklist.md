# E*TRADE OTP relay + Tailscale Funnel setup checklist

Use this when the trade-placer server runs on a home/local Wi-Fi network with a changing LAN IP.

Goal:
- keep the main trade-placer app private on localhost
- expose only a tiny OTP relay through Tailscale Funnel
- let Google Apps Script call a stable public HTTPS URL

## Files involved

- Relay server:
  - `docs/google-apps-script/otp-webhook-relay.mjs`
- Apps Script Gmail poller:
  - `docs/google-apps-script/etrade-gmail-webhook.gs`
- Root-level creator script:
  - `create-otp-relay-setup.sh`

## Recommended flow

`Google Voice -> Gmail -> Apps Script -> Tailscale Funnel URL -> local relay -> http://127.0.0.1:3001/api/auth/auto/webhook`

## Step-by-step

### 1. Make sure Tailscale is already connected on the server

Verify:

```bash
tailscale status
```

### 2. Make sure the trade-placer app is reachable locally

Verify the local app responds:

```bash
curl -sS http://127.0.0.1:3001/health
```

If your app uses a different local port, note it for the creator script.

### 3. Generate the relay artifacts

From the repo root:

```bash
./create-otp-relay-setup.sh --secret 'replace-with-a-long-random-secret' --update-dotenv
```

That writes:

- `.generated/otp-relay/etrade-otp-relay.env`
- `.generated/otp-relay/etrade-otp-relay.service`
- `.generated/otp-relay/etrade-otp-relay.install.txt`
- `.generated/otp-relay/etrade-otp-relay.funnel.txt`
- `.generated/otp-relay/etrade-otp-relay.app-env`

### 4. Install and start the relay

Either let the creator script do it:

```bash
./create-otp-relay-setup.sh --secret 'replace-with-a-long-random-secret' --update-dotenv --apply
```

Or do it manually:

```bash
sudo cp .generated/otp-relay/etrade-otp-relay.service /etc/systemd/system/etrade-otp-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now etrade-otp-relay.service
sudo systemctl status etrade-otp-relay.service --no-pager
```

### 5. Restart or reload the main trade-placer app if needed

The app must use the same webhook secret as the relay:

```env
ETRADE_AUTO_AUTH_WEBHOOK_SECRET=replace-with-a-long-random-secret
```

If the main app is already running, reload or restart it so it picks up the new env value.

### 6. Expose only the relay with Tailscale Funnel

Either let the creator script do it:

```bash
./create-otp-relay-setup.sh --secret 'replace-with-a-long-random-secret' --update-dotenv --apply --enable-funnel
```

Or do it manually:

```bash
tailscale funnel --bg localhost:3102
tailscale funnel status
```

If you chose a different relay port, substitute that port.

### 7. Copy the public Funnel URL

Run:

```bash
tailscale funnel status
```

Find the public HTTPS `*.ts.net` URL for the relay.

That URL becomes:

```text
ETRADE_WEBHOOK_URL=https://YOUR-FUNNEL-URL/
```

for Apps Script.

### 8. Configure Apps Script

At `script.google.com`:

- create a project
- replace `Code.gs` with `docs/google-apps-script/etrade-gmail-webhook.gs`
- set script properties:

```text
ETRADE_WEBHOOK_URL=https://YOUR-FUNNEL-URL/
ETRADE_WEBHOOK_SECRET=replace-with-a-long-random-secret
ETRADE_GMAIL_QUERY=in:inbox newer_than:1d "Your E*TRADE verification code is"
ETRADE_PROCESSED_LABEL=etrade-otp-processed
ETRADE_TIMEZONE=America/New_York
ETRADE_POLL_START=06:30
ETRADE_POLL_END=07:30
```

- create a time-driven trigger for `pollEtradeOtpEmail` every minute

### 9. Enable Google Voice -> Gmail forwarding

In Google Voice settings, enable forwarding of messages to Gmail.

### 10. Schedule the morning auth start locally

Example weekday cron entry:

```bash
30 6 * * 1-5 curl -sS -X POST http://127.0.0.1:3001/api/auth/auto -H 'Content-Type: application/json' -d '{"headless":true,"clearCookies":true}'
```

That causes the app to:
- start E*TRADE login
- trigger the SMS
- wait for the OTP

Then Apps Script finishes the OTP handoff automatically.

## Why this works with a changing Wi-Fi IP

The home LAN IP can change and it does not matter, because:

- the app stays on `127.0.0.1`
- the relay stays on `127.0.0.1`
- Tailscale Funnel gives you a stable public `ts.net` URL
- Apps Script calls that Funnel URL, not your changing home LAN address

## Important security rule

Do not expose the full app port publicly.
Expose only the relay.

## Smoke test

After Funnel is up, test with:

```bash
curl -sS -X POST "https://YOUR-FUNNEL-URL/" \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-secret: replace-with-a-long-random-secret' \
  -d '{"Body":"<sms>Your E*TRADE verification code is 779678. No one from E*TRADE will contact you for this code unless initiated by you. Didn'"'"'t request a code? Call 1-800-387-2331</sms>"}'
```

If no auth session is waiting, the expected response is an error like:

```json
{"success":false,"error":"No active auto-auth session is currently waiting for a 2FA code."}
```

That still proves the path is reachable.
