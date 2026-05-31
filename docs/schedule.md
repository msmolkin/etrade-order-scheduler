# Daily schedule and how to change it

Three independent timers govern the trade-placer's day:

| Time (ET, Mon-Fri)         | What fires                                                                                                                              | Where it lives                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **03:00**                  | `etrade-morning.sh` — start screen services, trigger `/api/auth/auto`, restart server+scheduler with fresh tokens                       | clawd's crontab on ryansoldmac                              |
| **04:00, 05:00, 06:00**    | Token heartbeat — `GET /oauth/renew_access_token` to keep E\*TRADE's 2-hour inactivity timer from expiring through pre-pre-market hours | `heartbeatJob` in `src/scheduler/local-scheduler.ts`        |
| **06:55**                  | Token heartbeat (grace tick) — final renewal right before EXTENDED orders fire                                                          | `heartbeatGraceJob` in `src/scheduler/local-scheduler.ts`   |
| **07:00**                  | EXTENDED-session scheduled orders fire                                                                                                  | `extendedHoursJob` in `src/scheduler/local-scheduler.ts`    |
| **07:00, 08:00, …, 19:00** | Hourly token heartbeat through the trading day                                                                                          | `heartbeatJob` (same cron expression covers 04:00-19:00)    |
| **09:30**                  | MARKET-session scheduled orders fire                                                                                                    | `marketOpenJob` in `src/scheduler/local-scheduler.ts`       |
| **20:05**                  | Option expiration sweep                                                                                                                 | `optionExpirationJob` in `src/scheduler/local-scheduler.ts` |
| every 30 s                 | Due-orders check (arbitrary-time scheduled orders)                                                                                      | `dueOrdersInterval`                                         |
| every 10 min, 06:00-09:00  | Catch-up for missed EXTENDED/MARKET fires                                                                                               | `catchUpJob`                                                |
| every 15 min, market hours | Order-status verification                                                                                                               | `verificationJob`                                           |

## Why 03:00 for the morning script

E\*TRADE has historically opened pre-market trading at 04:00 ET. If they ever start a pre-pre-market session, having the auth + first heartbeats already done by 04:00 means we're ready. The 03:00 morning auth completes within ~3 minutes (curl /api/auth/auto + 180 s sleep for the OTP to arrive via the Apps Script -> relay.ctdsu.com -> ryansoldmac:3102 -> main app webhook chain). By 03:05 tokens are fresh and persisted to .env; by 04:00 the first heartbeat resets the inactivity clock; subsequent hourly heartbeats keep it reset all day.

## Changing the morning time

```bash
ssh clawd@ryansoldmac
crontab -e
# Edit the line: "0 3 * * 1-5 /Users/michael/Documents/2026/.../etrade-morning.sh ..."
# First field is minute, second is hour.
```

**TCC caveat:** macOS Monterey blocks `/usr/sbin/cron` from reading files under `/Users/michael/...` unless it has Full Disk Access. Until that's granted (System Settings -> Privacy & Security -> Full Disk Access -> +/usr/sbin/cron), the morning cron silently fails with `Permission denied`. See the always-on plan in `/Users/michael/.claude/plans/moonlit-drifting-rossum.md` for alternatives (LaunchDaemon migration is also TCC-blocked on this OS; the SSH-loopback workaround is viable but ugly).

## Changing the heartbeat schedule

Heartbeats are two separate cron expressions in `src/scheduler/local-scheduler.ts`:

```ts
this.heartbeatJob = cron.schedule("0 4-19 * * 1-5", runHeartbeat, {
  timezone: SCHEDULER_TZ,
});
this.heartbeatGraceJob = cron.schedule("55 6 * * 1-5", runHeartbeat, {
  timezone: SCHEDULER_TZ,
});
```

To add or remove ticks:

- Adjust `"0 4-19 * * 1-5"` for the hourly window. e.g. `"0 5-20 * * 1-5"` shifts the window to 05:00-20:00.
- Modify `heartbeatGraceJob` for additional grace ticks at non-hourly times (e.g. `"55 6,9 * * 1-5"` adds a 09:55 grace before MARKET).
- Add new properties + cron blocks for entirely new patterns; clean up the corresponding `stop()` block too.

Restart the scheduler after editing for the new schedule to take effect:

```bash
ssh clawd@ryansoldmac
screen -S etrade-scheduler -X quit
screen -dmS etrade-scheduler bash -c "export PATH=/Users/clawd/.nvm/versions/node/v24.13.0/bin:\$PATH && cd /Users/michael/Documents/2026/projects/etrade-trade-placer && source .env && export \$(grep -v '^#' .env | xargs) && exec npx tsx src/scheduler/local-scheduler.ts >> /tmp/etrade-scheduler.log 2>&1"
tail -f /tmp/etrade-scheduler.log
```

The startup banner echoes the active schedule so a quick restart-and-tail confirms the new times took.

## Why "never miss the inactivity window"

E\*TRADE OAuth 1.0a access tokens expire under two conditions:

1. **End of Eastern day** - hard expiry; no silent renewal possible. The morning script's `/api/auth/auto` re-auth flow (with SMS OTP) is the only recovery path.
2. **2 hours of inactivity** - any successful API call resets the clock. Silent `/oauth/renew_access_token` works (no SMS needed) and is what the heartbeats use.

Hourly heartbeats give a 1-hour margin against the 2-hour inactivity window. The 06:55 grace tick exists because if 06:00's heartbeat happens to fail (network blip, transient E\*TRADE 5xx) and 07:00 fires the EXTENDED orders, the executor's 401-retry path will renew on the spot - but having a fresh-as-of-:55 token is one less moving part.
