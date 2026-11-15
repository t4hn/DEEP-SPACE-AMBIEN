import type { ChannelId, MixerState } from './mixerState';

export type AmbientEventType =
  | 'reactor-fluctuation'
  | 'navigation-beacon'
  | 'communications-interference'
  | 'system-diagnostic'
  | 'sensor-anomaly'
  | 'structural-resonance'
  | 'hull-stress';

export interface AmbientEventDescriptor {
  type: AmbientEventType;
  label: string;
  statusText: string;
  supportedChannels: readonly ChannelId[];
  weight: number;
  cooldownMs: number;
}

export interface ScheduledAmbientSelection {
  event: AmbientEventDescriptor;
  targetChannel: ChannelId;
}

export const AMBIENT_EVENT_INITIAL_MIN_MS = 18_000;
export const AMBIENT_EVENT_INITIAL_MAX_MS = 35_000;
export const AMBIENT_EVENT_TYPICAL_MIN_MS = 30_000;
export const AMBIENT_EVENT_TYPICAL_MAX_MS = 90_000;
export const AMBIENT_EVENT_SILENCE_MIN_MS = 120_000;
export const AMBIENT_EVENT_SILENCE_MAX_MS = 210_000;

export const AMBIENT_EVENTS: readonly AmbientEventDescriptor[] = [
  {
    type: 'reactor-fluctuation',
    label: 'Reactor Fluctuation',
    statusText: 'Reactor fluctuation detected',
    supportedChannels: ['reactor'],
    weight: 1.0,
    cooldownMs: 75_000,
  },
  {
    type: 'navigation-beacon',
    label: 'Navigation Beacon',
    statusText: 'Navigation beacon acquired',
    supportedChannels: ['communications'],
    weight: 1.0,
    cooldownMs: 85_000,
  },
  {
    type: 'communications-interference',
    label: 'Communications Interference',
    statusText: 'Signal interference detected',
    supportedChannels: ['communications'],
    weight: 0.9,
    cooldownMs: 80_000,
  },
  {
    type: 'system-diagnostic',
    label: 'System Diagnostic',
    statusText: 'System diagnostic complete',
    supportedChannels: ['systems'],
    weight: 1.0,
    cooldownMs: 80_000,
  },
  {
    type: 'sensor-anomaly',
    label: 'Sensor Anomaly',
    statusText: 'Sensor anomaly detected',
    supportedChannels: ['systems', 'communications'],
    weight: 0.4,
    cooldownMs: 180_000,
  },
  {
    type: 'structural-resonance',
    label: 'Structural Resonance',
    statusText: 'Structural resonance detected',
    supportedChannels: ['hull'],
    weight: 0.65,
    cooldownMs: 130_000,
  },
  {
    type: 'hull-stress',
    label: 'Hull Stress',
    statusText: 'Hull stress load recorded',
    supportedChannels: ['hull'],
    weight: 0.55,
    cooldownMs: 150_000,
  },
] as const;

export function getAmbientEventDescriptor(type: AmbientEventType): AmbientEventDescriptor {
  const found = AMBIENT_EVENTS.find((ev) => ev.type === type);
  if (!found) {
    throw new Error(`Unknown ambient event type: ${type}`);
  }
  return found;
}

export function resolveEventTargetChannel(
  descriptor: AmbientEventDescriptor,
  state: MixerState,
  randomFn: () => number = Math.random,
): ChannelId | null {
  const enabledTargets = descriptor.supportedChannels.filter(
    (ch) => state.channels[ch]?.enabled,
  );
  if (enabledTargets.length === 0) {
    return null;
  }
  if (enabledTargets.length === 1) {
    return enabledTargets[0];
  }
  const idx = Math.min(
    enabledTargets.length - 1,
    Math.floor(randomFn() * enabledTargets.length),
  );
  return enabledTargets[idx];
}

export function getEligibleAmbientEvents(
  state: MixerState,
  nowMs: number,
  lastTriggeredAt: Partial<Record<AmbientEventType, number>>,
): AmbientEventDescriptor[] {
  if (!state.ambientEventsEnabled || !state.isActive) {
    return [];
  }

  return AMBIENT_EVENTS.filter((ev) => {
    const hasEnabledChannel = ev.supportedChannels.some((ch) => state.channels[ch]?.enabled);
    if (!hasEnabledChannel) return false;

    const lastAt = lastTriggeredAt[ev.type];
    if (lastAt !== undefined && nowMs - lastAt < ev.cooldownMs) {
      return false;
    }
    return true;
  });
}

export function selectAmbientEvent(
  eligible: readonly AmbientEventDescriptor[],
  state: MixerState,
  randomFn: () => number = Math.random,
): ScheduledAmbientSelection | null {
  if (eligible.length === 0 || !state.ambientEventsEnabled || !state.isActive) {
    return null;
  }

  const totalWeight = eligible.reduce((sum, ev) => sum + ev.weight, 0);
  if (totalWeight <= 0) return null;

  let cursor = randomFn() * totalWeight;
  let chosen = eligible[eligible.length - 1];
  for (const ev of eligible) {
    cursor -= ev.weight;
    if (cursor <= 0) {
      chosen = ev;
      break;
    }
  }

  const targetChannel = resolveEventTargetChannel(chosen, state, randomFn);
  if (!targetChannel) return null;

  return {
    event: chosen,
    targetChannel,
  };
}

export function computeAmbientEventDelayMs(
  options: {
    isInitial: boolean;
    overrideMs?: number | null;
  },
  randomFn: () => number = Math.random,
): number {
  if (
    options.overrideMs !== undefined &&
    options.overrideMs !== null &&
    Number.isFinite(options.overrideMs) &&
    options.overrideMs > 0
  ) {
    return Math.max(80, Math.round(options.overrideMs));
  }

  const r = Math.min(0.999999, Math.max(0, randomFn()));

  if (options.isInitial) {
    return Math.round(
      AMBIENT_EVENT_INITIAL_MIN_MS +
        r * (AMBIENT_EVENT_INITIAL_MAX_MS - AMBIENT_EVENT_INITIAL_MIN_MS),
    );
  }

  // Occasional longer periods of deep-space quiet (~18% of cycles: 2-3.5 min)
  if (r < 0.18) {
    const silenceRatio = r / 0.18;
    return Math.round(
      AMBIENT_EVENT_SILENCE_MIN_MS +
        silenceRatio * (AMBIENT_EVENT_SILENCE_MAX_MS - AMBIENT_EVENT_SILENCE_MIN_MS),
    );
  }

  // Typical conservative spacing: 30-90 seconds
  const typicalRatio = (r - 0.18) / 0.82;
  return Math.round(
    AMBIENT_EVENT_TYPICAL_MIN_MS +
      typicalRatio * (AMBIENT_EVENT_TYPICAL_MAX_MS - AMBIENT_EVENT_TYPICAL_MIN_MS),
  );
}
