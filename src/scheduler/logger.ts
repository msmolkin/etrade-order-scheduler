import fs from 'fs';
import path from 'path';

let logStream: fs.WriteStream | null = null;

function timestamp(): string {
  return new Date().toISOString();
}

function ensureLogDir(logPath: string): void {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Initialize persistent file logging for the scheduler.
 * Call once when the local scheduler starts. Writes to SCHEDULER_LOG_PATH or logs/scheduler.log.
 */
export function initSchedulerLog(): void {
  if (logStream) return;
  const logPath = process.env.SCHEDULER_LOG_PATH || path.join(process.cwd(), 'logs', 'scheduler.log');
  ensureLogDir(logPath);
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
}

/**
 * Close the log stream (e.g. on scheduler stop). Safe to call if not initialized.
 */
export function closeSchedulerLog(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

/**
 * Write a line to the scheduler log file (and console). No-op if init was not called.
 */
export function log(message: string): void {
  const line = `[${timestamp()}] ${message}\n`;
  if (logStream?.writable) {
    logStream.write(line);
  }
  console.log(message);
}

/**
 * Write an error line to the scheduler log file (and console). No-op if init was not called.
 */
export function error(message: string, err?: unknown): void {
  const errDetail = err instanceof Error ? err.message : err != null ? String(err) : '';
  const full = errDetail ? `${message} ${errDetail}` : message;
  const line = `[${timestamp()}] ERROR ${full}\n`;
  if (logStream?.writable) {
    logStream.write(line);
  }
  console.error(message, errDetail ? errDetail : '');
}

/**
 * Log an order attempt result for the persistent log (order id, symbol, success/fail, error if any).
 */
export function logOrderAttempt(orderId: string, symbol: string, success: boolean, errorMessage?: string): void {
  const result = success ? 'success' : 'fail';
  const msg = errorMessage ? `order_attempt orderId=${orderId} symbol=${symbol} result=${result} error=${errorMessage}` : `order_attempt orderId=${orderId} symbol=${symbol} result=${result}`;
  const line = `[${timestamp()}] ${msg}\n`;
  if (logStream?.writable) {
    logStream.write(line);
  }
  // Console already has per-order messages from order-executor; avoid duplicate lines
  if (!success && errorMessage) {
    console.error(`[scheduler log] ${msg}`);
  }
}
