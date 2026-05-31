import { Router } from "express";
import crypto from "crypto";
import { OrderService } from "../services/order-service.js";
import { ETradeClient } from "../services/etrade-client.js";
import { OrderExecutor } from "../services/order-executor.js";
import { broadcastOrderUpdate } from "../ws-broadcast.js";
import { quoteCache } from "../services/quote-cache.js";
import { getThresholdMonitor } from "../context.js";
import type { Order, SessionTime } from "../../shared/types/index.js";

const router = Router();

/** Parse option expiration as date-only (YYYY-MM-DD) to avoid timezone/format bugs. Returns Date at noon UTC or undefined. */
function parseExpirationDateOnly(value: unknown): Date | undefined {
  if (value == null || value === "") return undefined;
  const s = typeof value === "string" ? value : String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!match) return undefined;
  const [, y, m, d] = match;
  const year = parseInt(y!, 10);
  const month = parseInt(m!, 10) - 1;
  const day = parseInt(d!, 10);
  if (month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month, day, 12, 0, 0, 0));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Next scheduled time (next trading day) in scheduler timezone: 7:00 for EXTENDED, 9:30 for MARKET. */
function getNextScheduledTime(sessionTime: SessionTime): Date {
  const tz = process.env.SCHEDULER_TIMEZONE || "America/New_York";
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + 1);
  let day = next.getUTCDay();
  if (day === 0) next.setUTCDate(next.getUTCDate() + 1);
  else if (day === 6) next.setUTCDate(next.getUTCDate() + 2);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  });
  const parts = formatter.formatToParts(next);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const offsetHours = tzName.includes("EDT") ? 4 : 5;
  const utcHour =
    sessionTime === "EXTENDED" ? 7 + offsetHours : 9 + offsetHours;
  const utcMin = sessionTime === "EXTENDED" ? 0 : 30;
  next.setUTCHours(utcHour, utcMin, 0, 0);
  return next;
}
const orderService = new OrderService();

// Create E*TRADE client (will be initialized with OAuth tokens from session)
function getETradeClient(): ETradeClient {
  const isSandbox = process.env.ETRADE_SANDBOX === "true";

  // Use sandbox-specific keys and tokens when in sandbox mode
  const consumerKey = isSandbox
    ? process.env.ETRADE_SANDBOX_KEY!
    : process.env.ETRADE_CONSUMER_KEY!;
  const consumerSecret = isSandbox
    ? process.env.ETRADE_SANDBOX_SECRET!
    : process.env.ETRADE_CONSUMER_SECRET!;
  const accessToken = isSandbox
    ? process.env.ETRADE_SANDBOX_ACCESS_TOKEN
    : process.env.ETRADE_ACCESS_TOKEN;
  const accessTokenSecret = isSandbox
    ? process.env.ETRADE_SANDBOX_ACCESS_TOKEN_SECRET
    : process.env.ETRADE_ACCESS_TOKEN_SECRET;

  return new ETradeClient(
    {
      consumerKey,
      consumerSecret,
      accessToken,
      accessTokenSecret,
    },
    isSandbox,
  );
}

// Get all orders
router.get("/", async (req, res) => {
  try {
    const { accountId, status, scheduleEnabled, parentId, limit } = req.query;

    // If scheduleEnabled is not provided, do NOT filter by it.
    const scheduleEnabledFilter =
      scheduleEnabled === undefined ? undefined : scheduleEnabled === "true";

    const parsedLimit = limit ? parseInt(limit as string) : 500;

    // Slice 4.3: parentId filter feeds the OrderThread child fetch.
    // Routes through getChildOrders, which excludes the parent row itself
    // and orders newest-first.
    if (typeof parentId === "string" && parentId.length > 0) {
      const children = await orderService.getChildOrders(parentId, parsedLimit);
      const body = JSON.stringify(children);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", Buffer.byteLength(body).toString());
      return res.status(200).end(body);
    }

    // Default Active-orders fetch goes through the single-statement query with
    // parent rollup. Fall back to the filterable getOrders path when the caller
    // narrows by status/account/scheduleEnabled (e.g. paused-only or per-account
    // views), so the deleted-list and other filtered routes still work.
    const usesFilters =
      status !== undefined ||
      accountId !== undefined ||
      scheduleEnabledFilter !== undefined;

    const orders = usesFilters
      ? await orderService.getOrders({
          accountId: accountId as string,
          status: status as any,
          scheduleEnabled: scheduleEnabledFilter,
          limit: parsedLimit,
        })
      : await orderService.getActiveOrdersWithLineage(parsedLimit);

    // ETag + 304: stable SHA-1 of the JSON body so clients can short-circuit on no-change.
    // Use res.end() (not res.send()) so Express does not override our explicit strong ETag.
    const body = JSON.stringify(orders);
    const etag =
      '"' + crypto.createHash("sha1").update(body).digest("hex") + '"';
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

    const ifNoneMatch = req.header("If-None-Match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      return res.status(304).end();
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body).toString());
    res.status(200).end(body);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get expired orders
router.get("/expired", async (req, res) => {
  try {
    const { limit } = req.query;
    const orders = await orderService.getExpiredOrders(
      limit ? parseInt(limit as string) : 50,
    );
    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get deleted orders
router.get("/deleted/list", async (req, res) => {
  try {
    const { limit } = req.query;
    const orders = await orderService.getDeletedOrders(
      limit ? parseInt(limit as string) : 50,
    );
    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get single order
router.get("/:id", async (req, res) => {
  try {
    const order = await orderService.getOrder(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    res.json(order);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Verify a single order's status against E*TRADE
router.post("/:id/verify", async (req, res) => {
  try {
    const order = await orderService.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.etradeOrderId) return res.json(order);
    const { OrderExecutor } = await import("../services/order-executor");
    const executor = new OrderExecutor(getETradeClient(), orderService);
    // Get raw E*TRADE status to extract fill price + commission
    const client = getETradeClient();
    let filledPrice: number | undefined;
    let commission: number | undefined;
    try {
      const raw = await client.getOrderStatus(order.accountId, order.etradeOrderId);
      const detail = raw.OrderDetail?.[0];
      const inst = detail?.Instrument?.[0];
      filledPrice = Number(inst?.averageExecutionPrice ?? 0) || undefined;
      commission = Number(inst?.estimatedCommission ?? 0) || undefined;
    } catch {}
    await executor.verifyOrderStatus(order);
    const updated = await orderService.getOrder(req.params.id);
    res.json({ ...updated, filledPrice, commission });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create new order
router.post("/", async (req, res) => {
  try {
    const raw = req.body as Record<string, unknown>;
    const required = [
      "accountId",
      "symbol",
      "securityType",
      "action",
      "orderType",
      "quantity",
      "preferredDuration",
      "actualDuration",
      "sessionTime",
      "scheduleEnabled",
    ] as const;
    for (const key of required) {
      if (raw[key] === undefined || raw[key] === null || raw[key] === "") {
        return res.status(400).json({
          error: `Missing or invalid required field: ${key}`,
        });
      }
    }

    const quantity =
      typeof raw.quantity === "number"
        ? raw.quantity
        : parseInt(String(raw.quantity), 10);
    if (Number.isNaN(quantity) || quantity < 1) {
      return res
        .status(400)
        .json({ error: "Quantity must be a positive integer" });
    }

    // Handle threshold order validation
    const isThresholdOrder = raw.orderType === "THRESHOLD";
    const thresholdEnabled = Boolean(raw.thresholdEnabled) || isThresholdOrder;

    if (isThresholdOrder) {
      if (!raw.thresholdPrice || raw.thresholdQuantity == null) {
        return res.status(400).json({
          error:
            "Threshold orders require thresholdPrice and thresholdQuantity",
        });
      }
    }

    // Set default threshold price source based on action
    let thresholdPriceSource =
      raw.thresholdPriceSource as Order["thresholdPriceSource"];
    if (thresholdEnabled && !thresholdPriceSource) {
      thresholdPriceSource = raw.action === "BUY" ? "BID" : "ASK";
    }

    // Generate log file path if not provided but threshold is enabled
    let thresholdLogFile = raw.thresholdLogFile as string | undefined;
    if (thresholdEnabled && !thresholdLogFile) {
      const symbol = String(raw.symbol).toUpperCase();
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      thresholdLogFile = `logs/quotes-${symbol}-${timestamp}.csv`;
    }

    const rawScheduleFrequency = String(
      raw.scheduleFrequency || "",
    ).toUpperCase();
    const hasExplicitScheduleFrequency =
      raw.scheduleFrequency != null &&
      String(raw.scheduleFrequency).trim() !== "";
    const scheduleFrequency: Order["scheduleFrequency"] =
      rawScheduleFrequency === "WEEKLY" ? "WEEKLY" : "DAILY";
    const scheduleEnabled = Boolean(raw.scheduleEnabled);
    const scheduleOnce =
      raw.scheduleOnce === undefined
        ? scheduleEnabled &&
          raw.scheduledFor != null &&
          String(raw.scheduledFor).trim() !== "" &&
          !hasExplicitScheduleFrequency
        : Boolean(raw.scheduleOnce);

    const orderData: Omit<
      Order,
      | "id"
      | "parentId"
      | "createdAt"
      | "updatedAt"
      | "status"
      | "requiresDaily"
      | "retryCount"
      | "maxRetries"
    > = {
      ...raw,
      accountId: String(raw.accountId),
      symbol: String(raw.symbol),
      securityType: raw.securityType as Order["securityType"],
      action: raw.action as Order["action"],
      orderType: raw.orderType as Order["orderType"],
      quantity,
      preferredDuration: raw.preferredDuration as Order["preferredDuration"],
      actualDuration: raw.actualDuration as Order["actualDuration"],
      sessionTime: raw.sessionTime as SessionTime,
      scheduleEnabled,
      scheduleFrequency,
      scheduleOnce,
      onlyFillOnce:
        raw.onlyFillOnce === undefined ? true : Boolean(raw.onlyFillOnce),
      limitPrice:
        raw.limitPrice != null && raw.limitPrice !== ""
          ? Number(raw.limitPrice)
          : undefined,
      stopPrice:
        raw.stopPrice != null && raw.stopPrice !== ""
          ? Number(raw.stopPrice)
          : undefined,
      strikePrice:
        raw.strikePrice != null && raw.strikePrice !== ""
          ? Number(raw.strikePrice)
          : undefined,
      expirationDate:
        parseExpirationDateOnly(raw.expirationDate) ??
        (raw.expirationDate
          ? new Date(raw.expirationDate as string)
          : undefined),
      optionSymbol:
        raw.optionSymbol != null && raw.optionSymbol !== ""
          ? String(raw.optionSymbol)
          : undefined,
      optionType: raw.optionType as Order["optionType"] | undefined,
      notes:
        raw.notes != null && raw.notes !== "" ? String(raw.notes) : undefined,
      thresholdEnabled,
      thresholdPrice:
        raw.thresholdPrice != null && raw.thresholdPrice !== ""
          ? Number(raw.thresholdPrice)
          : undefined,
      thresholdPriceSource,
      thresholdQuantity:
        raw.thresholdQuantity != null
          ? Number(raw.thresholdQuantity)
          : undefined,
      thresholdPollIntervalMs:
        raw.thresholdPollIntervalMs != null
          ? Number(raw.thresholdPollIntervalMs)
          : undefined,
      thresholdLogFile,
      sellOrderEnabled: Boolean(raw.sellOrderEnabled),
      sellOrderThresholdPrice:
        raw.sellOrderThresholdPrice != null &&
        raw.sellOrderThresholdPrice !== ""
          ? Number(raw.sellOrderThresholdPrice)
          : undefined,
      sellOrderThresholdPriceSource:
        raw.sellOrderThresholdPriceSource as Order["sellOrderThresholdPriceSource"],
      sellOrderQuantity:
        raw.sellOrderQuantity != null
          ? Number(raw.sellOrderQuantity)
          : undefined,
      sellOrderTriggeredByOrderId: raw.sellOrderTriggeredByOrderId as
        | string
        | undefined,
    };

    let scheduledFor: Date | undefined;
    if (raw.scheduledFor != null && String(raw.scheduledFor).trim() !== "") {
      const parsed = new Date(raw.scheduledFor as string);
      if (!Number.isNaN(parsed.getTime())) scheduledFor = parsed;
    }
    if (orderData.scheduleEnabled && !scheduledFor) {
      scheduledFor = getNextScheduledTime(orderData.sessionTime);
    }
    (orderData as Record<string, unknown>).scheduledFor = scheduledFor;

    const requiresDaily =
      orderData.scheduleEnabled && orderData.scheduleFrequency === "DAILY";

    const order = await orderService.createOrder({
      ...orderData,
      requiresDaily,
      status:
        raw.status === "PAUSED"
          ? "PAUSED"
          : orderData.scheduleEnabled
            ? "SCHEDULED"
            : "PENDING",
      retryCount: 0,
      maxRetries: Number(raw.maxRetries) || 3,
    });

    // If this is a buy order with sell order enabled, create the sell order
    let sellOrder: Order | null = null;
    if (
      order.action === "BUY" &&
      order.sellOrderEnabled &&
      order.sellOrderThresholdPrice != null &&
      order.sellOrderQuantity != null
    ) {
      const sellOrderData: Omit<
        Order,
        | "id"
        | "parentId"
        | "createdAt"
        | "updatedAt"
        | "requiresDaily"
        | "retryCount"
        | "maxRetries"
      > = {
        ...orderData,
        action: "SELL",
        thresholdEnabled: true,
        thresholdPrice: order.sellOrderThresholdPrice,
        thresholdPriceSource: order.sellOrderThresholdPriceSource || "ASK",
        thresholdQuantity: order.sellOrderQuantity,
        thresholdPollIntervalMs: order.thresholdPollIntervalMs,
        thresholdLogFile: order.thresholdLogFile
          ? order.thresholdLogFile.replace(/\.csv$/, "-sell.csv")
          : undefined,
        sellOrderEnabled: false,
        sellOrderTriggeredByOrderId: order.id,
        status: "PENDING",
      };

      sellOrder = await orderService.createOrder({
        ...sellOrderData,
        requiresDaily,
        retryCount: 0,
        maxRetries: Number(raw.maxRetries) || 3,
      });

      console.log(
        `[POST /api/orders] created sell order ${sellOrder.id} (triggered by ${order.id})`,
      );
    }

    console.log(
      `[POST /api/orders] created ${order.id} ${order.symbol} ${order.status} scheduleEnabled=${order.scheduleEnabled} thresholdEnabled=${order.thresholdEnabled}`,
    );

    // Start threshold monitoring if enabled
    const thresholdMonitor = getThresholdMonitor?.() ?? null;
    if (order.thresholdEnabled && thresholdMonitor) {
      await thresholdMonitor.addOrder(order);
    }

    broadcastOrderUpdate(order);
    if (sellOrder) {
      broadcastOrderUpdate(sellOrder);
    }

    res.status(201).json(order);
  } catch (error: any) {
    console.error("Create order failed:", error);
    let errMsg = error?.message || error?.code || String(error);
    if (
      error?.code === "ECONNREFUSED" ||
      (typeof errMsg === "string" && errMsg.includes("ECONNREFUSED"))
    ) {
      errMsg =
        "Database connection refused. Is PostgreSQL running? Check DATABASE_URL in .env.";
    }
    res.status(400).json({ error: errMsg || "Failed to create order" });
  }
});

// Resend expired order
router.post("/:id/resend", async (req, res) => {
  try {
    const existingOrder = await orderService.getOrder(req.params.id);
    if (!existingOrder) {
      return res.status(404).json({ error: "Order not found" });
    }

    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...baseOrder
    } = existingOrder;

    // Create a new order based on the expired one
    const newOrder = await orderService.createOrder({
      ...baseOrder,
      status: existingOrder.scheduleEnabled ? "SCHEDULED" : "PENDING",
      etradeOrderId: undefined,
      submittedAt: undefined,
      filledAt: undefined,
      cancelledAt: undefined,
      expiresAt: undefined,
      lastError: undefined,
      retryCount: 0,
    });

    broadcastOrderUpdate(newOrder);
    res.status(201).json(newOrder);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Submit order immediately to E*TRADE
router.post("/:id/submit", async (req, res) => {
  try {
    const order = await orderService.getOrder(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Validate order is in a submittable state
    if (order.status !== "PENDING" && order.status !== "SCHEDULED") {
      return res.status(400).json({
        error: `Order is ${order.status}, must be PENDING or SCHEDULED to submit`,
      });
    }

    // Execute order immediately using OrderExecutor
    const client = getETradeClient();
    const executor = new OrderExecutor(client, orderService);
    const lockerId = `manual-submit-${Date.now()}`;

    const success = await executor.executeOrder(order, lockerId);

    // Return updated order
    const updatedOrder = await orderService.getOrder(req.params.id);
    res.json({ success, order: updatedOrder });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel an open broker-side E*TRADE order surfaced in an error message.
router.post("/broker/:orderId/cancel", async (req, res) => {
  try {
    const { accountIdKey } = req.body ?? {};
    if (!accountIdKey || typeof accountIdKey !== "string") {
      return res.status(400).json({ error: "accountIdKey is required" });
    }

    const client = getETradeClient();
    await client.cancelOrder(accountIdKey, req.params.orderId);
    res.json({ success: true, orderId: req.params.orderId });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: error.message || "Failed to cancel broker order" });
  }
});

// Update order
router.patch("/:id", async (req, res) => {
  try {
    const {
      status,
      expirationDate: rawExpiration,
      quantity,
      limitPrice,
      onlyFillOnce,
      ...details
    } = req.body;

    if (status) {
      await orderService.updateOrderStatus(req.params.id, status, details);
    }

    if (onlyFillOnce !== undefined) {
      await orderService.updateOrderOnlyFillOnce(
        req.params.id,
        Boolean(onlyFillOnce),
      );
    }

    if (rawExpiration !== undefined) {
      const expirationDate = parseExpirationDateOnly(rawExpiration);
      if (expirationDate) {
        await orderService.updateOrderExpiration(req.params.id, expirationDate);
      }
    }

    if (quantity !== undefined) {
      const parsedQty =
        typeof quantity === "number"
          ? quantity
          : parseInt(String(quantity), 10);
      if (Number.isNaN(parsedQty) || parsedQty < 1) {
        return res
          .status(400)
          .json({ error: "Quantity must be a positive integer" });
      }
      await orderService.updateOrderQuantity(req.params.id, parsedQty);
    }

    if (limitPrice !== undefined) {
      const parsedPrice =
        typeof limitPrice === "number"
          ? limitPrice
          : parseFloat(String(limitPrice));
      if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
        return res
          .status(400)
          .json({ error: "Limit price must be a non-negative number" });
      }
      await orderService.updateOrderLimitPrice(req.params.id, parsedPrice);
    }

    const order = await orderService.getOrder(req.params.id);
    broadcastOrderUpdate(order!);
    res.json(order);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Soft-delete order (sets status to DELETED)
router.delete("/:id", async (req, res) => {
  try {
    await orderService.deleteOrder(req.params.id);
    const order = await orderService.getOrder(req.params.id);
    if (order) broadcastOrderUpdate(order);
    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Restore a deleted order
router.post("/:id/restore", async (req, res) => {
  try {
    const order = await orderService.restoreOrder(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Deleted order not found" });
    }
    broadcastOrderUpdate(order);
    res.json(order);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Permanently delete order (only if already soft-deleted)
router.delete("/:id/permanent", async (req, res) => {
  try {
    await orderService.permanentlyDeleteOrder(req.params.id);
    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Pause all scheduled orders
router.post("/pause-all", async (req, res) => {
  try {
    const count = await orderService.pauseAllScheduled();
    res.json({ paused: count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Resume all paused orders
router.post("/resume-all", async (req, res) => {
  try {
    const count = await orderService.resumeAllPaused();
    res.json({ resumed: count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Pause a single order
router.post("/:id/pause", async (req, res) => {
  try {
    await orderService.pauseOrder(req.params.id);
    const order = await orderService.getOrder(req.params.id);
    if (order) broadcastOrderUpdate(order);
    res.json(order);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Resume a single order
router.post("/:id/resume", async (req, res) => {
  try {
    await orderService.resumeOrder(req.params.id);
    const order = await orderService.getOrder(req.params.id);
    if (order) broadcastOrderUpdate(order);
    res.json(order);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get option expiration dates only (for order form dropdown)
router.get("/market/option-expirations", async (req, res) => {
  try {
    const { symbol } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: "Symbol is required" });
    }

    const client = getETradeClient();
    const rawDates = await client.getOptionExpireDates(symbol as string);
    const expirationDates = rawDates.map(
      (d) =>
        `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`,
    );

    res.json({ expirationDates });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get options chain
router.get("/market/options-chain", async (req, res) => {
  try {
    const { symbol, expirationDate } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: "Symbol is required" });
    }

    const client = getETradeClient();
    const optionsChain = await client.getOptionsChain(
      symbol as string,
      expirationDate as string,
    );

    res.json(optionsChain);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Test order placement (debug endpoint)
// Requires accountIdKey in request body (e.g. from .account-nicknames.json or GET /accounts).
router.post("/test-place", async (req, res) => {
  try {
    const { accountIdKey } = req.body;
    if (!accountIdKey || typeof accountIdKey !== "string") {
      return res.status(400).json({
        error: "accountIdKey required in request body",
        hint: "Get accountIdKey from GET /v1/accounts/list or your account nicknames.",
      });
    }
    const client = getETradeClient();
    console.log("Testing order placement from server...");

    const result = await client.placeOrder({
      accountIdKey,
      symbol: "AAPL",
      orderAction: "BUY",
      clientOrderId: `tst${Date.now()}`, // ≤20 alphanumeric (E*TRADE)
      priceType: "LIMIT",
      quantity: 1,
      orderTerm: "GOOD_FOR_DAY",
      marketSession: "REGULAR",
      limitPrice: 150,
    });

    res.json({ success: true, result });
  } catch (error: any) {
    console.error(
      "Test place error:",
      error.response?.status,
      error.response?.data,
    );
    res.status(500).json({
      success: false,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
  }
});

/** Normalize E*TRADE quote: market data lives in .All with lastTrade (not last). */
function normalizeQuote(raw: any): {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  lastTrade: number;
} {
  const all = raw?.All ?? raw;
  const eh = all?.ExtendedHourQuoteDetail;
  const bid = typeof all?.bid === "number" ? all.bid : 0;
  const ask = typeof all?.ask === "number" ? all.ask : 0;
  const lastTrade = typeof all?.lastTrade === "number" ? all.lastTrade : 0;
  const ehLast = typeof eh?.lastPrice === "number" ? eh.lastPrice : 0;
  const previousClose =
    typeof all?.previousClose === "number" ? all.previousClose : 0;
  const last =
    ehLast || lastTrade || previousClose || (bid && ask ? (bid + ask) / 2 : bid || ask);
  const symbol = raw?.symbol ?? all?.symbol ?? "";
  return {
    symbol: String(symbol).toUpperCase(),
    bid,
    ask,
    last,
    lastTrade: lastTrade || last,
  };
}

// Get quote
router.get("/market/quote", async (req, res) => {
  try {
    const { symbols } = req.query;

    if (!symbols) {
      return res.status(400).json({ error: "Symbols are required" });
    }

    const symbolArray = (symbols as string)
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (symbolArray.length === 0) {
      return res.status(400).json({ error: "At least one symbol is required" });
    }

    const client = getETradeClient();
    // Fan out per-symbol so quoteCache can coalesce concurrent calls for the
    // same ticker and serve warm hits without waking E*TRADE. Each cache miss
    // hits the API for a single symbol, which matches getQuote's contract.
    const settled = await Promise.all(
      symbolArray.map((sym) =>
        quoteCache
          .getQuote(sym, async () => {
            const raw = await client.getQuote([sym]);
            const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
            return arr[0];
          })
          .catch((err) => {
            console.error(`[/market/quote] ${sym}: ${err?.message ?? err}`);
            return undefined;
          }),
      ),
    );
    const quotes = settled
      .filter((q): q is unknown => q !== undefined)
      .map(normalizeQuote);

    res.json(quotes);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
