import test from 'node:test';
import assert from 'node:assert/strict';
import { getAmbientEventDescriptor } from './ambientEvents';
import { createInitialMixerState, mixerReducer } from './mixerState';
import {
  VESSEL_IDENTIFICATION,
  deriveAmbientMonitoring,
  deriveOperationalStatus,
  deriveShipSystems,
} from './shipTelemetry';

test('vessel identification matches spacecraft specification', () => {
  assert.equal(VESSEL_IDENTIFICATION.designation, 'DSV-01');
  assert.equal(VESSEL_IDENTIFICATION.name, 'DEEP SPACE');
  assert.equal(VESSEL_IDENTIFICATION.classification, 'Autonomous Research Vessel');
});

test('operational status reflects STANDBY, OPERATIONAL, and FULL SYSTEMS accurately', () => {
  const standby = createInitialMixerState();
  assert.equal(deriveOperationalStatus(standby), 'STANDBY');

  // Single channel -> OPERATIONAL
  const oneChannel = mixerReducer(standby, { type: 'TOGGLE_CHANNEL', channelId: 'reactor' });
  assert.equal(deriveOperationalStatus(oneChannel), 'OPERATIONAL');

  // Multiple channels (4 of 5 in Silent Watch) -> OPERATIONAL
  const silentWatch = mixerReducer(standby, {
    type: 'SELECT_PRESET',
    presetId: 'silent-watch',
  });
  assert.equal(deriveOperationalStatus(silentWatch), 'OPERATIONAL');

  // All five channels -> FULL SYSTEMS
  const fullSystems = mixerReducer(standby, { type: 'PLAY_ALL' });
  assert.equal(deriveOperationalStatus(fullSystems), 'FULL SYSTEMS');

  // Stop All returns to STANDBY
  const stopped = mixerReducer(fullSystems, { type: 'STOP_ALL' });
  assert.equal(deriveOperationalStatus(stopped), 'STANDBY');
});

test('ship systems map directly to the 6 mixer channels and reflect enabled state', () => {
  let state = createInitialMixerState();
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'reactor' });
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'systems' });
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'hull' });

  const systems = deriveShipSystems(state);
  assert.deepEqual(
    systems.map((s) => ({ name: s.systemName, code: s.code, status: s.statusLabel })),
    [
      { name: 'REACTOR', code: 'CH-01', status: 'ACTIVE' },
      { name: 'PROPULSION', code: 'CH-02', status: 'STANDBY' },
      { name: 'LIFE SUPPORT', code: 'CH-03', status: 'STANDBY' },
      { name: 'COMPUTER', code: 'CH-04', status: 'ACTIVE' },
      { name: 'COMMUNICATIONS', code: 'CH-05', status: 'STANDBY' },
      { name: 'HULL', code: 'CH-06', status: 'ACTIVE' },
    ],
  );
});

test('ambient event monitoring derives OFFLINE, MONITORING, and latest event readout', () => {
  assert.deepEqual(deriveAmbientMonitoring(false, null), {
    enabled: false,
    toggleLabel: 'DISABLED',
    readout: 'OFFLINE',
    hasEvent: false,
  });

  // Even if a stale descriptor is passed when disabled, readout remains OFFLINE
  const beacon = getAmbientEventDescriptor('navigation-beacon');
  assert.deepEqual(deriveAmbientMonitoring(false, beacon), {
    enabled: false,
    toggleLabel: 'DISABLED',
    readout: 'OFFLINE',
    hasEvent: false,
  });

  assert.deepEqual(deriveAmbientMonitoring(true, null), {
    enabled: true,
    toggleLabel: 'ENABLED',
    readout: 'MONITORING',
    hasEvent: false,
  });

  assert.deepEqual(deriveAmbientMonitoring(true, beacon), {
    enabled: true,
    toggleLabel: 'ENABLED',
    readout: 'Navigation beacon acquired',
    hasEvent: true,
  });
});
