import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMBIENT_EVENTS,
  AMBIENT_EVENT_INITIAL_MAX_MS,
  AMBIENT_EVENT_INITIAL_MIN_MS,
  AMBIENT_EVENT_SILENCE_MAX_MS,
  AMBIENT_EVENT_SILENCE_MIN_MS,
  AMBIENT_EVENT_TYPICAL_MAX_MS,
  AMBIENT_EVENT_TYPICAL_MIN_MS,
  type AmbientEventType,
  computeAmbientEventDelayMs,
  getEligibleAmbientEvents,
  selectAmbientEvent,
} from './ambientEvents';
import { createInitialMixerState, mixerReducer } from './mixerState';

test('ambient event catalogue defines the five expected shipboard event types', () => {
  assert.deepEqual(
    AMBIENT_EVENTS.map((e) => e.type),
    [
      'reactor-fluctuation',
      'navigation-beacon',
      'communications-interference',
      'system-diagnostic',
      'sensor-anomaly',
    ],
  );
});

test('no ambient events are eligible when ambientEventsEnabled is false or environment is inactive', () => {
  const initial = createInitialMixerState();
  assert.deepEqual(getEligibleAmbientEvents(initial, 100_000, {}), []);

  // Playing all channels with ambient events still OFF produces zero eligible events
  const playingOff = mixerReducer(initial, { type: 'PLAY_ALL' });
  assert.equal(playingOff.ambientEventsEnabled, false);
  assert.deepEqual(getEligibleAmbientEvents(playingOff, 100_000, {}), []);

  // Ambient events ON in standby (no channels active) produces zero eligible events
  const standbyOn = mixerReducer(initial, { type: 'TOGGLE_AMBIENT_EVENTS' });
  assert.equal(standbyOn.ambientEventsEnabled, true);
  assert.equal(standbyOn.isActive, false);
  assert.deepEqual(getEligibleAmbientEvents(standbyOn, 100_000, {}), []);
});

test('reactor-only listening permits ONLY reactor-fluctuation when Ambient Events are ON', () => {
  let state = createInitialMixerState();
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'reactor' });
  state = mixerReducer(state, { type: 'TOGGLE_AMBIENT_EVENTS' });

  const eligible = getEligibleAmbientEvents(state, 500_000, {});
  assert.deepEqual(
    eligible.map((e) => e.type),
    ['reactor-fluctuation'],
  );

  const selection = selectAmbientEvent(eligible, state, () => 0.5);
  assert.ok(selection);
  assert.equal(selection.event.type, 'reactor-fluctuation');
  assert.equal(selection.targetChannel, 'reactor');
});

test('channels without supported events (engines + ventilation only) never produce events', () => {
  let state = createInitialMixerState();
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'engines' });
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'ventilation' });
  state = mixerReducer(state, { type: 'TOGGLE_AMBIENT_EVENTS' });

  assert.deepEqual(getEligibleAmbientEvents(state, 500_000, {}), []);
});

test('communications-only permits beacon, interference, and sensor-anomaly routed strictly to communications', () => {
  let state = createInitialMixerState();
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'communications' });
  state = mixerReducer(state, { type: 'TOGGLE_AMBIENT_EVENTS' });

  const eligible = getEligibleAmbientEvents(state, 500_000, {});
  assert.deepEqual(
    eligible.map((e) => e.type),
    ['navigation-beacon', 'communications-interference', 'sensor-anomaly'],
  );

  // Even selecting sensor-anomaly routes strictly to communications when systems is disabled
  const anomalyOnly = eligible.filter((e) => e.type === 'sensor-anomaly');
  const selection = selectAmbientEvent(anomalyOnly, state, () => 0.1);
  assert.ok(selection);
  assert.equal(selection.targetChannel, 'communications');
});

test('systems-only permits system-diagnostic and sensor-anomaly routed strictly to systems', () => {
  let state = createInitialMixerState();
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'systems' });
  state = mixerReducer(state, { type: 'TOGGLE_AMBIENT_EVENTS' });

  const eligible = getEligibleAmbientEvents(state, 500_000, {});
  assert.deepEqual(
    eligible.map((e) => e.type),
    ['system-diagnostic', 'sensor-anomaly'],
  );

  const anomalyOnly = eligible.filter((e) => e.type === 'sensor-anomaly');
  const selection = selectAmbientEvent(anomalyOnly, state, () => 0.9);
  assert.ok(selection);
  assert.equal(selection.targetChannel, 'systems');
});

test('per-event cooldowns prevent repetition and keep rare sensor-anomaly spaced 2-4 minutes', () => {
  let state = mixerReducer(createInitialMixerState(), { type: 'PLAY_ALL' });
  state = mixerReducer(state, { type: 'TOGGLE_AMBIENT_EVENTS' });

  const now = 300_000;
  const lastTriggered: Partial<Record<AmbientEventType, number>> = {
    'reactor-fluctuation': now - 20_000, // within 75s cooldown
    'sensor-anomaly': now - 130_000, // within 180s rare cooldown
  };

  const eligible = getEligibleAmbientEvents(state, now, lastTriggered);
  assert.deepEqual(
    eligible.map((e) => e.type),
    ['navigation-beacon', 'communications-interference', 'system-diagnostic'],
  );

  // After 180s, sensor-anomaly becomes eligible again
  const laterEligible = getEligibleAmbientEvents(state, now + 50_000, lastTriggered);
  assert.ok(laterEligible.some((e) => e.type === 'sensor-anomaly'));
});

test('conservative scheduler computes initial delay, 30-90s typical intervals, and rare silence gaps', () => {
  const initialMin = computeAmbientEventDelayMs({ isInitial: true }, () => 0);
  const initialMax = computeAmbientEventDelayMs({ isInitial: true }, () => 0.999999);
  assert.equal(initialMin, AMBIENT_EVENT_INITIAL_MIN_MS);
  assert.equal(initialMax, AMBIENT_EVENT_INITIAL_MAX_MS);

  const silenceMin = computeAmbientEventDelayMs({ isInitial: false }, () => 0);
  const silenceMax = computeAmbientEventDelayMs({ isInitial: false }, () => 0.179);
  assert.ok(silenceMin >= AMBIENT_EVENT_SILENCE_MIN_MS);
  assert.ok(silenceMax <= AMBIENT_EVENT_SILENCE_MAX_MS);

  const typicalMin = computeAmbientEventDelayMs({ isInitial: false }, () => 0.18);
  const typicalMax = computeAmbientEventDelayMs({ isInitial: false }, () => 0.999999);
  assert.ok(typicalMin >= AMBIENT_EVENT_TYPICAL_MIN_MS);
  assert.ok(typicalMax <= AMBIENT_EVENT_TYPICAL_MAX_MS);
});
