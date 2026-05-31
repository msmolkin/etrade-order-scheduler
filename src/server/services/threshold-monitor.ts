import { ETradeClient } from "./etrade-client.js";
import { OrderService } from "./order-service.js";
import { OrderExecutor } from "./order-executor.js";
import type { Order, ThresholdPriceSource } from "../../shared/types/index.js";
import { promises as fs } from "fs";
import path from "path";

/** E*TRADE raw quote market data (nested under quote.All in API response) */
interface ETradeQuoteAll {
  lastTrade?: number;
  previousClose?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  lastSize?: number;
  [key: string]: unknown;
}

interface ActiveMonitor {
  order: Order;
  intervalId: NodeJS.Timeout;
  logFileHandle?: fs.FileHandle;
  lastPollTime: number;
}

export class ThresholdMonitor {
  private activeMonitors = new Map<string, ActiveMonitor>();
  private etradeClient: ETradeClient;
  private orderService: OrderService;
  private orderExecutor: OrderExecutor;
  private isRunning = false;

  constructor(
    etradeClient: ETradeClient,
    orderService: OrderService,
    orderExecutor: OrderExecutor,
  ) {
    this.etradeClient = etradeClient;
    this.orderService = orderService;
    this.orderExecutor = orderExecutor;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("[ThresholdMonitor] Already running");
      return;
    }

    this.isRunning = true;
    console.log("[ThresholdMonitor] Starting threshold monitor...");

    // Load active threshold orders from database
    const activeOrders = await this.orderService.getActiveThresholdOrders();
    console.log(
      `[ThresholdMonitor] Found ${activeOrders.length} active threshold orders`,
    );

    for (const order of activeOrders) {
      await this.startMonitoring(order);
    }

    console.log("[ThresholdMonitor] Started successfully");
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    console.log("[ThresholdMonitor] Stopping threshold monitor...");

    // Stop all active monitors
    const monitors = Array.from(this.activeMonitors.values());
    for (const monitor of monitors) {
      await this.stopMonitoring(monitor.order.id);
    }

    console.log("[ThresholdMonitor] Stopped");
  }

  async startMonitoring(order: Order): Promise<void> {
    if (!order.thresholdEnabled) {
      return;
    }

    if (this.activeMonitors.has(order.id)) {
      console.log(
        `[ThresholdMonitor] Order ${order.id} is already being monitored`,
      );
      return;
    }

    // Validate threshold configuration
    if (
      order.thresholdPrice == null ||
      order.thresholdQuantity == null ||
      !order.thresholdPriceSource
    ) {
      console.error(
        `[ThresholdMonitor] Order ${order.id} missing required threshold fields, skipping`,
      );
      return;
    }

    // Initialize log file if needed
    let logFileHandle: fs.FileHandle | undefined;
    if (order.thresholdLogFile) {
      try {
        // Ensure logs directory exists
        const logDir = path.dirname(order.thresholdLogFile);
        await fs.mkdir(logDir, { recursive: true });

        // Open file for appending
        logFileHandle = await fs.open(order.thresholdLogFile, "a");

        // Write header if file is new/empty
        const stats = await fs.stat(order.thresholdLogFile);
        if (stats.size === 0) {
          await logFileHandle.writeFile(
            "timestamp,symbol,bid,ask,last,bidSize,askSize,lastSize\n",
          );
        }
      } catch (error: any) {
        console.error(
          `[ThresholdMonitor] Failed to open log file ${order.thresholdLogFile}:`,
          error.message,
        );
      }
    }

    const pollInterval = order.thresholdPollIntervalMs ?? 1000;
    const monitor: ActiveMonitor = {
      order,
      intervalId: setInterval(() => this.pollOrder(order.id), pollInterval),
      logFileHandle,
      lastPollTime: Date.now(),
    };

    this.activeMonitors.set(order.id, monitor);

    // Do initial poll immediately
    setImmediate(() => this.pollOrder(order.id));

    console.log(
      `[ThresholdMonitor] Started monitoring order ${order.id} (${order.symbol}) - polling every ${pollInterval}ms`,
    );
  }

  async stopMonitoring(orderId: string): Promise<void> {
    const monitor = this.activeMonitors.get(orderId);
    if (!monitor) {
      return;
    }

    clearInterval(monitor.intervalId);
    if (monitor.logFileHandle) {
      await monitor.logFileHandle.close();
    }

    this.activeMonitors.delete(orderId);
    console.log(`[ThresholdMonitor] Stopped monitoring order ${orderId}`);
  }

  async activateSellOrderMonitoring(buyOrderId: string): Promise<void> {
    // Find sell orders that are triggered by this buy order
    const sellOrders =
      await this.orderService.getSellOrdersForBuyOrder(buyOrderId);

    for (const sellOrder of sellOrders) {
      console.log(
        `[ThresholdMonitor] Activating sell order monitoring for order ${sellOrder.id} (triggered by ${buyOrderId})`,
      );
      await this.startMonitoring(sellOrder);
    }
  }

  private async pollOrder(orderId: string): Promise<void> {
    const monitor = this.activeMonitors.get(orderId);
    if (!monitor) {
      return;
    }

    const order = monitor.order;
    const now = Date.now();

    // Skip if poll interval hasn't elapsed
    const pollInterval = order.thresholdPollIntervalMs ?? 1000;
    if (now - monitor.lastPollTime < pollInterval) {
      return;
    }

    monitor.lastPollTime = now;

    try {
      // Fetch quote
      const quotes = await this.etradeClient.getQuote([order.symbol]);
      if (!quotes || quotes.length === 0) {
        console.error(`[ThresholdMonitor] No quote data for ${order.symbol}`);
        return;
      }

      const quote = quotes[0] as ETradeQuoteAll & { All?: ETradeQuoteAll };
      const quoteData: ETradeQuoteAll = quote.All ?? quote;

      // Extract price based on price source
      const price = this.extractPrice(quoteData, order.thresholdPriceSource!);
      if (price == null) {
        return;
      }

      // Extract other quote data for logging
      const bid = quoteData.bid ?? null;
      const ask = quoteData.ask ?? null;
      const last = quoteData.lastTrade ?? quoteData.previousClose ?? null;
      const bidSize = quoteData.bidSize ?? null;
      const askSize = quoteData.askSize ?? null;
      const lastSize = quoteData.lastSize ?? null;

      // Log quote to file
      await this.logQuote(
        monitor,
        order.symbol,
        bid,
        ask,
        last,
        bidSize,
        askSize,
        lastSize,
      );

      // Check threshold condition
      const thresholdMet = this.checkThresholdCondition(
        price,
        order.thresholdPrice!,
        order.action,
        order.thresholdPriceSource!,
      );

      if (thresholdMet) {
        console.log(
          `[ThresholdMonitor] Threshold met for order ${order.id}: ${order.symbol} ${order.thresholdPriceSource} = ${price.toFixed(2)} (threshold: ${order.thresholdPrice})`,
        );

        // Stop monitoring this order
        await this.stopMonitoring(order.id);

        // Execute the order
        const lockerId = `threshold-${order.id}-${Date.now()}`;
        const success = await this.orderExecutor.executeOrder(order, lockerId);

        if (success) {
          // If this is a buy order and sell order is enabled, activate sell order monitoring
          if (order.action === "BUY" && order.sellOrderEnabled) {
            await this.activateSellOrderMonitoring(order.id);
          }
        } else {
          // Restart monitoring if execution failed
          console.log(
            `[ThresholdMonitor] Order execution failed, restarting monitoring for ${order.id}`,
          );
          await this.startMonitoring(order);
        }
      }
    } catch (error: any) {
      console.error(
        `[ThresholdMonitor] Error polling order ${order.id}:`,
        error.message,
      );
    }
  }

  private extractPrice(
    quoteData: ETradeQuoteAll,
    source: ThresholdPriceSource,
  ): number | null {
    switch (source) {
      case "BID":
        return quoteData.bid != null && Number.isFinite(quoteData.bid)
          ? quoteData.bid
          : null;
      case "ASK":
        return quoteData.ask != null && Number.isFinite(quoteData.ask)
          ? quoteData.ask
          : null;
      case "LAST":
        const last = quoteData.lastTrade ?? quoteData.previousClose;
        return last != null && Number.isFinite(last) ? last : null;
      default:
        return null;
    }
  }

  private checkThresholdCondition(
    currentPrice: number,
    thresholdPrice: number,
    action: string,
    priceSource: ThresholdPriceSource,
  ): boolean {
    // For BUY orders:
    // - LAST: buy when price drops below threshold (buy low)
    // - BID: buy when bid rises above threshold (favorable bid)
    // - ASK: buy when ask drops below threshold (favorable ask)
    // For SELL orders:
    // - LAST: sell when price rises above threshold (sell high)
    // - BID: sell when bid rises above threshold (favorable bid for selling)
    // - ASK: sell when ask rises above threshold (favorable ask for selling)

    if (action === "BUY") {
      if (priceSource === "LAST") {
        return currentPrice < thresholdPrice;
      } else if (priceSource === "BID") {
        // Buy when bid > threshold (bid is favorable)
        return currentPrice > thresholdPrice;
      } else {
        // ASK: buy when ask < threshold (ask is favorable)
        return currentPrice < thresholdPrice;
      }
    } else {
      // SELL
      if (priceSource === "LAST") {
        return currentPrice > thresholdPrice;
      } else if (priceSource === "BID") {
        // Sell when bid > threshold (bid is favorable for selling)
        return currentPrice > thresholdPrice;
      } else {
        // ASK: sell when ask > threshold (ask is favorable for selling)
        return currentPrice > thresholdPrice;
      }
    }
  }

  private async logQuote(
    monitor: ActiveMonitor,
    symbol: string,
    bid: number | null,
    ask: number | null,
    last: number | null,
    bidSize: number | null,
    askSize: number | null,
    lastSize: number | null,
  ): Promise<void> {
    if (!monitor.logFileHandle) {
      return;
    }

    try {
      const timestamp = new Date().toISOString();
      const line = `${timestamp},${symbol},${bid ?? ""},${ask ?? ""},${last ?? ""},${bidSize ?? ""},${askSize ?? ""},${lastSize ?? ""}\n`;
      await monitor.logFileHandle.appendFile(line);
    } catch (error: any) {
      console.error(
        `[ThresholdMonitor] Failed to write quote log:`,
        error.message,
      );
    }
  }

  async addOrder(order: Order): Promise<void> {
    if (order.thresholdEnabled) {
      await this.startMonitoring(order);
    }
  }

  async removeOrder(orderId: string): Promise<void> {
    await this.stopMonitoring(orderId);
  }

  async updateOrder(order: Order): Promise<void> {
    // Stop existing monitoring
    await this.stopMonitoring(order.id);

    // Start new monitoring if enabled
    if (order.thresholdEnabled) {
      await this.startMonitoring(order);
    }
  }
}
