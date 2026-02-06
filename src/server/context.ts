import type { ThresholdMonitor } from './services/threshold-monitor.js';

export let getThresholdMonitor: (() => ThresholdMonitor | null) | null = null;

export function setGetThresholdMonitor(fn: () => ThresholdMonitor | null): void {
  getThresholdMonitor = fn;
}
