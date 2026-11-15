import type { AmbientEventDescriptor } from './ambientEvents';
import { CHANNELS, type ChannelId, type MixerState, countEnabledChannels } from './mixerState';

export type OperationalStatus = 'STANDBY' | 'OPERATIONAL' | 'FULL SYSTEMS';

export interface VesselIdentification {
  designation: string;
  name: string;
  classification: string;
}

export const VESSEL_IDENTIFICATION: VesselIdentification = {
  designation: 'DSV-01',
  name: 'DEEP SPACE',
  classification: 'Autonomous Research Vessel',
} as const;

export const SYSTEM_NAMES: Record<ChannelId, string> = {
  reactor: 'REACTOR',
  engines: 'PROPULSION',
  ventilation: 'LIFE SUPPORT',
  systems: 'COMPUTER',
  communications: 'COMMUNICATIONS',
  hull: 'HULL',
} as const;

export interface ShipSystemStatus {
  channelId: ChannelId;
  code: string;
  systemName: string;
  channelName: string;
  active: boolean;
  statusLabel: 'ACTIVE' | 'STANDBY';
}

export interface AmbientMonitoringStatus {
  enabled: boolean;
  toggleLabel: 'ENABLED' | 'DISABLED';
  readout: string;
  hasEvent: boolean;
}

export function deriveOperationalStatus(state: MixerState): OperationalStatus {
  if (!state.isActive) {
    return 'STANDBY';
  }
  const activeCount = countEnabledChannels(state);
  if (activeCount <= 0) {
    return 'STANDBY';
  }
  if (activeCount >= CHANNELS.length) {
    return 'FULL SYSTEMS';
  }
  return 'OPERATIONAL';
}

export function deriveShipSystems(state: MixerState): ShipSystemStatus[] {
  return CHANNELS.map((ch) => {
    const active = state.isActive && state.channels[ch.id].enabled;
    return {
      channelId: ch.id,
      code: ch.code,
      systemName: SYSTEM_NAMES[ch.id],
      channelName: ch.name,
      active,
      statusLabel: active ? 'ACTIVE' : 'STANDBY',
    };
  });
}

export function deriveAmbientMonitoring(
  ambientEventsEnabled: boolean,
  lastAmbientEvent: AmbientEventDescriptor | null,
): AmbientMonitoringStatus {
  if (!ambientEventsEnabled) {
    return {
      enabled: false,
      toggleLabel: 'DISABLED',
      readout: 'OFFLINE',
      hasEvent: false,
    };
  }

  if (lastAmbientEvent) {
    return {
      enabled: true,
      toggleLabel: 'ENABLED',
      readout: lastAmbientEvent.statusText,
      hasEvent: true,
    };
  }

  return {
    enabled: true,
    toggleLabel: 'ENABLED',
    readout: 'MONITORING',
    hasEvent: false,
  };
}
