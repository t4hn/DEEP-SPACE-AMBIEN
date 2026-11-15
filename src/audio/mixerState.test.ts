import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  DEFAULT_MASTER_VOLUME,
  ENVIRONMENT_PRESETS,
  clampUnit,
  countEnabledChannels,
  createInitialMixerState,
  effectiveChannelGain,
  formatPercent,
  mixerReducer,
  sliderToGain,
} from './mixerState';

test('initial mixer state starts in standby with all channels off and default levels', () => {
  const state = createInitialMixerState();
  assert.equal(state.isActive, false);
  assert.equal(state.activePresetId, null);
  assert.equal(state.masterVolume, DEFAULT_MASTER_VOLUME);
  assert.equal(countEnabledChannels(state), 0);
  for (const ch of CHANNELS) {
    assert.equal(state.channels[ch.id].enabled, false);
    assert.equal(state.channels[ch.id].volume, ch.defaultVolume);
    assert.equal(effectiveChannelGain(state, ch.id), 0);
  }
});

test('PLAY_ALL activates environment and enables all five channels simultaneously', () => {
  const initial = createInitialMixerState();
  const next = mixerReducer(initial, { type: 'PLAY_ALL' });
  assert.equal(next.isActive, true);
  assert.equal(countEnabledChannels(next), 5);
  for (const ch of CHANNELS) {
    assert.equal(next.channels[ch.id].enabled, true);
    assert.ok(effectiveChannelGain(next, ch.id) > 0);
  }
});

test('STOP_ALL returns environment to standby and turns all channels off', () => {
  const playing = mixerReducer(createInitialMixerState(), { type: 'PLAY_ALL' });
  const stopped = mixerReducer(playing, { type: 'STOP_ALL' });
  assert.equal(stopped.isActive, false);
  assert.equal(stopped.activePresetId, null);
  assert.equal(countEnabledChannels(stopped), 0);
  for (const ch of CHANNELS) {
    assert.equal(effectiveChannelGain(stopped, ch.id), 0);
  }
});

test('TOGGLE_CHANNEL activates audio when turning a single channel on from standby', () => {
  const initial = createInitialMixerState();
  const withReactor = mixerReducer(initial, {
    type: 'TOGGLE_CHANNEL',
    channelId: 'reactor',
  });
  assert.equal(withReactor.isActive, true);
  assert.equal(withReactor.channels.reactor.enabled, true);
  assert.equal(countEnabledChannels(withReactor), 1);
  assert.ok(effectiveChannelGain(withReactor, 'reactor') > 0);
  assert.equal(effectiveChannelGain(withReactor, 'engines'), 0);

  // Toggling last active channel off returns to standby
  const backOff = mixerReducer(withReactor, {
    type: 'TOGGLE_CHANNEL',
    channelId: 'reactor',
  });
  assert.equal(backOff.isActive, false);
  assert.equal(backOff.channels.reactor.enabled, false);
  assert.equal(countEnabledChannels(backOff), 0);
});

test('SET_CHANNEL_VOLUME and SET_MASTER_VOLUME clamp to [0, 1]', () => {
  const initial = createInitialMixerState();
  const s1 = mixerReducer(initial, {
    type: 'SET_CHANNEL_VOLUME',
    channelId: 'systems',
    volume: 1.5,
  });
  assert.equal(s1.channels.systems.volume, 1);

  const s2 = mixerReducer(s1, {
    type: 'SET_CHANNEL_VOLUME',
    channelId: 'systems',
    volume: -0.4,
  });
  assert.equal(s2.channels.systems.volume, 0);

  const s3 = mixerReducer(s2, {
    type: 'SET_MASTER_VOLUME',
    volume: 0.42,
  });
  assert.equal(s3.masterVolume, 0.42);
});

test('RESET restores default volumes and clears preset while preserving active vs standby mode', () => {
  // In standby
  let s = mixerReducer(createInitialMixerState(), {
    type: 'SET_MASTER_VOLUME',
    volume: 0.15,
  });
  s = mixerReducer(s, {
    type: 'SET_CHANNEL_VOLUME',
    channelId: 'communications',
    volume: 0.99,
  });
  const resetStandby = mixerReducer(s, { type: 'RESET' });
  assert.equal(resetStandby.isActive, false);
  assert.equal(resetStandby.activePresetId, null);
  assert.equal(resetStandby.masterVolume, DEFAULT_MASTER_VOLUME);
  assert.equal(resetStandby.channels.communications.volume, 0.3);
  assert.equal(countEnabledChannels(resetStandby), 0);

  // While active with a preset selected
  let active = mixerReducer(s, { type: 'SELECT_PRESET', presetId: 'engineering-deck' });
  assert.equal(active.activePresetId, 'engineering-deck');
  active = mixerReducer(active, {
    type: 'SET_CHANNEL_VOLUME',
    channelId: 'reactor',
    volume: 0.1,
  });
  assert.equal(active.activePresetId, 'custom');
  const resetActive = mixerReducer(active, { type: 'RESET' });
  assert.equal(resetActive.isActive, true);
  assert.equal(resetActive.activePresetId, null);
  assert.equal(resetActive.masterVolume, DEFAULT_MASTER_VOLUME);
  assert.equal(resetActive.channels.reactor.volume, 0.75);
  assert.equal(resetActive.channels.communications.volume, 0.3);
  assert.equal(countEnabledChannels(resetActive), 5);
});

test('all four environment presets apply exact volumes, disable 0% channels, and keep master independent', () => {
  assert.equal(ENVIRONMENT_PRESETS.length, 4);

  let state = mixerReducer(createInitialMixerState(), {
    type: 'SET_MASTER_VOLUME',
    volume: 0.55,
  });

  // Deep Transit
  state = mixerReducer(state, { type: 'SELECT_PRESET', presetId: 'deep-transit' });
  assert.equal(state.isActive, true);
  assert.equal(state.activePresetId, 'deep-transit');
  assert.equal(state.masterVolume, 0.55);
  assert.deepEqual(
    Object.fromEntries(CHANNELS.map((c) => [c.id, state.channels[c.id].volume])),
    { reactor: 0.65, engines: 0.85, ventilation: 0.3, systems: 0.15, communications: 0.1 },
  );
  assert.equal(countEnabledChannels(state), 5);

  // Silent Watch (Engines 0% -> disabled)
  state = mixerReducer(state, { type: 'SELECT_PRESET', presetId: 'silent-watch' });
  assert.equal(state.isActive, true);
  assert.equal(state.activePresetId, 'silent-watch');
  assert.equal(state.masterVolume, 0.55);
  assert.equal(state.channels.engines.volume, 0);
  assert.equal(state.channels.engines.enabled, false);
  assert.equal(effectiveChannelGain(state, 'engines'), 0);
  assert.equal(countEnabledChannels(state), 4);

  // Research Station
  state = mixerReducer(state, { type: 'SELECT_PRESET', presetId: 'research-station' });
  assert.equal(state.isActive, true);
  assert.equal(state.activePresetId, 'research-station');
  assert.equal(state.channels.engines.enabled, true);
  assert.equal(state.channels.engines.volume, 0.1);
  assert.equal(state.channels.ventilation.volume, 0.65);
  assert.equal(state.channels.systems.volume, 0.45);
  assert.equal(state.channels.communications.volume, 0.25);

  // Engineering Deck
  state = mixerReducer(state, { type: 'SELECT_PRESET', presetId: 'engineering-deck' });
  assert.equal(state.isActive, true);
  assert.equal(state.activePresetId, 'engineering-deck');
  assert.equal(state.channels.reactor.volume, 0.9);
  assert.equal(state.channels.engines.volume, 0.55);
  assert.equal(state.channels.ventilation.volume, 0.85);
  assert.equal(state.channels.systems.volume, 0.35);
  assert.equal(state.channels.communications.volume, 0.05);
  assert.equal(state.masterVolume, 0.55);
});

test('manual channel edits switch preset indicator to custom while master volume keeps preset', () => {
  let state = mixerReducer(createInitialMixerState(), {
    type: 'SELECT_PRESET',
    presetId: 'research-station',
  });
  assert.equal(state.activePresetId, 'research-station');

  // Changing master volume does NOT invalidate selected preset
  state = mixerReducer(state, { type: 'SET_MASTER_VOLUME', volume: 0.9 });
  assert.equal(state.activePresetId, 'research-station');

  // Changing channel volume switches to custom
  state = mixerReducer(state, {
    type: 'SET_CHANNEL_VOLUME',
    channelId: 'ventilation',
    volume: 0.5,
  });
  assert.equal(state.activePresetId, 'custom');

  // Re-selecting a preset restores preset name, then toggling channel switches to custom
  state = mixerReducer(state, { type: 'SELECT_PRESET', presetId: 'deep-transit' });
  assert.equal(state.activePresetId, 'deep-transit');
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'systems' });
  assert.equal(state.activePresetId, 'custom');
});

test('utility math helpers behave monotonically and safely', () => {
  assert.equal(clampUnit(NaN), 0);
  assert.equal(clampUnit(-1), 0);
  assert.equal(clampUnit(2), 1);
  assert.equal(sliderToGain(0), 0);
  assert.equal(sliderToGain(1), 1);
  assert.ok(sliderToGain(0.5) < 0.5);
  assert.ok(sliderToGain(0.8) > sliderToGain(0.4));
  assert.equal(formatPercent(0.754), '75%');
});
