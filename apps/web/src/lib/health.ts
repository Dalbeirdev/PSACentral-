import type { HealthState } from '@psacc/contracts';

/**
 * Health-state presentation constants, shared by server and client components.
 * (Constants must not live in a 'use client' module: server components would receive
 * client-reference proxies instead of values.)
 *
 * Validated with the dataviz palette validator: adjacent CVD ΔE ≥ 8.9, normal-vision ΔE ≥ 19.8.
 * Offline/unknown are deliberately neutral (= "no signal"); every use pairs color with a label.
 */
export const HEALTH_COLORS: Record<HealthState, string> = {
  healthy: '#10B981',
  degraded: '#F59E0B',
  critical: '#EF4444',
  offline: '#475569',
  unknown: '#94A3B8',
};

export const HEALTH_LABELS: Record<HealthState, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  critical: 'Critical',
  offline: 'Offline',
  unknown: 'Unknown',
};

export const HEALTH_ORDER: HealthState[] = ['healthy', 'degraded', 'critical', 'offline', 'unknown'];
