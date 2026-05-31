# Debugging: Create Order & Database Connection — Answers

This document captures the results of the diagnostics and the steps that fix "Failed to create order" / "Database connection refused."

---

## 1. What we ran (diagnostics)

- **`brew services list | grep postgres`**  
  Result: `postgresql@14` and `postgresql@16` both show **error** (exit 78). **Running: false**, **Schedulable: false**.

- **`pg_isready -h localhost -p 5432` and `-p 5433`**  
  Result: **Both "no response"** — nothing is accepting connections on 5432 or 5433.

- **`lsof -i :5432 -i :5433`**  
  Result: **Nothing listening** on either port.

- **`brew services info postgresql@14`**  
  Result: **Running: false**. Service is loaded but not running (likely failed to start).

**Conclusion:** PostgreSQL is **not running**. The app correctly tries to connect; the failure is that no database process is listening. Homebrew reports the postgresql@14 (and @16) services in an error state, so `brew services start postgresql@14` did not leave Postgres running.

**Which PostgreSQL version?** This setup uses **PostgreSQL 14** (`postgresql@14`), as referenced in `.env` and this doc. If you have both 14 and 16 installed, use 14 for consistency (`brew --prefix postgresql@14` to confirm the path).

---

## 2. Answers to the debugging suggestions

### "Is PostgreSQL running?"

**Answer: No.** On this machine, nothing is listening on 5432 or 5433, and both postgresql@14 and postgresql@16 are in an error state.

### "Check DATABASE_URL in .env"

**Answer:** Once Postgres is running, `DATABASE_URL` must point at that instance:

- **Default (single Postgres on 5432):**  
  `DATABASE_URL=postgresql://YOUR_USER@localhost:5432/etrade_trader`

- **Homebrew postgresql@14 when something else uses 5432:**  
  Often uses **5433**. Then use:  
  `DATABASE_URL=postgresql://YOUR_USER@localhost:5433/etrade_trader`

Replace `YOUR_USER` with your **macOS username** (e.g. `michael`). When you run `initdb`, PostgreSQL creates a superuser role matching the OS user who ran it; with **trust** authentication for local connections (the default from initdb), no password is needed, so `postgresql://YOUR_USER@localhost:5432/etrade_trader` works. You can also use a dedicated DB user (e.g. `etrade_user`) and add `:password` if you use password auth. The project expects a database named `etrade_trader` (or whatever you create and put in the URL).

### "Homebrew postgresql@14 often uses port 5433"

**Answer:** Only if another Postgres is using 5432. Right now **no** Postgres is running, so the first step is to get one running; then use the port it actually listens on (5432 or 5433) in `DATABASE_URL`.

---

## 3. What to do (fix order)

1. **Get PostgreSQL running**
   - Try: `brew services start postgresql@14`
   - If it stays in "error" state, check why:
     - `brew services info postgresql@14`
     - Look at logs (e.g. `~/Library/Logs/Homebrew/postgresql@14/*.log` or `brew services info` output).
   - If the data directory was never initialized, you may need to run:
     - `initdb /usr/local/var/postgresql@14` (or path from `brew --prefix postgresql@14` + `/var/postgresql@14`), then `brew services start postgresql@14`.
   - Alternatively, use **postgresql@16** if that's the version you want: `brew services start postgresql@16`, then use the port it listens on in `DATABASE_URL`.

2. **Confirm it's listening**
   - `pg_isready -h localhost -p 5432` (or 5433). You should see "accepting connections".
   - Or: `lsof -i :5432` (or 5433) and confirm a `postgres` process is listed.

3. **Create the database (if needed)**
   - `createdb etrade_trader` (or the DB name you put in `DATABASE_URL`).
   - If you use a dedicated user: `createuser -s etrade_user` then `createdb -O etrade_user etrade_trader`.

4. **Set DATABASE_URL in .env**
   - Use the **host**, **port**, **user**, and **database** that match the running Postgres (e.g. `postgresql://YOUR_USER@localhost:5432/etrade_trader` or `...localhost:5433/...`).

5. **Start the app**
   - `ETRADE_SANDBOX=false npm run dev`
   - You should see: **"Database: schema applied (tables ready)"**.

6. **Create the order again**
   - Create Order tab → AAPL, BUY, LIMIT, 1, 10, GTC/DAY, Extended Hours (7:00 AM), Enable Scheduling checked → Create Order.
   - Then open Active Orders → **Scheduled**; the new order should appear (and the list refetches when you switch tabs or refresh).

---

## 4. Why "Create Order" failed (summary)

1. **DB connection refused:** The server tried to connect to Postgres at the host:port in `DATABASE_URL`, but nothing was listening (Postgres not running / wrong port). That produced ECONNREFUSED and the message "Database connection refused. Is PostgreSQL running? Check DATABASE_URL in .env."
2. **No order in Scheduled tab:** Until the order is successfully created (DB working), it never gets stored, so it can't show up in Active Orders → Scheduled. After fixing the DB and creating the order again, it should appear there (and the client will show it after a refresh or refetch).

---

## 5. Resolution (what worked)

On this machine the fix was:

1. **Data directory didn't exist** — PostgreSQL had never been initialized. Initialized it with:
   ```bash
   /usr/local/opt/postgresql@14/bin/initdb --locale=C -E UTF-8 /usr/local/var/postgresql@14
   ```

2. **`brew services start postgresql@14` failed** (Bootstrap failed: 5 / launchctl error 78). Started PostgreSQL directly with:
   ```bash
   /usr/local/opt/postgresql@14/bin/pg_ctl -D /usr/local/var/postgresql@14 -l /tmp/pg14.log start
   ```
   Postgres then listened on Unix socket `/tmp/.s.PGSQL.5432` and accepted TCP connections on port 5432.

3. **Created the database:** `createdb etrade_trader`

4. **`.env` already had:** `DATABASE_URL=postgresql://YOUR_USER@localhost:5432/etrade_trader` — no change needed. The user `michael` is the macOS username; initdb created that superuser when the cluster was initialized, and with trust auth for local connections no password is required.

5. **Restarted the app** — server showed "✓ Connected to PostgreSQL database" and "Database: schema applied (tables ready)".

**After reboot:** PostgreSQL was started with `pg_ctl` directly, not via Homebrew services, so it does not auto-start on reboot. To start it again:
```bash
/usr/local/opt/postgresql@14/bin/pg_ctl -D /usr/local/var/postgresql@14 -l /tmp/pg14.log start
```
(Or fix `brew services` / launchctl if you prefer it to start automatically.)

---

## 6. If Postgres still won't start

- **Error 78 / Schedulable: false:** Often means the service failed to start (e.g. bad config, missing data dir, or launchctl issue). Try starting with `pg_ctl` as in Section 5; if the data directory is missing, run `initdb` first.
- **Port in use:** If another app is on 5432, either stop it or use the other port (e.g. 5433) for postgresql@14 and set that port in `DATABASE_URL`.
