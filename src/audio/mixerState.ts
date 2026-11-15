export type ChannelId =
  | 'reactor'
  | 'engines'
  | 'ventilation'
  | 'systems'
  | 'communications';

export type PresetId =
  | 'deep-transit'
  | 'research-station'
  | 'silent-watch'
  | 'engineering-deck';

export type ActivePresetState = PresetId | 'custom' | null;

export interface ChannelMeta {
  id: ChannelId;
  code: string;
  name: string;
  description: string;
  defaultVolume: number;
}

export interface EnvironmentPreset {
  id: PresetId;
  name: string;
  description: string;
  volumes: Record<ChannelId, number>;
}

export interface ChannelState {
  enabled: boolean;
  volume: number; // 0..1 linear slider value
}

export interface MixerState {
  isActive: boolean;
  activePresetId: ActivePresetState;
  ambientEventsEnabled: boolean;
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

export const ENVIRONMENT_PRESETS: readonly EnvironmentPreset[] = [
  {
    id: 'deep-transit',
    name: 'Deep Transit',
    description: 'High-thrust cruise with dominant drive rumble',
    volumes: {
      reactor: 0.65,
      engines: 0.85,
      ventilation: 0.3,
      systems: 0.15,
      communications: 0.1,
    },
  },
  {
    id: 'research-station',
    name: 'Research Station',
    description: 'Balanced orbital lab with steady airflow and telemetry',
    volumes: {
      reactor: 0.65,
      engines: 0.1,
      ventilation: 0.65,
      systems: 0.45,
      communications: 0.25,
    },
  },
  {
    id: 'silent-watch',
    name: 'Silent Watch',
    description: 'Low-output night watch with propulsion offline',
    volumes: {
      reactor: 0.3,
      engines: 0,
      ventilation: 0.15,
      systems: 0.05,
      communications: 0.1,
    },
  },
  {
    id: 'engineering-deck',
    name: 'Engineering Deck',
    description: 'Heavy core output and high-volume air circulation',
    volumes: {
      reactor: 0.9,
      engines: 0.55,
      ventilation: 0.85,
      systems: 0.35,
      communications: 0.05,
    },
  },
] as const;

export const DEFAULT_MASTER_VOLUME = 0.8;

export function createInitialMixerState(): MixerState {
  return {
    isActive: false,
    activePresetId: null,
    ambientEventsEnabled: false,
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
  | { type: 'SELECT_PRESET'; presetId: PresetId }
  | { type: 'TOGGLE_AMBIENT_EVENTS' }
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
      let changedFromState = false;
      for (const ch of CHANNELS) {
        if (!nextChannels[ch.id].enabled) {
          changedFromState = true;
        }
        nextChannels[ch.id] = {
          ...nextChannels[ch.id],
          enabled: true,
        };
      }
      return {
        ...state,
        isActive: true,
        activePresetId:
          state.activePresetId !== null && changedFromState ? 'custom' : state.activePresetId,
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
        activePresetId: null,
        channels: nextChannels,
      };
    }

    case 'RESET': {
      const defaults = createInitialMixerState();
      if (!state.isActive) {
        return defaults;
      }
      // When already listening, restore the balanced default 5-channel mix and clear preset.
      const activeDefaultChannels = { ...defaults.channels };
      for (const ch of CHANNELS) {
        activeDefaultChannels[ch.id] = {
          ...activeDefaultChannels[ch.id],
          enabled: true,
        };
      }
      return {
        isActive: true,
        activePresetId: null,
        ambientEventsEnabled: false,
        masterVolume: defaults.masterVolume,
        channels: activeDefaultChannels,
      };
    }

    case 'TOGGLE_AMBIENT_EVENTS': {
      return {
        ...state,
        ambientEventsEnabled: !state.ambientEventsEnabled,
      };
    }

    case 'SELECT_PRESET': {
      const preset = ENVIRONMENT_PRESETS.find((p) => p.id === action.presetId);
      if (!preset) return state;

      const nextChannels = { ...state.channels };
      for (const ch of CHANNELS) {
        const volume = clampUnit(preset.volumes[ch.id]);
        nextChannels[ch.id] = {
          volume,
          enabled: volume > 0,
        };
      }

      const anyEnabled = CHANNELS.some((ch) => nextChannels[ch.id].enabled);
      return {
        ...state,
        isActive: anyEnabled,
        activePresetId: preset.id,
        channels: nextChannels,
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
        activePresetId: state.activePresetId !== null ? 'custom' : null,
        channels: nextChannels,
      };
    }

    case 'SET_CHANNEL_VOLUME': {
      const nextVolume = clampUnit(action.volume);
      return {
        ...state,
        activePresetId: state.activePresetId !== null ? 'custom' : null,
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
