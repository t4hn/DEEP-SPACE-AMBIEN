import type { ChannelId } from './mixerState';
import type { SpatialVec3 } from './spatialLayout';

export type AcousticProfileId =
  | 'engine-room'
  | 'bridge'
  | 'observation-deck'
  | 'research-lab';

export const DEFAULT_ACOUSTIC_PROFILE_ID: AcousticProfileId = 'bridge';

export interface ChannelAcousticAdjustment {
  /** Subtle positional offset added to the channel's base 3D coordinates (meters). */
  positionOffset: SpatialVec3;
  /** Multiplier applied to PannerNode refDistance (>1 keeps source fuller at distance). */
  refDistanceScale: number;
  /** Multiplier applied to PannerNode rolloffFactor (>1 increases distance attenuation). */
  rolloffScale: number;
  /** Gentle distance-trim gain multiplier on the channel spatial bus. */
  distanceTrim: number;
  /** Optional channel lowpass cutoff in Hz (null = transparent 18 kHz bypass). */
  lowpassCutoffHz: number | null;
  /** Gentle low-shelf EQ gain in dB around 105 Hz (kept subtle within [-1.5, +2.0] dB). */
  lowShelfGainDb: number;
  /** Proportion of channel output sent to the shared early-reflection bus [0..0.3]. */
  reflectionSend: number;
}

export interface RoomReflectionConfig {
  wetGain: number;
  delayLeftSec: number;
  delayRightSec: number;
  feedbackGain: number;
  dampingHz: number;
}

export interface AcousticProfile {
  id: AcousticProfileId;
  label: string;
  description: string;
  reflection: RoomReflectionConfig;
  channels: Record<ChannelId, ChannelAcousticAdjustment>;
}

/** Transparent bypass cutoff for channel acoustic lowpass filter. */
export const ACOUSTIC_BYPASS_LOWPASS_HZ = 18_000;

export const ACOUSTIC_PROFILES: readonly AcousticProfile[] = [
  {
    id: 'engine-room',
    label: 'ENGINE ROOM',
    description: 'Enclosed industrial bay with close core & drive presence',
    reflection: {
      wetGain: 0.11,
      delayLeftSec: 0.019,
      delayRightSec: 0.029,
      feedbackGain: 0.24,
      dampingHz: 950,
    },
    channels: {
      reactor: {
        positionOffset: { x: 0.0, y: 0.1, z: -0.7 },
        refDistanceScale: 1.25,
        rolloffScale: 0.85,
        distanceTrim: 1.06,
        lowpassCutoffHz: null,
        lowShelfGainDb: 1.8,
        reflectionSend: 0.14,
      },
      engines: {
        positionOffset: { x: -0.25, y: 0.1, z: -1.4 },
        refDistanceScale: 1.25,
        rolloffScale: 0.85,
        distanceTrim: 1.06,
        lowpassCutoffHz: null,
        lowShelfGainDb: 1.6,
        reflectionSend: 0.14,
      },
      ventilation: {
        positionOffset: { x: -0.3, y: 0.8, z: -0.8 },
        refDistanceScale: 0.82,
        rolloffScale: 1.25,
        distanceTrim: 0.82,
        lowpassCutoffHz: 960,
        lowShelfGainDb: -0.4,
        reflectionSend: 0.08,
      },
      systems: {
        positionOffset: { x: -0.45, y: 0.15, z: -1.35 },
        refDistanceScale: 0.8,
        rolloffScale: 1.25,
        distanceTrim: 0.8,
        lowpassCutoffHz: 1120,
        lowShelfGainDb: 0,
        reflectionSend: 0.1,
      },
      communications: {
        positionOffset: { x: 0.4, y: 0.15, z: -1.2 },
        refDistanceScale: 0.85,
        rolloffScale: 1.2,
        distanceTrim: 0.84,
        lowpassCutoffHz: 1200,
        lowShelfGainDb: 0,
        reflectionSend: 0.1,
      },
      hull: {
        positionOffset: { x: 0.0, y: -0.1, z: -0.1 },
        refDistanceScale: 1.1,
        rolloffScale: 0.9,
        distanceTrim: 1.04,
        lowpassCutoffHz: null,
        lowShelfGainDb: 1.2,
        reflectionSend: 0.18,
      },
    },
  },
  {
    id: 'bridge',
    label: 'BRIDGE',
    description: 'Balanced command deck with clear systems & minimal reflections',
    reflection: {
      wetGain: 0.045,
      delayLeftSec: 0.024,
      delayRightSec: 0.035,
      feedbackGain: 0.14,
      dampingHz: 1150,
    },
    channels: {
      reactor: {
        positionOffset: { x: 0.0, y: 0.0, z: 0.45 },
        refDistanceScale: 1.0,
        rolloffScale: 1.0,
        distanceTrim: 0.95,
        lowpassCutoffHz: null,
        lowShelfGainDb: 0,
        reflectionSend: 0.02,
      },
      engines: {
        positionOffset: { x: 0.0, y: 0.0, z: 0.5 },
        refDistanceScale: 1.0,
        rolloffScale: 1.0,
        distanceTrim: 0.95,
        lowpassCutoffHz: null,
        lowShelfGainDb: 0,
        reflectionSend: 0.02,
      },
      ventilation: {
        positionOffset: { x: 0.0, y: 0.0, z: 0.0 },
        refDistanceScale: 1.0,
        rolloffScale: 1.0,
        distanceTrim: 1.0,
        lowpassCutoffHz: null,
        lowShelfGainDb: 0,
        reflectionSend: 0.03,
      },
      systems: {
        positionOffset: { x: 0.15, y: -0.05, z: 0.35 },
        refDistanceScale: 1.08,
        rolloffScale: 0.95,
        distanceTrim: 1.03,
        lowpassCutoffHz: null,
        lowShelfGainDb: 0,
        reflectionSend: 0.04,
      },
      communications: {
        positionOffset: { x: -0.15, y: -0.05, z: 0.6 },
        refDistanceScale: 1.08,
        rolloffScale: 0.95,
        distanceTrim: 1.03,
        lowpassCutoffHz: null,
        lowShelfGainDb: 0,
        reflectionSend: 0.05,
      },
      hull: {
        positionOffset: { x: 0.0, y: 0.0, z: 0.1 },
        refDistanceScale: 1.0,
        rolloffScale: 1.0,
        distanceTrim: 0.96,
        lowpassCutoffHz: null,
        lowShelfGainDb: 0,
        reflectionSend: 0.05,
      },
    },
  },
  {
    id: 'observation-deck',
    label: 'OBSERVATION DECK',
    description: 'Spacious, quiet compartment with soft, restrained depth',
    reflection: {
      wetGain: 0.095,
      delayLeftSec: 0.038,
      delayRightSec: 0.053,
      feedbackGain: 0.25,
      dampingHz: 1250,
    },
    channels: {
      reactor: {
        positionOffset: { x: 0.0, y: -0.25, z: 1.8 },
        refDistanceScale: 0.85,
        rolloffScale: 1.22,
        distanceTrim: 0.78,
        lowpassCutoffHz: 920,
        lowShelfGainDb: -1.0,
        reflectionSend: 0.06,
      },
      engines: {
        positionOffset: { x: 0.25, y: -0.2, z: 2.2 },
        refDistanceScale: 0.85,
        rolloffScale: 1.22,
        distanceTrim: 0.78,
        lowpassCutoffHz: 920,
        lowShelfGainDb: -1.0,
        reflectionSend: 0.06,
      },
      ventilation: {
        positionOffset: { x: 0.0, y: 1.15, z: -0.8 },
        refDistanceScale: 0.9,
        rolloffScale: 1.15,
        distanceTrim: 0.84,
        lowpassCutoffHz: 1050,
        lowShelfGainDb: -0.4,
        reflectionSend: 0.1,
      },
      systems: {
        positionOffset: { x: -0.25, y: 0.1, z: -0.85 },
        refDistanceScale: 0.95,
        rolloffScale: 1.08,
        distanceTrim: 0.93,
        lowpassCutoffHz: 2200,
        lowShelfGainDb: 0,
        reflectionSend: 0.16,
      },
      communications: {
        positionOffset: { x: 0.3, y: 0.2, z: -1.0 },
        refDistanceScale: 0.95,
        rolloffScale: 1.05,
        distanceTrim: 0.94,
        lowpassCutoffHz: 1750,
        lowShelfGainDb: 0,
        reflectionSend: 0.2,
      },
      hull: {
        positionOffset: { x: 0.0, y: 0.3, z: 0.2 },
        refDistanceScale: 0.95,
        rolloffScale: 1.05,
        distanceTrim: 0.92,
        lowpassCutoffHz: null,
        lowShelfGainDb: -0.5,
        reflectionSend: 0.22,
      },
    },
  },
  {
    id: 'research-lab',
    label: 'RESEARCH LAB',
    description: 'Dry technical workspace focused on systems & telemetry',
    reflection: {
      wetGain: 0.025,
      delayLeftSec: 0.017,
      delayRightSec: 0.025,
      feedbackGain: 0.08,
      dampingHz: 1000,
    },
    channels: {
      reactor: {
        positionOffset: { x: 0.0, y: -0.15, z: 1.3 },
        refDistanceScale: 0.88,
        rolloffScale: 1.18,
        distanceTrim: 0.74,
        lowpassCutoffHz: 880,
        lowShelfGainDb: -1.2,
        reflectionSend: 0.01,
      },
      engines: {
        positionOffset: { x: 0.2, y: -0.15, z: 1.6 },
        refDistanceScale: 0.88,
        rolloffScale: 1.18,
        distanceTrim: 0.74,
        lowpassCutoffHz: 880,
        lowShelfGainDb: -1.2,
        reflectionSend: 0.01,
      },
      ventilation: {
        positionOffset: { x: 0.0, y: 0.4, z: -0.3 },
        refDistanceScale: 0.92,
        rolloffScale: 1.12,
        distanceTrim: 0.8,
        lowpassCutoffHz: 940,
        lowShelfGainDb: -0.5,
        reflectionSend: 0.02,
      },
      systems: {
        positionOffset: { x: 0.25, y: -0.05, z: 0.65 },
        refDistanceScale: 1.15,
        rolloffScale: 0.88,
        distanceTrim: 1.08,
        lowpassCutoffHz: null,
        lowShelfGainDb: 0,
        reflectionSend: 0.03,
      },
      communications: {
        positionOffset: { x: -0.25, y: -0.1, z: 1.1 },
        refDistanceScale: 1.15,
        rolloffScale: 0.88,
        distanceTrim: 1.06,
        lowpassCutoffHz: null,
        lowShelfGainDb: 0,
        reflectionSend: 0.04,
      },
      hull: {
        positionOffset: { x: 0.0, y: 0.0, z: 0.3 },
        refDistanceScale: 0.9,
        rolloffScale: 1.15,
        distanceTrim: 0.8,
        lowpassCutoffHz: null,
        lowShelfGainDb: -0.8,
        reflectionSend: 0.02,
      },
    },
  },
] as const;

export function getAcousticProfile(profileId: AcousticProfileId): AcousticProfile {
  return (
    ACOUSTIC_PROFILES.find((profile) => profile.id === profileId) ??
    ACOUSTIC_PROFILES.find((profile) => profile.id === DEFAULT_ACOUSTIC_PROFILE_ID)!
  );
}

export function applySpatialOffset(base: SpatialVec3, offset: SpatialVec3): SpatialVec3 {
  return {
    x: base.x + offset.x,
    y: base.y + offset.y,
    z: base.z + offset.z,
  };
}
