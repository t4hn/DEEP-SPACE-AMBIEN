import {
  ACOUSTIC_PROFILES,
  type AcousticProfileId,
  DEFAULT_ACOUSTIC_PROFILE_ID,
} from './acousticProfiles';
import {
  CHANNELS,
  type ChannelId,
  type ChannelState,
  DEFAULT_MASTER_VOLUME,
  ENVIRONMENT_PRESETS,
  type MixerState,
  clampUnit,
} from './mixerState';

export const CUSTOM_SOUNDSCAPES_STORAGE_KEY = 'deep-space.custom-soundscapes.v1';
export const CUSTOM_SOUNDSCAPES_SCHEMA_VERSION = 1;

export const MAX_SOUNDSCAPE_NAME_LENGTH = 48;
export const MAX_SOUNDSCAPE_DESCRIPTION_LENGTH = 120;

export const BUILT_IN_PRESET_IDS: ReadonlySet<string> = new Set([
  ...ENVIRONMENT_PRESETS.map((preset) => preset.id),
  'custom',
]);

export interface CustomSoundscapeConfig {
  masterVolume: number;
  acousticProfileId: AcousticProfileId;
  ambientEventsEnabled: boolean;
  channels: Record<ChannelId, ChannelState>;
}

export interface CustomSoundscape {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  config: CustomSoundscapeConfig;
}

export interface CustomSoundscapesStoragePayload {
  version: number;
  soundscapes: CustomSoundscape[];
}

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface SaveSoundscapeInput {
  name: string;
  description?: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeSoundscapeName(rawName: unknown): ValidationResult<string> {
  if (typeof rawName !== 'string') {
    return { ok: false, error: 'Soundscape name is required.' };
  }
  const cleaned = rawName.replace(/\s+/g, ' ').trim().slice(0, MAX_SOUNDSCAPE_NAME_LENGTH);
  if (cleaned.length === 0) {
    return { ok: false, error: 'Soundscape name is required.' };
  }
  return { ok: true, value: cleaned };
}

export function normalizeSoundscapeDescription(rawDescription: unknown): string {
  if (typeof rawDescription !== 'string') {
    return '';
  }
  return rawDescription
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SOUNDSCAPE_DESCRIPTION_LENGTH);
}

export function generateCustomSoundscapeId(
  existingIds: ReadonlySet<string> = new Set(),
  nowMs = Date.now(),
): string {
  let attempt = 0;
  while (attempt < 1000) {
    const suffix = Math.random().toString(36).slice(2, 7);
    const candidate = `sc-${nowMs.toString(36)}-${suffix}`;
    if (!BUILT_IN_PRESET_IDS.has(candidate) && !existingIds.has(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
  return `sc-${nowMs.toString(36)}-${Math.floor(Math.random() * 1_000_000)}`;
}

export function captureSoundscapeConfigFromMixer(
  state: MixerState,
): CustomSoundscapeConfig {
  const channels = {} as Record<ChannelId, ChannelState>;
  for (const ch of CHANNELS) {
    const source = state.channels[ch.id];
    channels[ch.id] = {
      enabled: Boolean(source.enabled),
      volume: clampUnit(source.volume),
    };
  }

  const validAcoustic = ACOUSTIC_PROFILES.some((p) => p.id === state.acousticProfileId)
    ? state.acousticProfileId
    : DEFAULT_ACOUSTIC_PROFILE_ID;

  return {
    masterVolume: clampUnit(state.masterVolume),
    acousticProfileId: validAcoustic,
    ambientEventsEnabled: Boolean(state.ambientEventsEnabled),
    channels,
  };
}

export function validateSoundscapeConfig(
  rawConfig: unknown,
): CustomSoundscapeConfig | null {
  if (!isPlainObject(rawConfig)) {
    return null;
  }

  const rawChannels = rawConfig.channels;
  if (!isPlainObject(rawChannels)) {
    return null;
  }

  const channels = {} as Record<ChannelId, ChannelState>;
  for (const ch of CHANNELS) {
    const entry = rawChannels[ch.id];
    if (entry === undefined) {
      // Gracefully backfill channels added in later versions (e.g. CH-06 hull)
      channels[ch.id] = {
        enabled: false,
        volume: ch.defaultVolume,
      };
      continue;
    }
    if (!isPlainObject(entry)) {
      return null;
    }
    if (typeof entry.enabled !== 'boolean') {
      return null;
    }
    if (typeof entry.volume !== 'number' || !Number.isFinite(entry.volume)) {
      return null;
    }
    channels[ch.id] = {
      enabled: entry.enabled,
      volume: clampUnit(entry.volume),
    };
  }

  const rawMaster = rawConfig.masterVolume;
  const masterVolume =
    typeof rawMaster === 'number' && Number.isFinite(rawMaster)
      ? clampUnit(rawMaster)
      : DEFAULT_MASTER_VOLUME;

  const rawProfile = rawConfig.acousticProfileId;
  const acousticProfileId =
    typeof rawProfile === 'string' &&
    ACOUSTIC_PROFILES.some((profile) => profile.id === rawProfile)
      ? (rawProfile as AcousticProfileId)
      : DEFAULT_ACOUSTIC_PROFILE_ID;

  const ambientEventsEnabled =
    typeof rawConfig.ambientEventsEnabled === 'boolean'
      ? rawConfig.ambientEventsEnabled
      : false;

  return {
    masterVolume,
    acousticProfileId,
    ambientEventsEnabled,
    channels,
  };
}

export function validateCustomSoundscape(raw: unknown): CustomSoundscape | null {
  if (!isPlainObject(raw)) {
    return null;
  }

  if (typeof raw.id !== 'string') {
    return null;
  }
  const id = raw.id.trim();
  if (id.length === 0 || BUILT_IN_PRESET_IDS.has(id)) {
    return null;
  }

  const nameResult = normalizeSoundscapeName(raw.name);
  if (!nameResult.ok) {
    return null;
  }

  const config = validateSoundscapeConfig(raw.config);
  if (!config) {
    return null;
  }

  const description = normalizeSoundscapeDescription(raw.description);
  const fallbackIso = new Date(0).toISOString();
  const createdAt =
    typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
      ? raw.createdAt
      : fallbackIso;
  const updatedAt =
    typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : createdAt;

  return {
    id,
    name: nameResult.value,
    description,
    createdAt,
    updatedAt,
    config,
  };
}

export function parseCustomSoundscapesPayload(rawJson: string): CustomSoundscape[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }

  let candidateItems: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    // Support legacy bare-array payloads gracefully
    candidateItems = parsed;
  } else if (isPlainObject(parsed)) {
    const version = parsed.version;
    if (
      version !== undefined &&
      (typeof version !== 'number' ||
        !Number.isFinite(version) ||
        version > CUSTOM_SOUNDSCAPES_SCHEMA_VERSION)
    ) {
      return [];
    }
    if (Array.isArray(parsed.soundscapes)) {
      candidateItems = parsed.soundscapes;
    }
  }

  if (!candidateItems) {
    return [];
  }

  const seenIds = new Set<string>();
  const valid: CustomSoundscape[] = [];
  for (const item of candidateItems) {
    const validated = validateCustomSoundscape(item);
    if (!validated || seenIds.has(validated.id)) {
      continue;
    }
    seenIds.add(validated.id);
    valid.push(validated);
  }

  return valid;
}

export function serializeCustomSoundscapesPayload(
  soundscapes: readonly CustomSoundscape[],
): string {
  const sanitized: CustomSoundscape[] = [];
  const seenIds = new Set<string>();
  for (const item of soundscapes) {
    const validated = validateCustomSoundscape(item);
    if (validated && !seenIds.has(validated.id)) {
      seenIds.add(validated.id);
      sanitized.push(validated);
    }
  }
  const payload: CustomSoundscapesStoragePayload = {
    version: CUSTOM_SOUNDSCAPES_SCHEMA_VERSION,
    soundscapes: sanitized,
  };
  return JSON.stringify(payload);
}

function getDefaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access errors in restricted contexts
  }
  return null;
}

export function loadCustomSoundscapes(
  storage: StorageLike | null = getDefaultStorage(),
): CustomSoundscape[] {
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(CUSTOM_SOUNDSCAPES_STORAGE_KEY);
    if (raw === null || raw.trim() === '') {
      return [];
    }
    return parseCustomSoundscapesPayload(raw);
  } catch {
    return [];
  }
}

export function persistCustomSoundscapes(
  soundscapes: readonly CustomSoundscape[],
  storage: StorageLike | null = getDefaultStorage(),
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(
      CUSTOM_SOUNDSCAPES_STORAGE_KEY,
      serializeCustomSoundscapesPayload(soundscapes),
    );
    return true;
  } catch {
    return false;
  }
}

export function createCustomSoundscape(
  existing: readonly CustomSoundscape[],
  mixerState: MixerState,
  input: SaveSoundscapeInput,
  nowMs = Date.now(),
): ValidationResult<{ soundscape: CustomSoundscape; soundscapes: CustomSoundscape[] }> {
  const nameResult = normalizeSoundscapeName(input.name);
  if (!nameResult.ok) {
    return nameResult;
  }

  const existingIds = new Set(existing.map((s) => s.id));
  const id = generateCustomSoundscapeId(existingIds, nowMs);
  const iso = new Date(nowMs).toISOString();

  const soundscape: CustomSoundscape = {
    id,
    name: nameResult.value,
    description: normalizeSoundscapeDescription(input.description),
    createdAt: iso,
    updatedAt: iso,
    config: captureSoundscapeConfigFromMixer(mixerState),
  };

  return {
    ok: true,
    value: {
      soundscape,
      soundscapes: [soundscape, ...existing],
    },
  };
}

export function updateCustomSoundscapeMetadata(
  existing: readonly CustomSoundscape[],
  id: string,
  input: SaveSoundscapeInput,
  nowMs = Date.now(),
): ValidationResult<CustomSoundscape[]> {
  if (BUILT_IN_PRESET_IDS.has(id)) {
    return { ok: false, error: 'Built-in presets cannot be modified.' };
  }

  const targetIndex = existing.findIndex((s) => s.id === id);
  if (targetIndex === -1) {
    return { ok: false, error: 'Custom soundscape not found.' };
  }

  const nameResult = normalizeSoundscapeName(input.name);
  if (!nameResult.ok) {
    return nameResult;
  }

  const updated: CustomSoundscape = {
    ...existing[targetIndex],
    name: nameResult.value,
    description: normalizeSoundscapeDescription(input.description),
    updatedAt: new Date(nowMs).toISOString(),
  };

  const next = [...existing];
  next[targetIndex] = updated;
  return { ok: true, value: next };
}

export function deleteCustomSoundscape(
  existing: readonly CustomSoundscape[],
  id: string,
): ValidationResult<CustomSoundscape[]> {
  if (BUILT_IN_PRESET_IDS.has(id)) {
    return { ok: false, error: 'Built-in presets cannot be deleted.' };
  }

  const exists = existing.some((s) => s.id === id);
  if (!exists) {
    return { ok: false, error: 'Custom soundscape not found.' };
  }

  return {
    ok: true,
    value: existing.filter((s) => s.id !== id),
  };
}
