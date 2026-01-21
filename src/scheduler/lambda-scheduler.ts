import { SchedulerBase } from './scheduler-base.js';
import type { SessionTime } from '../shared/types/index.js';

export class LambdaScheduler extends SchedulerBase {
  async start(): Promise<void> {
    // Lambda doesn't need a persistent start - it's triggered by EventBridge
    console.log('Lambda scheduler initialized');
  }

  async stop(): Promise<void> {
    // No cleanup needed for Lambda
  }

  async handleEvent(event: any): Promise<any> {
    console.log('Lambda invoked with event:', JSON.stringify(event));

    try {
      const sessionTime: SessionTime = event.sessionTime || 'MARKET';

      console.log(`Processing ${sessionTime} orders via Lambda...`);
      await this.processScheduledOrders(sessionTime);

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: `Successfully processed ${sessionTime} orders`,
          schedulerId: this.schedulerId,
        }),
      };
    } catch (error: any) {
      console.error('Lambda execution error:', error);

      return {
        statusCode: 500,
        body: JSON.stringify({
          error: error.message,
          schedulerId: this.schedulerId,
        }),
      };
    }
  }
}

// Lambda handler
export async function handler(event: any): Promise<any> {
  const scheduler = new LambdaScheduler();
  await scheduler.start();
  return scheduler.handleEvent(event);
}
