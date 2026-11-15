import type { ChannelId } from './mixerState';

export interface SpatialVec3 {
  x: number;
  y: number;
  z: number;
}

export interface ChannelSpatialProfile {
  channelId: ChannelId;
  zoneLabel: string;
  position: SpatialVec3;
  panningModel: 'HRTF' | 'equalpower';
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  distanceGain: number;
  airAbsorptionHz: number | null;
}

export interface SpatialTrajectory {
  start: SpatialVec3;
  end: SpatialVec3;
}

export const LISTENER_POSITION: SpatialVec3 = { x: 0, y: 0, z: 0 };
export const LISTENER_FORWARD: SpatialVec3 = { x: 0, y: 0, z: -1 };
export const LISTENER_UP: SpatialVec3 = { x: 0, y: 1, z: 0 };

/**
 * Conceptual 3D acoustic layout around the central operational area (0, 0, 0).
 * Right-handed Web Audio coordinates: +X right, +Y up, -Z forward, +Z aft.
 */
export const CHANNEL_SPATIAL_PROFILES: Record<ChannelId, ChannelSpatialProfile> = {
  reactor: {
    channelId: 'reactor',
    zoneLabel: 'Central / Slightly Aft Core',
    position: { x: 0.0, y: -0.6, z: 2.2 },
    panningModel: 'equalpower', // Preserves deep 52 Hz phase coherence without HRTF bass coloration
    refDistance: 2.0,
    maxDistance: 16,
    rolloffFactor: 0.25,
    distanceGain: 0.96,
    airAbsorptionHz: null,
  },
  engines: {
    channelId: 'engines',
    zoneLabel: 'Aft Propulsion Bay (Offset)',
    position: { x: 0.85, y: -0.45, z: 4.5 },
    panningModel: 'equalpower',
    refDistance: 2.4,
    maxDistance: 18,
    rolloffFactor: 0.28,
    distanceGain: 0.94,
    airAbsorptionHz: null,
  },
  ventilation: {
    channelId: 'ventilation',
    zoneLabel: 'Overhead Environmental Ducting',
    position: { x: -0.2, y: 2.6, z: -0.4 },
    panningModel: 'HRTF',
    refDistance: 3.2,
    maxDistance: 18,
    rolloffFactor: 0.18,
    distanceGain: 0.95,
    airAbsorptionHz: 1450,
  },
  systems: {
    channelId: 'systems',
    zoneLabel: 'Forward Control & Processing Console',
    position: { x: -1.15, y: 0.25, z: -2.4 },
    panningModel: 'HRTF',
    refDistance: 2.0,
    maxDistance: 14,
    rolloffFactor: 0.34,
    distanceGain: 0.96,
    airAbsorptionHz: null,
  },
  communications: {
    channelId: 'communications',
    zoneLabel: 'Forward Distant Receiver Array',
    position: { x: 1.35, y: 0.45, z: -5.2 },
    panningModel: 'HRTF',
    refDistance: 2.4,
    maxDistance: 20,
    rolloffFactor: 0.38,
    distanceGain: 0.88,
    airAbsorptionHz: 1550,
  },
  hull: {
    channelId: 'hull',
    zoneLabel: 'Surrounding Vessel Structure',
    position: { x: 0.0, y: 0.35, z: 0.4 },
    panningModel: 'equalpower',
    refDistance: 2.6,
    maxDistance: 20,
    rolloffFactor: 0.2,
    distanceGain: 0.96,
    airAbsorptionHz: null,
  },
};

export function computeSpatialDistance(pos: SpatialVec3): number {
  return Math.hypot(
    pos.x - LISTENER_POSITION.x,
    pos.y - LISTENER_POSITION.y,
    pos.z - LISTENER_POSITION.z,
  );
}

/**
 * Fallback equal-power stereo pan [-0.85..0.85] derived from 3D coordinates when
 * PannerNode / HRTF is unavailable. Never produces extreme hard +/-1.0 panning.
 */
export function computeFallbackStereoPan(pos: SpatialVec3): number {
  const depth = Math.hypot(pos.z, pos.y * 0.65) + 1.2;
  const raw = Math.atan2(pos.x, depth) / (Math.PI * 0.5);
  return Math.max(-0.85, Math.min(0.85, raw));
}

/**
 * Gentle inverse-distance attenuation used for fallback panning and acoustic scaling.
 */
export function computeDistanceAttenuation(
  pos: SpatialVec3,
  refDistance = 2.2,
  rolloffFactor = 0.32,
): number {
  const d = Math.max(refDistance, computeSpatialDistance(pos));
  const atten = refDistance / (refDistance + rolloffFactor * (d - refDistance));
  return Math.max(0.42, Math.min(1, atten));
}

/**
 * Computes air-absorption lowpass cutoff (Hz) for distant sounds so far-field
 * events sound naturally softened without muting nearby detail.
 */
export function computeDistanceLowpassHz(pos: SpatialVec3, baseCutoffHz = 2200): number {
  const d = computeSpatialDistance(pos);
  if (d <= 2.2) return baseCutoffHz;
  const excess = Math.min(10, d - 2.2);
  return Math.max(720, Math.round(baseCutoffHz * Math.exp(-excess * 0.085)));
}

/**
 * Generates a forward-console spatial position around CH-04 Systems.
 */
export function sampleSystemsTransientPosition(randomFn: () => number = Math.random): SpatialVec3 {
  const base = CHANNEL_SPATIAL_PROFILES.systems.position;
  return {
    x: base.x + (randomFn() - 0.5) * 1.1,
    y: base.y + (randomFn() - 0.5) * 0.45,
    z: base.z + (randomFn() - 0.5) * 0.9,
  };
}

/**
 * Generates a forward-distant communications trajectory (stationary or slow subtle drift).
 */
export function sampleCommunicationsTrajectory(
  allowMovement: boolean,
  randomFn: () => number = Math.random,
): SpatialTrajectory {
  const start: SpatialVec3 = {
    x: (randomFn() - 0.5) * 4.4,
    y: 0.1 + randomFn() * 0.9,
    z: -3.8 - randomFn() * 3.8,
  };

  if (!allowMovement) {
    return { start, end: { ...start } };
  }

  const driftX = (randomFn() < 0.5 ? -1 : 1) * (0.7 + randomFn() * 0.9);
  const driftZ = (randomFn() - 0.5) * 1.0;
  return {
    start,
    end: {
      x: Math.max(-3.6, Math.min(3.6, start.x + driftX)),
      y: start.y,
      z: Math.min(-2.8, Math.max(-8.2, start.z + driftZ)),
    },
  };
}

/**
 * Generates a surrounding 360-degree structural position around the listener for CH-06 Hull.
 */
export function sampleHullSurroundingTrajectory(
  allowMovement: boolean,
  randomFn: () => number = Math.random,
): SpatialTrajectory {
  const angle = randomFn() * Math.PI * 2;
  const radius = 2.4 + randomFn() * 3.4;
  const start: SpatialVec3 = {
    x: Math.cos(angle) * radius,
    y: -1.3 + randomFn() * 3.6,
    z: Math.sin(angle) * radius,
  };

  if (!allowMovement) {
    return { start, end: { ...start } };
  }

  const shiftAngle = angle + (randomFn() - 0.5) * 0.35;
  const shiftRadius = Math.max(2.0, Math.min(6.2, radius + (randomFn() - 0.5) * 0.8));
  return {
    start,
    end: {
      x: Math.cos(shiftAngle) * shiftRadius,
      y: start.y + (randomFn() - 0.5) * 0.4,
      z: Math.sin(shiftAngle) * shiftRadius,
    },
  };
}
