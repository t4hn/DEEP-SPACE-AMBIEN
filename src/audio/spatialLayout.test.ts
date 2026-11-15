import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS } from './mixerState';
import {
  CHANNEL_SPATIAL_PROFILES,
  LISTENER_FORWARD,
  LISTENER_POSITION,
  LISTENER_UP,
  computeDistanceAttenuation,
  computeDistanceLowpassHz,
  computeFallbackStereoPan,
  computeSpatialDistance,
  sampleCommunicationsTrajectory,
  sampleHullSurroundingTrajectory,
  sampleSystemsTransientPosition,
} from './spatialLayout';

test('every mixer channel has a distinct, physically consistent spatial profile', () => {
  for (const ch of CHANNELS) {
    const profile = CHANNEL_SPATIAL_PROFILES[ch.id];
    assert.ok(profile, `Missing spatial profile for ${ch.id}`);
    assert.ok(profile.refDistance > 0);
    assert.ok(profile.maxDistance > profile.refDistance);
    assert.ok(profile.distanceGain > 0 && profile.distanceGain <= 1);
  }

  // Listener is centered at origin facing forward (-Z)
  assert.deepEqual(LISTENER_POSITION, { x: 0, y: 0, z: 0 });
  assert.deepEqual(LISTENER_FORWARD, { x: 0, y: 0, z: -1 });
  assert.deepEqual(LISTENER_UP, { x: 0, y: 1, z: 0 });

  // Reactor is centered and aft; Engines are further aft & offset; Ventilation is overhead
  assert.equal(CHANNEL_SPATIAL_PROFILES.reactor.position.x, 0);
  assert.ok(CHANNEL_SPATIAL_PROFILES.reactor.position.z > 0);
  assert.ok(
    CHANNEL_SPATIAL_PROFILES.engines.position.z >
      CHANNEL_SPATIAL_PROFILES.reactor.position.z,
  );
  assert.notEqual(
    CHANNEL_SPATIAL_PROFILES.engines.position.x,
    CHANNEL_SPATIAL_PROFILES.reactor.position.x,
  );
  assert.ok(CHANNEL_SPATIAL_PROFILES.ventilation.position.y > 1.5);

  // Systems & Communications are forward (-Z), with Communications more distant
  assert.ok(CHANNEL_SPATIAL_PROFILES.systems.position.z < 0);
  assert.ok(
    CHANNEL_SPATIAL_PROFILES.communications.position.z <
      CHANNEL_SPATIAL_PROFILES.systems.position.z,
  );
});

test('fallback stereo pan and distance attenuation behave monotonically and stay restrained', () => {
  assert.equal(computeFallbackStereoPan({ x: 0, y: 0, z: -3 }), 0);
  assert.ok(computeFallbackStereoPan({ x: 2, y: 0, z: -3 }) > 0);
  assert.ok(computeFallbackStereoPan({ x: -2, y: 0, z: -3 }) < 0);
  // Even extreme x stays clamped within [-0.85, 0.85]
  assert.ok(Math.abs(computeFallbackStereoPan({ x: 50, y: 0, z: 0 })) <= 0.85);

  const nearGain = computeDistanceAttenuation({ x: 0, y: 0, z: -2.0 });
  const farGain = computeDistanceAttenuation({ x: 0, y: 0, z: -8.0 });
  assert.ok(nearGain > farGain);
  assert.ok(farGain >= 0.42);

  const nearLp = computeDistanceLowpassHz({ x: 0, y: 0, z: -1.5 });
  const farLp = computeDistanceLowpassHz({ x: 0, y: 0, z: -8.5 });
  assert.ok(nearLp > farLp);
  assert.ok(farLp >= 720);
});

test('transient trajectory samplers respect ship spatial zones and stationary vs moving modes', () => {
  const sysPos = sampleSystemsTransientPosition(() => 0.5);
  assert.ok(sysPos.z < 0);

  const commsStatic = sampleCommunicationsTrajectory(false, () => 0.3);
  assert.deepEqual(commsStatic.start, commsStatic.end);
  assert.ok(commsStatic.start.z < -3);

  const commsMoving = sampleCommunicationsTrajectory(true, () => 0.7);
  assert.notEqual(commsMoving.start.x, commsMoving.end.x);
  assert.ok(commsMoving.end.z < 0);

  const hullStatic = sampleHullSurroundingTrajectory(false, () => 0.4);
  assert.deepEqual(hullStatic.start, hullStatic.end);
  assert.ok(computeSpatialDistance(hullStatic.start) >= 2.0);

  const hullMoving = sampleHullSurroundingTrajectory(true, () => 0.8);
  assert.ok(computeSpatialDistance(hullMoving.end) >= 1.8);
});
