import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILT_IN_PRESET_IDS,
  CUSTOM_SOUNDSCAPES_SCHEMA_VERSION,
  CUSTOM_SOUNDSCAPES_STORAGE_KEY,
  type StorageLike,
  createCustomSoundscape,
  deleteCustomSoundscape,
  loadCustomSoundscapes,
  parseCustomSoundscapesPayload,
  persistCustomSoundscapes,
  updateCustomSoundscapeMetadata,
  validateCustomSoundscape,
  validateSoundscapeConfig,
} from './customSoundscapes';
import { createInitialMixerState, mixerReducer } from './mixerState';

function createMemoryStorage(): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

test('saving a valid custom soundscape captures mixer settings without mutating playback or sleep state', () => {
  let state = createInitialMixerState();
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'reactor' });
  state = mixerReducer(state, { type: 'SET_CHANNEL_VOLUME', channelId: 'reactor', volume: 0.48 });
  state = mixerReducer(state, { type: 'SET_CHANNEL_VOLUME', channelId: 'hull', volume: 0.82 });
  state = mixerReducer(state, { type: 'SET_MASTER_VOLUME', volume: 0.64 });
  state = mixerReducer(state, {
    type: 'SELECT_ACOUSTIC_PROFILE',
    profileId: 'observation-deck',
  });
  state = mixerReducer(state, { type: 'TOGGLE_AMBIENT_EVENTS' });

  const snapshotBefore = structuredClone(state);

  // Empty name is rejected cleanly
  const emptyRes = createCustomSoundscape([], state, { name: '   ' });
  assert.equal(emptyRes.ok, false);

  const savedRes = createCustomSoundscape(
    [],
    state,
    { name: '  Orbital Night Watch  ', description: '  Calm core + spatial telemetry  ' },
    1_700_000_000_000,
  );
  assert.equal(savedRes.ok, true);
  if (!savedRes.ok) return;

  const { soundscape, soundscapes } = savedRes.value;
  assert.equal(soundscapes.length, 1);
  assert.equal(soundscape.name, 'Orbital Night Watch');
  assert.equal(soundscape.description, 'Calm core + spatial telemetry');
  assert.equal(BUILT_IN_PRESET_IDS.has(soundscape.id), false);

  // Captures 6 channels, masterVolume, acousticProfileId, ambientEventsEnabled
  assert.equal(soundscape.config.channels.reactor.enabled, true);
  assert.equal(soundscape.config.channels.reactor.volume, 0.48);
  assert.equal(soundscape.config.channels.hull.enabled, false);
  assert.equal(soundscape.config.channels.hull.volume, 0.82);
  assert.equal(soundscape.config.masterVolume, 0.64);
  assert.equal(soundscape.config.acousticProfileId, 'observation-deck');
  assert.equal(soundscape.config.ambientEventsEnabled, true);

  // Does not save playback or sleep timer state and does not mutate current mixer state
  assert.equal('isActive' in soundscape.config, false);
  assert.deepEqual(state, snapshotBefore);
});

test('renaming, editing description, and deleting custom soundscapes updates list and protects built-in presets', () => {
  const state = mixerReducer(createInitialMixerState(), { type: 'PLAY_ALL' });
  const created = createCustomSoundscape([], state, {
    name: 'Transit Mix',
    description: 'Initial note',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const id = created.value.soundscape.id;

  // Rename & edit description
  const renamed = updateCustomSoundscapeMetadata(
    created.value.soundscapes,
    id,
    { name: 'Deep Transit Alt', description: 'Updated lab description' },
    1_700_000_005_000,
  );
  assert.equal(renamed.ok, true);
  if (!renamed.ok) return;
  assert.equal(renamed.value[0].name, 'Deep Transit Alt');
  assert.equal(renamed.value[0].description, 'Updated lab description');

  // Blank name rejected during edit
  const blankEdit = updateCustomSoundscapeMetadata(renamed.value, id, {
    name: '   ',
    description: 'Nope',
  });
  assert.equal(blankEdit.ok, false);

  // Built-in preset IDs cannot be modified or deleted
  for (const builtInId of ['deep-transit', 'research-station', 'silent-watch', 'engineering-deck']) {
    const modBuiltIn = updateCustomSoundscapeMetadata(renamed.value, builtInId, {
      name: 'Hacked',
      description: 'Should fail',
    });
    assert.equal(modBuiltIn.ok, false);

    const delBuiltIn = deleteCustomSoundscape(renamed.value, builtInId);
    assert.equal(delBuiltIn.ok, false);
  }

  // Delete saved custom soundscape
  const deleted = deleteCustomSoundscape(renamed.value, id);
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.equal(deleted.value.length, 0);
});

test('custom soundscapes persist across simulated reloads with versioned schema in localStorage', () => {
  const storage = createMemoryStorage();
  let state = createInitialMixerState();
  state = mixerReducer(state, { type: 'SELECT_ACOUSTIC_PROFILE', profileId: 'research-lab' });
  state = mixerReducer(state, { type: 'SET_MASTER_VOLUME', volume: 0.72 });
  state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'systems' });

  const created = createCustomSoundscape([], state, {
    name: 'Lab Focus',
    description: 'Systems pulse & dry acoustics',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const ok = persistCustomSoundscapes(created.value.soundscapes, storage);
  assert.equal(ok, true);

  const rawStored = storage.getItem(CUSTOM_SOUNDSCAPES_STORAGE_KEY);
  assert.ok(rawStored);
  const parsed = JSON.parse(rawStored);
  assert.equal(parsed.version, CUSTOM_SOUNDSCAPES_SCHEMA_VERSION);
  assert.equal(parsed.soundscapes.length, 1);

  // Fresh reload reads exact saved configuration
  const reloaded = loadCustomSoundscapes(storage);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].name, 'Lab Focus');
  assert.equal(reloaded[0].config.masterVolume, 0.72);
  assert.equal(reloaded[0].config.acousticProfileId, 'research-lab');
  assert.equal(reloaded[0].config.channels.systems.enabled, true);
});

test('malformed, outdated, missing, or invalid localStorage values are handled safely without crashing', () => {
  const storage = createMemoryStorage();

  // 1. Corrupt JSON string
  storage.setItem(CUSTOM_SOUNDSCAPES_STORAGE_KEY, '{not valid json!!!');
  assert.deepEqual(loadCustomSoundscapes(storage), []);

  // 2. Wrong top-level type / future incompatible version
  storage.setItem(CUSTOM_SOUNDSCAPES_STORAGE_KEY, JSON.stringify({ version: 999, soundscapes: [] }));
  assert.deepEqual(loadCustomSoundscapes(storage), []);
  storage.setItem(CUSTOM_SOUNDSCAPES_STORAGE_KEY, '"just a string"');
  assert.deepEqual(loadCustomSoundscapes(storage), []);

  // 3. Mixed valid, outdated (missing CH-06 hull), out-of-range, and corrupted entries
  const mixedPayload = {
    version: 1,
    soundscapes: [
      {
        id: 'deep-transit', // Built-in ID collision must be rejected
        name: 'Hijack',
        config: {
          masterVolume: 0.5,
          acousticProfileId: 'bridge',
          ambientEventsEnabled: false,
          channels: {
            reactor: { enabled: true, volume: 0.5 },
          },
        },
      },
      {
        id: 'sc-bad-channel',
        name: 'Invalid Volume NaN',
        config: {
          masterVolume: 0.5,
          acousticProfileId: 'bridge',
          ambientEventsEnabled: false,
          channels: {
            reactor: { enabled: true, volume: 'loud' },
          },
        },
      },
      {
        id: 'sc-missing-channels',
        name: 'Missing Channels Obj',
        config: {
          masterVolume: 0.5,
        },
      },
      {
        id: 'sc-valid-outdated',
        name: 'Older 5-Channel Save',
        description: 'Backfills hull & clamps ranges',
        config: {
          masterVolume: 1.8, // Should clamp to 1
          acousticProfileId: 'unknown-room', // Should fallback to 'bridge'
          ambientEventsEnabled: 'yes', // Should fallback to false
          channels: {
            reactor: { enabled: true, volume: -0.5 }, // Should clamp to 0
            engines: { enabled: false, volume: 0.3 },
            ventilation: { enabled: true, volume: 2.5 }, // Should clamp to 1
            systems: { enabled: true, volume: 0.4 },
            communications: { enabled: false, volume: 0.2 },
            // hull intentionally omitted to verify graceful outdated schema migration
          },
        },
      },
    ],
  };

  const recovered = parseCustomSoundscapesPayload(JSON.stringify(mixedPayload));
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, 'sc-valid-outdated');
  assert.equal(recovered[0].config.masterVolume, 1);
  assert.equal(recovered[0].config.acousticProfileId, 'bridge');
  assert.equal(recovered[0].config.ambientEventsEnabled, false);
  assert.equal(recovered[0].config.channels.reactor.volume, 0);
  assert.equal(recovered[0].config.channels.ventilation.volume, 1);
  assert.deepEqual(recovered[0].config.channels.hull, { enabled: false, volume: 0.25 });

  // Direct validator rejects non-boolean enabled and missing channels
  assert.equal(
    validateSoundscapeConfig({
      masterVolume: 0.5,
      channels: { reactor: { enabled: 'true', volume: 0.5 } },
    }),
    null,
  );
  assert.equal(validateCustomSoundscape({ id: 'sc-1', name: '   ', config: {} }), null);
});
