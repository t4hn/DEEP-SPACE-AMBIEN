import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomSoundscape } from './customSoundscapes';
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

test('PLAY_ALL activates environment and enables all six channels simultaneously', () => {
  const initial = createInitialMixerState();
  const next = mixerReducer(initial, { type: 'PLAY_ALL' });
  assert.equal(CHANNELS.length, 6);
  assert.equal(next.isActive, true);
  assert.equal(countEnabledChannels(next), 6);
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
  assert.equal(resetActive.channels.hull.volume, 0.25);
  assert.equal(countEnabledChannels(resetActive), 6);
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
    {
      reactor: 0.65,
      engines: 0.85,
      ventilation: 0.3,
      systems: 0.15,
      communications: 0.1,
      hull: 0.25,
    },
  );
  assert.equal(countEnabledChannels(state), 6);

  // Silent Watch (Engines 0% -> disabled, Hull 15% -> enabled)
  state = mixerReducer(state, { type: 'SELECT_PRESET', presetId: 'silent-watch' });
  assert.equal(state.isActive, true);
  assert.equal(state.activePresetId, 'silent-watch');
  assert.equal(state.masterVolume, 0.55);
  assert.equal(state.channels.engines.volume, 0);
  assert.equal(state.channels.engines.enabled, false);
  assert.equal(effectiveChannelGain(state, 'engines'), 0);
  assert.equal(state.channels.hull.volume, 0.15);
  assert.equal(state.channels.hull.enabled, true);
  assert.equal(countEnabledChannels(state), 5);

  // Research Station
  state = mixerReducer(state, { type: 'SELECT_PRESET', presetId: 'research-station' });
  assert.equal(state.isActive, true);
  assert.equal(state.activePresetId, 'research-station');
  assert.equal(state.channels.engines.enabled, true);
  assert.equal(state.channels.engines.volume, 0.1);
  assert.equal(state.channels.ventilation.volume, 0.65);
  assert.equal(state.channels.systems.volume, 0.45);
  assert.equal(state.channels.communications.volume, 0.25);
  assert.equal(state.channels.hull.volume, 0.2);

  // Engineering Deck
  state = mixerReducer(state, { type: 'SELECT_PRESET', presetId: 'engineering-deck' });
  assert.equal(state.isActive, true);
  assert.equal(state.activePresetId, 'engineering-deck');
  assert.equal(state.channels.reactor.volume, 0.9);
  assert.equal(state.channels.engines.volume, 0.55);
  assert.equal(state.channels.ventilation.volume, 0.85);
  assert.equal(state.channels.systems.volume, 0.35);
  assert.equal(state.channels.communications.volume, 0.05);
  assert.equal(state.channels.hull.volume, 0.35);
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

test('ambientEventsEnabled defaults to false, toggles independently, and resets to false', () => {
  const initial = createInitialMixerState();
  assert.equal(initial.ambientEventsEnabled, false);

  // Toggling Ambient Events ON in standby does not enable channels or activate audio
  const toggledOn = mixerReducer(initial, { type: 'TOGGLE_AMBIENT_EVENTS' });
  assert.equal(toggledOn.ambientEventsEnabled, true);
  assert.equal(toggledOn.isActive, false);
  assert.equal(countEnabledChannels(toggledOn), 0);

  // Selecting preset and Play/Stop All do not mutate ambientEventsEnabled
  const withPreset = mixerReducer(toggledOn, {
    type: 'SELECT_PRESET',
    presetId: 'research-station',
  });
  assert.equal(withPreset.ambientEventsEnabled, true);
  assert.equal(withPreset.activePresetId, 'research-station');

  const stopped = mixerReducer(withPreset, { type: 'STOP_ALL' });
  assert.equal(stopped.ambientEventsEnabled, true);
  assert.equal(stopped.isActive, false);

  // Toggling Ambient Events OFF does not disturb playing channels or selected preset
  const playing = mixerReducer(stopped, {
    type: 'SELECT_PRESET',
    presetId: 'deep-transit',
  });
  const toggledOff = mixerReducer(playing, { type: 'TOGGLE_AMBIENT_EVENTS' });
  assert.equal(toggledOff.ambientEventsEnabled, false);
  assert.equal(toggledOff.isActive, true);
  assert.equal(toggledOff.activePresetId, 'deep-transit');
  assert.equal(countEnabledChannels(toggledOff), 6);

  // Reset restores ambientEventsEnabled back to false
  const reEnabled = mixerReducer(toggledOff, { type: 'TOGGLE_AMBIENT_EVENTS' });
  const afterReset = mixerReducer(reEnabled, { type: 'RESET' });
  assert.equal(afterReset.ambientEventsEnabled, false);
});

test('CH-06 hull channel enables/disables independently and adjusts volume cleanly', () => {
  let state = createInitialMixerState();
  assert.equal(state.channels.hull.volume, 0.25);
  assert.equal(state.channels.hull.enabled, false);

  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'hull' });
  assert.equal(state.isActive, true);
  assert.equal(state.channels.hull.enabled, true);
  assert.equal(countEnabledChannels(state), 1);
  assert.ok(effectiveChannelGain(state, 'hull') > 0);

  state = mixerReducer(state, {
    type: 'SET_CHANNEL_VOLUME',
    channelId: 'hull',
    volume: 0.42,
  });
  assert.equal(state.channels.hull.volume, 0.42);
  assert.ok(effectiveChannelGain(state, 'hull') > sliderToGain(0.25));

  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'hull' });
  assert.equal(state.isActive, false);
  assert.equal(state.channels.hull.enabled, false);
  assert.equal(effectiveChannelGain(state, 'hull'), 0);
});

test('acousticProfileId defaults to bridge and switches without altering channels, master volume, or presets', () => {
  const initial = createInitialMixerState();
  assert.equal(initial.acousticProfileId, 'bridge');

  // Switching before audio starts leaves standby and all volumes intact
  const preStart = mixerReducer(initial, {
    type: 'SELECT_ACOUSTIC_PROFILE',
    profileId: 'engine-room',
  });
  assert.equal(preStart.acousticProfileId, 'engine-room');
  assert.equal(preStart.isActive, false);
  assert.equal(preStart.masterVolume, initial.masterVolume);
  assert.deepEqual(preStart.channels, initial.channels);

  // Switching while playing with preset + custom master volume + ambient events preserves everything
  let playing = mixerReducer(preStart, { type: 'SET_MASTER_VOLUME', volume: 0.62 });
  playing = mixerReducer(playing, { type: 'SELECT_PRESET', presetId: 'deep-transit' });
  playing = mixerReducer(playing, { type: 'TOGGLE_AMBIENT_EVENTS' });

  const switched = mixerReducer(playing, {
    type: 'SELECT_ACOUSTIC_PROFILE',
    profileId: 'observation-deck',
  });
  assert.equal(switched.acousticProfileId, 'observation-deck');
  assert.equal(switched.isActive, true);
  assert.equal(switched.activePresetId, 'deep-transit');
  assert.equal(switched.masterVolume, 0.62);
  assert.equal(switched.ambientEventsEnabled, true);
  assert.deepEqual(switched.channels, playing.channels);

  const lab = mixerReducer(switched, {
    type: 'SELECT_ACOUSTIC_PROFILE',
    profileId: 'research-lab',
  });
  assert.equal(lab.acousticProfileId, 'research-lab');
  assert.deepEqual(lab.channels, playing.channels);
});

test('LOAD_CUSTOM_SOUNDSCAPE restores all settings atomically without starting playback from Standby and preserves active playback', () => {
  // Build a saved configuration that had active channels, custom volumes, master, profile & ambient events
  let source = createInitialMixerState();
  source = mixerReducer(source, { type: 'SELECT_PRESET', presetId: 'silent-watch' });
  source = mixerReducer(source, { type: 'SET_MASTER_VOLUME', volume: 0.44 });
  source = mixerReducer(source, {
    type: 'SELECT_ACOUSTIC_PROFILE',
    profileId: 'engine-room',
  });
  source = mixerReducer(source, { type: 'TOGGLE_AMBIENT_EVENTS' });
  source = mixerReducer(source, {
    type: 'SET_CHANNEL_VOLUME',
    channelId: 'hull',
    volume: 0.77,
  });

  const saved = createCustomSoundscape([], source, {
    name: 'Engine Hull Focus',
    description: 'Night watch in engineering',
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  const customSoundscape = saved.value.soundscape;

  // 1. Load while in Standby: restores channels/volumes/master/profile/events WITHOUT starting playback
  const standby = createInitialMixerState();
  const loadedInStandby = mixerReducer(standby, {
    type: 'LOAD_CUSTOM_SOUNDSCAPE',
    soundscape: customSoundscape,
  });
  assert.equal(loadedInStandby.isActive, false);
  assert.equal(loadedInStandby.activePresetId, 'custom');
  assert.equal(loadedInStandby.activeCustomSoundscapeId, customSoundscape.id);
  assert.equal(loadedInStandby.masterVolume, 0.44);
  assert.equal(loadedInStandby.acousticProfileId, 'engine-room');
  assert.equal(loadedInStandby.ambientEventsEnabled, true);
  assert.equal(loadedInStandby.channels.hull.volume, 0.77);
  assert.equal(loadedInStandby.channels.hull.enabled, true);
  assert.equal(loadedInStandby.channels.engines.enabled, false);
  assert.equal(effectiveChannelGain(loadedInStandby, 'hull'), 0);

  // Editing channel clears activeCustomSoundscapeId while keeping CUSTOM state
  const tweaked = mixerReducer(loadedInStandby, {
    type: 'SET_CHANNEL_VOLUME',
    channelId: 'reactor',
    volume: 0.5,
  });
  assert.equal(tweaked.activePresetId, 'custom');
  assert.equal(tweaked.activeCustomSoundscapeId, null);

  // 2. Load while audio is already playing: preserves active playback and updates settings atomically
  const playing = mixerReducer(createInitialMixerState(), { type: 'PLAY_ALL' });
  const loadedWhilePlaying = mixerReducer(playing, {
    type: 'LOAD_CUSTOM_SOUNDSCAPE',
    soundscape: customSoundscape,
  });
  assert.equal(loadedWhilePlaying.isActive, true);
  assert.equal(loadedWhilePlaying.activeCustomSoundscapeId, customSoundscape.id);
  assert.equal(loadedWhilePlaying.masterVolume, 0.44);
  assert.equal(loadedWhilePlaying.acousticProfileId, 'engine-room');
  assert.equal(loadedWhilePlaying.ambientEventsEnabled, true);
  assert.equal(loadedWhilePlaying.channels.engines.enabled, false);
  assert.equal(effectiveChannelGain(loadedWhilePlaying, 'engines'), 0);
  assert.ok(effectiveChannelGain(loadedWhilePlaying, 'hull') > 0);
});



