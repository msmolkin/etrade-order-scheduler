import cron from 'node-cron';
import dotenv from 'dotenv';
import { SchedulerBase } from './scheduler-base.js';

dotenv.config();

export class LocalScheduler extends SchedulerBase {
  private marketOpenJob?: cron.ScheduledTask;
  private extendedHoursJob?: cron.ScheduledTask;
  private verificationJob?: cron.ScheduledTask;
  private verificationRunning = false;

  async start(): Promise<void> {
    console.log('🚀 Starting local scheduler...');
    console.log(`Scheduler ID: ${this.schedulerId}`);

    // Run work in setImmediate so the cron callback returns immediately, avoiding
    // "missed execution" when processScheduledOrders or other work blocks the event loop.
    const runMarketOpen = () => {
      setImmediate(async () => {
        console.log('\n📈 Market open trigger (9:30 AM EST)');
        await this.processScheduledOrders('MARKET');
      });
    };
    const runExtendedHours = () => {
      setImmediate(async () => {
        console.log('\n🌅 Extended hours trigger (7:00 AM EST)');
        await this.processScheduledOrders('EXTENDED');
      });
    };

    // Schedule for market open (9:30 AM EST, Monday-Friday)
    this.marketOpenJob = cron.schedule('30 9 * * 1-5', runMarketOpen, {
      timezone: process.env.SCHEDULER_TIMEZONE || 'America/New_York'
    });

    // Schedule for extended hours (7:00 AM EST, Monday-Friday)
    this.extendedHoursJob = cron.schedule('0 7 * * 1-5', runExtendedHours, {
      timezone: process.env.SCHEDULER_TIMEZONE || 'America/New_York'
    });

    // Verify order status every 15 minutes during market hours (skip if previous run still in progress)
    this.verificationJob = cron.schedule('*/15 * * * *', () => {
      setImmediate(async () => {
        if (!this.isMarketOpen()) return;
        if (this.verificationRunning) {
          console.log('\n🔍 Verification skipped (previous run still in progress)');
          return;
        }
        this.verificationRunning = true;
        try {
          console.log('\n🔍 Verifying order status...');
          await this.verifyRecentOrders();
        } finally {
          this.verificationRunning = false;
        }
      });
    }, {
      timezone: process.env.SCHEDULER_TIMEZONE || 'America/New_York'
    });

    console.log('✓ Local scheduler started successfully');
    console.log('  - Market open orders: 9:30 AM EST (Mon-Fri)');
    console.log('  - Extended hours orders: 7:00 AM EST (Mon-Fri)');
    console.log('  - Order verification: Every 15 minutes (during market hours)');
    console.log('\nScheduler is running. Press Ctrl+C to stop.\n');
  }

  async stop(): Promise<void> {
    console.log('\n⏹️  Stopping local scheduler...');

    if (this.marketOpenJob) {
      this.marketOpenJob.stop();
    }

    if (this.extendedHoursJob) {
      this.extendedHoursJob.stop();
    }

    if (this.verificationJob) {
      this.verificationJob.stop();
    }

    console.log('✓ Local scheduler stopped');
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const scheduler = new LocalScheduler();

  scheduler.start().catch((error) => {
    console.error('Failed to start scheduler:', error);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await scheduler.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await scheduler.stop();
    process.exit(0);
  });
}
