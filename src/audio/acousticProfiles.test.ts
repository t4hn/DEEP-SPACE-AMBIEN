import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACOUSTIC_PROFILES,
  DEFAULT_ACOUSTIC_PROFILE_ID,
  applySpatialOffset,
  getAcousticProfile,
} from './acousticProfiles';
import { CHANNELS } from './mixerState';
import { CHANNEL_SPATIAL_PROFILES, computeSpatialDistance } from './spatialLayout';

test('defines all four acoustic profiles with BRIDGE as default', () => {
  assert.equal(DEFAULT_ACOUSTIC_PROFILE_ID, 'bridge');
  assert.deepEqual(
    ACOUSTIC_PROFILES.map((p) => p.id),
    ['engine-room', 'bridge', 'observation-deck', 'research-lab'],
  );
  assert.deepEqual(
    ACOUSTIC_PROFILES.map((p) => p.label),
    ['ENGINE ROOM', 'BRIDGE', 'OBSERVATION DECK', 'RESEARCH LAB'],
  );

  for (const profile of ACOUSTIC_PROFILES) {
    for (const ch of CHANNELS) {
      assert.ok(profile.channels[ch.id], `${profile.id} must configure channel ${ch.id}`);
    }
  }
});

test('ENGINE ROOM brings reactor & engines closer with subtle warmth while pushing systems & ventilation further', () => {
  const engineRoom = getAcousticProfile('engine-room');
  const bridge = getAcousticProfile('bridge');

  const erReactorDist = computeSpatialDistance(
    applySpatialOffset(
      CHANNEL_SPATIAL_PROFILES.reactor.position,
      engineRoom.channels.reactor.positionOffset,
    ),
  );
  const brReactorDist = computeSpatialDistance(
    applySpatialOffset(
      CHANNEL_SPATIAL_PROFILES.reactor.position,
      bridge.channels.reactor.positionOffset,
    ),
  );
  assert.ok(erReactorDist < brReactorDist, 'Reactor should be closer in Engine Room');

  const erEnginesDist = computeSpatialDistance(
    applySpatialOffset(
      CHANNEL_SPATIAL_PROFILES.engines.position,
      engineRoom.channels.engines.positionOffset,
    ),
  );
  const brEnginesDist = computeSpatialDistance(
    applySpatialOffset(
      CHANNEL_SPATIAL_PROFILES.engines.position,
      bridge.channels.engines.positionOffset,
    ),
  );
  assert.ok(erEnginesDist < brEnginesDist, 'Engines should be closer in Engine Room');

  assert.ok(engineRoom.channels.reactor.lowShelfGainDb > 0);
  assert.ok(engineRoom.channels.reactor.lowShelfGainDb <= 2.5);
  assert.ok(engineRoom.channels.systems.distanceTrim < bridge.channels.systems.distanceTrim);
  assert.ok(engineRoom.channels.ventilation.distanceTrim < bridge.channels.ventilation.distanceTrim);
  assert.ok(engineRoom.reflection.wetGain > bridge.reflection.wetGain);
});

test('OBSERVATION DECK increases mechanical distance and uses slightly longer, restrained reflections', () => {
  const obs = getAcousticProfile('observation-deck');
  const bridge = getAcousticProfile('bridge');

  const obsEnginesDist = computeSpatialDistance(
    applySpatialOffset(
      CHANNEL_SPATIAL_PROFILES.engines.position,
      obs.channels.engines.positionOffset,
    ),
  );
  const brEnginesDist = computeSpatialDistance(
    applySpatialOffset(
      CHANNEL_SPATIAL_PROFILES.engines.position,
      bridge.channels.engines.positionOffset,
    ),
  );
  assert.ok(obsEnginesDist > brEnginesDist);
  assert.ok(obs.channels.reactor.distanceTrim < bridge.channels.reactor.distanceTrim);
  assert.ok(obs.reflection.delayLeftSec > bridge.reflection.delayLeftSec);
  assert.ok(obs.reflection.delayRightSec > bridge.reflection.delayRightSec);
  assert.ok(obs.reflection.wetGain > bridge.reflection.wetGain);
  assert.ok(obs.reflection.wetGain <= 0.15, 'Reflections must stay restrained');
  assert.ok(obs.reflection.feedbackGain <= 0.3, 'Feedback must avoid excessive echo');
});

test('RESEARCH LAB highlights systems & comms while subduing mechanical ambience in a dry space', () => {
  const lab = getAcousticProfile('research-lab');
  const bridge = getAcousticProfile('bridge');

  assert.ok(lab.channels.systems.distanceTrim > bridge.channels.systems.distanceTrim);
  assert.ok(lab.channels.communications.distanceTrim > bridge.channels.communications.distanceTrim);
  assert.ok(lab.channels.reactor.distanceTrim < bridge.channels.reactor.distanceTrim);
  assert.ok(lab.channels.engines.distanceTrim < bridge.channels.engines.distanceTrim);
  assert.ok(lab.channels.ventilation.distanceTrim < bridge.channels.ventilation.distanceTrim);
  assert.ok(lab.reflection.wetGain < bridge.reflection.wetGain, 'Research Lab should be drier');
});
