import cron, { type ScheduledTask } from "node-cron";
import dotenv from "dotenv";
import { SchedulerBase } from "./scheduler-base.js";
import { query } from "../server/database/client.js";
import {
  initSchedulerLog,
  closeSchedulerLog,
  log as schedulerLog,
  error as schedulerError,
} from "./logger.js";

dotenv.config();

const SCHEDULER_TZ = process.env.SCHEDULER_TIMEZONE || "America/New_York";

function getLocalTimeInSchedulerTz(): {
  hour: number;
  minute: number;
  isWeekday: boolean;
} {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULER_TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(
    parts.find((p) => p.type === "minute")?.value ?? "0",
    10,
  );
  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULER_TZ,
    weekday: "short",
  });
  const weekday = dayFormatter.format(now);
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  return { hour, minute, isWeekday };
}

export class LocalScheduler extends SchedulerBase {
  private marketOpenJob?: ScheduledTask;
  private extendedHoursJob?: ScheduledTask;
  private verificationJob?: ScheduledTask;
  private catchUpJob?: ScheduledTask;
  private optionExpirationJob?: ScheduledTask;
  private endOfDayVerifyJob?: ScheduledTask;
  private heartbeatJob?: ScheduledTask;
  private heartbeatGraceJob?: ScheduledTask;
  private dueOrdersInterval?: ReturnType<typeof setInterval>;
  private heartbeatRowInterval?: ReturnType<typeof setInterval>;
  private verificationRunning = false;

  async start(): Promise<void> {
    initSchedulerLog();
    schedulerLog(
      `scheduler start timezone=${SCHEDULER_TZ} schedulerId=${this.schedulerId}`,
    );

    console.log("🚀 Starting local scheduler...");
    console.log(`Scheduler ID: ${this.schedulerId}`);

    // Run work in setImmediate so the cron callback returns immediately, avoiding
    // "missed execution" when processScheduledOrders or other work blocks the event loop.
    const runMarketOpen = () => {
      setImmediate(async () => {
        schedulerLog(`cron_fire session=MARKET trigger="9:30 AM EST"`);
        console.log("\n📈 Market open trigger (9:30 AM EST)");
        await this.processScheduledOrders("MARKET");
      });
    };
    const runExtendedHours = () => {
      setImmediate(async () => {
        schedulerLog(`cron_fire session=EXTENDED trigger="7:00 AM EST"`);
        console.log("\n🌅 Extended hours trigger (7:00 AM EST)");
        await this.processScheduledOrders("EXTENDED");
      });
    };

    // Schedule for market open (9:30 AM EST, Monday-Friday)
    this.marketOpenJob = cron.schedule("30 9 * * 1-5", runMarketOpen, {
      timezone: SCHEDULER_TZ,
    });

    // Schedule for extended hours (7:00 AM EST, Monday-Friday)
    this.extendedHoursJob = cron.schedule("0 7 * * 1-5", runExtendedHours, {
      timezone: SCHEDULER_TZ,
    });

    // Heartbeat: silently renew E*TRADE access token every hour during the trading day
    // to defeat the 2-hour inactivity expiration.
    const runHeartbeat = () => {
      setImmediate(async () => {
        this.refreshCredentials();
        try {
          const result = await this.etradeClient.renewAccessToken();
          if (result.success) {
            schedulerLog(`heartbeat: renew OK status=${result.status}`);
          } else {
            schedulerError(
              `heartbeat: renew FAILED status=${result.status} error=${result.error}`,
            );
          }
        } catch (err: any) {
          schedulerError("heartbeat: renew FAILED (threw)", err);
        }
      });
    };
    // Hourly heartbeats start at 04:00 to cover any pre-pre-market session E*TRADE
    // may offer in the future. The :55 grace tick ensures fresh tokens immediately
    // before the 7:00 AM EXTENDED order trigger.
    this.heartbeatJob = cron.schedule("0 4-19 * * 1-5", runHeartbeat, {
      timezone: SCHEDULER_TZ,
    });
    this.heartbeatGraceJob = cron.schedule("55 6 * * 1-5", runHeartbeat, {
      timezone: SCHEDULER_TZ,
    });

    // Periodic catch-up: every 10 minutes between 6:00 and 10:00 local, run overdue EXTENDED/MARKET
    this.catchUpJob = cron.schedule(
      "*/10 6-9 * * 1-5",
      () => {
        setImmediate(async () => {
          const { hour, minute, isWeekday } = getLocalTimeInSchedulerTz();
          if (!isWeekday) return;
          const minutesSinceMidnight = hour * 60 + minute;
          const after7 = minutesSinceMidnight >= 7 * 60;
          const after930 = minutesSinceMidnight >= 9 * 60 + 30;
          if (after7) {
            schedulerLog(`catch_up session=EXTENDED reason=periodic`);
            await this.processScheduledOrders("EXTENDED");
          }
          if (after930) {
            schedulerLog(`catch_up session=MARKET reason=periodic`);
            await this.processScheduledOrders("MARKET");
          }
        });
      },
      { timezone: SCHEDULER_TZ },
    );

    // Verify order status every 15 minutes during market hours (skip if previous run still in progress)
    this.verificationJob = cron.schedule(
      "*/15 * * * *",
      () => {
        setImmediate(async () => {
          if (!this.isMarketOpen()) return;
          if (this.verificationRunning) {
            console.log(
              "\n🔍 Verification skipped (previous run still in progress)",
            );
            return;
          }
          this.verificationRunning = true;
          try {
            console.log("\n🔍 Verifying order status...");
            await this.verifyRecentOrders();
          } finally {
            this.verificationRunning = false;
          }
        });
      },
      {
        timezone: SCHEDULER_TZ,
      },
    );

    // Due-orders: every 30 seconds, process any order whose scheduled_time has passed
    this.dueOrdersInterval = setInterval(() => {
      setImmediate(() => this.processDueOrders());
    }, 30_000);

    // Scheduler heartbeat row (Slice 6.2): upsert every 60s so /api/health
    // can surface lastHeartbeatAgeMs to the client SystemStatusBar.
    const writeHeartbeatRow = async () => {
      try {
        await query(
          "INSERT INTO scheduler_heartbeat (id, last_seen_at, source) VALUES ('local', NOW(), $1) ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW(), source = EXCLUDED.source",
          [`local-scheduler:${this.schedulerId}`],
        );
      } catch (err: any) {
        schedulerError("heartbeat row upsert FAILED", err);
      }
    };
    setImmediate(writeHeartbeatRow);
    this.heartbeatRowInterval = setInterval(() => {
      setImmediate(writeHeartbeatRow);
    }, 60_000);

    // End-of-day verification: 5 min after market close, refresh any orders
    // still SUBMITTED or PARTIALLY_FILLED so DAY-order fills/expirations are
    // recorded before the next morning's reschedule decision.
    this.endOfDayVerifyJob = cron.schedule(
      "5 16 * * 1-5",
      () => {
        setImmediate(async () => {
          schedulerLog('cron_fire job=eodVerify trigger="4:05 PM EST"');
          console.log("\n🔍 End-of-day order verification (4:05 PM EST)");
          if (this.verificationRunning) return;
          this.verificationRunning = true;
          try {
            await this.verifyRecentOrders();
          } finally {
            this.verificationRunning = false;
          }
        });
      },
      { timezone: SCHEDULER_TZ },
    );

    // Option expiration: expire option orders whose contract has expired (daily at 8:05 PM ET)
    this.optionExpirationJob = cron.schedule(
      "5 20 * * *",
      () => {
        setImmediate(async () => {
          schedulerLog('cron_fire job=optionExpiration trigger="8:05 PM EST"');
          console.log("\n⏰ Option expiration check (8:05 PM EST)");
          await this.expireOptionOrders();
        });
      },
      { timezone: SCHEDULER_TZ },
    );

    // Startup: expire any option orders whose contract has already expired
    setImmediate(() => {
      schedulerLog("option_expiration reason=startup");
      this.expireOptionOrders();
    });

    // Startup catch-up: run overdue EXTENDED/MARKET orders now (e.g. scheduler started at 7:30)
    const { hour, minute, isWeekday } = getLocalTimeInSchedulerTz();
    if (isWeekday) {
      const minutesSinceMidnight = hour * 60 + minute;
      if (minutesSinceMidnight >= 7 * 60) {
        schedulerLog(`catch_up session=EXTENDED reason=startup`);
        setImmediate(() => this.processScheduledOrders("EXTENDED"));
      }
      if (minutesSinceMidnight >= 9 * 60 + 30) {
        schedulerLog(`catch_up session=MARKET reason=startup`);
        setImmediate(() => this.processScheduledOrders("MARKET"));
      }
    }

    schedulerLog("scheduler started successfully");
    console.log("✓ Local scheduler started successfully");
    console.log("  - Market open orders: 9:30 AM EST (Mon-Fri)");
    console.log("  - Extended hours orders: 7:00 AM EST (Mon-Fri)");
    console.log(
      "  - Token heartbeat: top of every hour 4:00 AM-7:00 PM + 6:55 AM grace (Mon-Fri)",
    );
    console.log("  - Catch-up: on startup and every 10 min (6:00–10:00)");
    console.log(
      "  - Order verification: Every 15 minutes (during market hours)",
    );
    console.log("  - End-of-day verify: 4:05 PM EST (Mon-Fri)");
    console.log("  - Option expiration: 8:05 PM EST daily + on startup");
    console.log(
      "  - Due orders: Every 30 seconds (for arbitrary scheduled times)",
    );
    console.log("\nScheduler is running. Press Ctrl+C to stop.\n");
  }

  async stop(): Promise<void> {
    schedulerLog("scheduler stop");
    console.log("\n⏹️  Stopping local scheduler...");

    if (this.marketOpenJob) {
      this.marketOpenJob.stop();
    }

    if (this.extendedHoursJob) {
      this.extendedHoursJob.stop();
    }

    if (this.catchUpJob) {
      this.catchUpJob.stop();
    }

    if (this.verificationJob) {
      this.verificationJob.stop();
    }

    if (this.optionExpirationJob) {
      this.optionExpirationJob.stop();
    }

    if (this.endOfDayVerifyJob) {
      this.endOfDayVerifyJob.stop();
    }

    if (this.heartbeatJob) {
      this.heartbeatJob.stop();
    }

    if (this.heartbeatGraceJob) {
      this.heartbeatGraceJob.stop();
    }

    if (this.dueOrdersInterval) {
      clearInterval(this.dueOrdersInterval);
      this.dueOrdersInterval = undefined;
    }

    if (this.heartbeatRowInterval) {
      clearInterval(this.heartbeatRowInterval);
      this.heartbeatRowInterval = undefined;
    }

    closeSchedulerLog();
    console.log("✓ Local scheduler stopped");
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const scheduler = new LocalScheduler();

  scheduler.start().catch((error) => {
    console.error("Failed to start scheduler:", error);
    process.exit(1);
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await scheduler.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await scheduler.stop();
    process.exit(0);
  });
}
