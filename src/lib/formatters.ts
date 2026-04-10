import { formatDistance } from 'date-fns';
import { type BadgeTone } from '@aave-monitor/core';
import { type BadgeVariant } from '../components/ui/badge';

export function fmtUSD(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

export function fmtPct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function fmtAmount(value: number, digits = 4): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function fmtTimeAgo(value: string, now: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  if (date.getTime() >= now) return 'just now';
  return formatDistance(date, new Date(now), { addSuffix: true });
}

export function toBadgeVariant(tone: BadgeTone): BadgeVariant {
  if (tone === 'positive') return 'positive';
  if (tone === 'warning') return 'warning';
  if (tone === 'danger') return 'destructive';
  return 'default';
}
