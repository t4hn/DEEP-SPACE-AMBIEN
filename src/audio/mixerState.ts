export type ChannelId =
  | 'reactor'
  | 'engines'
  | 'ventilation'
  | 'systems'
  | 'communications';

export interface ChannelMeta {
  id: ChannelId;
  code: string;
  name: string;
  description: string;
  defaultVolume: number;
}

export interface ChannelState {
  enabled: boolean;
  volume: number; // 0..1 linear slider value
}

export interface MixerState {
  isActive: boolean;
  masterVolume: number; // 0..1 linear slider value
  channels: Record<ChannelId, ChannelState>;
}

export const CHANNELS: readonly ChannelMeta[] = [
  {
    id: 'reactor',
    code: 'CH-01',
    name: 'Reactor',
    description: 'Deep continuous low-frequency core hum',
    defaultVolume: 0.75,
  },
  {
    id: 'engines',
    code: 'CH-02',
    name: 'Engines',
    description: 'Subtle mechanical drive rumble',
    defaultVolume: 0.6,
  },
  {
    id: 'ventilation',
    code: 'CH-03',
    name: 'Ventilation',
    description: 'Continuous cabin airflow and duct circulation',
    defaultVolume: 0.65,
  },
  {
    id: 'systems',
    code: 'CH-04',
    name: 'Systems',
    description: 'Quiet telemetry tones and processing pulses',
    defaultVolume: 0.4,
  },
  {
    id: 'communications',
    code: 'CH-05',
    name: 'Communications',
    description: 'Subtle subspace static and distant signal drift',
    defaultVolume: 0.3,
  },
] as const;

export const DEFAULT_MASTER_VOLUME = 0.8;

export function createInitialMixerState(): MixerState {
  return {
    isActive: false,
    masterVolume: DEFAULT_MASTER_VOLUME,
    channels: {
      reactor: { enabled: false, volume: 0.75 },
      engines: { enabled: false, volume: 0.6 },
      ventilation: { enabled: false, volume: 0.65 },
      systems: { enabled: false, volume: 0.4 },
      communications: { enabled: false, volume: 0.3 },
    },
  };
}

export type MixerAction =
  | { type: 'PLAY_ALL' }
  | { type: 'STOP_ALL' }
  | { type: 'RESET' }
  | { type: 'TOGGLE_CHANNEL'; channelId: ChannelId }
  | { type: 'SET_CHANNEL_VOLUME'; channelId: ChannelId; volume: number }
  | { type: 'SET_MASTER_VOLUME'; volume: number };

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Perceptual fader curve (x^1.8) so volume sliders feel smooth and natural
 * across low, mid, and high ranges rather than jumping too fast near 0.
 */
export function sliderToGain(sliderValue: number): number {
  const clamped = clampUnit(sliderValue);
  if (clamped === 0) return 0;
  return Math.pow(clamped, 1.8);
}

export function effectiveChannelGain(state: MixerState, channelId: ChannelId): number {
  if (!state.isActive) return 0;
  const channel = state.channels[channelId];
  if (!channel.enabled) return 0;
  return sliderToGain(channel.volume);
}

export function countEnabledChannels(state: MixerState): number {
  return CHANNELS.reduce((acc, ch) => (state.channels[ch.id].enabled ? acc + 1 : acc), 0);
}

export function formatPercent(value: number): string {
  return `${Math.round(clampUnit(value) * 100)}%`;
}

export function mixerReducer(state: MixerState, action: MixerAction): MixerState {
  switch (action.type) {
    case 'PLAY_ALL': {
      const nextChannels = { ...state.channels };
      for (const ch of CHANNELS) {
        nextChannels[ch.id] = {
          ...nextChannels[ch.id],
          enabled: true,
        };
      }
      return {
        ...state,
        isActive: true,
        channels: nextChannels,
      };
    }

    case 'STOP_ALL': {
      const nextChannels = { ...state.channels };
      for (const ch of CHANNELS) {
        nextChannels[ch.id] = {
          ...nextChannels[ch.id],
          enabled: false,
        };
      }
      return {
        ...state,
        isActive: false,
        channels: nextChannels,
      };
    }

    case 'RESET': {
      const defaults = createInitialMixerState();
      if (!state.isActive) {
        return defaults;
      }
      // When already listening, restore the balanced default 5-channel mix cleanly.
      const activeDefaultChannels = { ...defaults.channels };
      for (const ch of CHANNELS) {
        activeDefaultChannels[ch.id] = {
          ...activeDefaultChannels[ch.id],
          enabled: true,
        };
      }
      return {
        isActive: true,
        masterVolume: defaults.masterVolume,
        channels: activeDefaultChannels,
      };
    }

    case 'TOGGLE_CHANNEL': {
      const current = state.channels[action.channelId];
      const nextEnabled = !current.enabled;
      const nextChannels = {
        ...state.channels,
        [action.channelId]: {
          ...current,
          enabled: nextEnabled,
        },
      };
      const anyEnabled = CHANNELS.some((ch) => nextChannels[ch.id].enabled);
      return {
        ...state,
        isActive: anyEnabled,
        channels: nextChannels,
      };
    }

    case 'SET_CHANNEL_VOLUME': {
      const nextVolume = clampUnit(action.volume);
      return {
        ...state,
        channels: {
          ...state.channels,
          [action.channelId]: {
            ...state.channels[action.channelId],
            volume: nextVolume,
          },
        },
      };
    }

    case 'SET_MASTER_VOLUME': {
      return {
        ...state,
        masterVolume: clampUnit(action.volume),
      };
    }

    default:
      return state;
  }
}
