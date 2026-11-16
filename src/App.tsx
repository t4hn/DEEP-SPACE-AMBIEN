import { createRef, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AcousticProfileId } from './audio/acousticProfiles';
import type { AmbientEventDescriptor } from './audio/ambientEvents';
import {
  type CustomSoundscape,
  type SaveSoundscapeInput,
  type ValidationResult,
  createCustomSoundscape,
  deleteCustomSoundscape,
  loadCustomSoundscapes,
  persistCustomSoundscapes,
  updateCustomSoundscapeMetadata,
} from './audio/customSoundscapes';
import { DeepSpaceEngine } from './audio/deepSpaceEngine';
import {
  CHANNELS,
  type ChannelId,
  type PresetId,
  countEnabledChannels,
  createInitialMixerState,
  mixerReducer,
} from './audio/mixerState';
import {
  DEFAULT_FADE_OUT_SEC,
  type PlaybackPhase,
  SLEEP_FADE_OUT_SEC,
  type SleepTimerState,
  activateArmedSleepTimer,
  cancelSleepTimer,
  createInitialSleepTimerState,
  startOrSelectSleepTimer,
  syncSleepTimerTick,
} from './audio/sleepTimer';
import { AcousticProfileSelector } from './components/AcousticProfileSelector';
import { ChannelStrip } from './components/ChannelStrip';
import { MasterControls } from './components/MasterControls';
import { PlaybackTransitions } from './components/PlaybackTransitions';
import { PresetSelector } from './components/PresetSelector';
import { ShipTelemetry } from './components/ShipTelemetry';

function readTestTransitionOverrides(): {
  sleepTimerOverrideMs: number | null;
  sleepFadeDurationSec: number;
} {
  if (typeof window === 'undefined') {
    return {
      sleepTimerOverrideMs: null,
      sleepFadeDurationSec: SLEEP_FADE_OUT_SEC,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const rawTimerSec = params.get('sleepTimerSec');
  const rawFadeSec = params.get('sleepFadeSec');
  const parsedTimerSec = rawTimerSec !== null ? Number(rawTimerSec) : NaN;
  const parsedFadeSec = rawFadeSec !== null ? Number(rawFadeSec) : NaN;
  return {
    sleepTimerOverrideMs:
      Number.isFinite(parsedTimerSec) && parsedTimerSec > 0
        ? Math.round(parsedTimerSec * 1000)
        : null,
    sleepFadeDurationSec:
      Number.isFinite(parsedFadeSec) && parsedFadeSec > 0
        ? parsedFadeSec
        : SLEEP_FADE_OUT_SEC,
  };
}

export default function App() {
  const [state, dispatch] = useReducer(mixerReducer, undefined, createInitialMixerState);
  const [lastAmbientEvent, setLastAmbientEvent] = useState<AmbientEventDescriptor | null>(null);
  const [playbackPhase, setPlaybackPhase] = useState<PlaybackPhase>('stopped');
  const [activeFadeDurationSec, setActiveFadeDurationSec] = useState<number | undefined>(
    undefined,
  );
  const [sleepTimer, setSleepTimer] = useState<SleepTimerState>(
    createInitialSleepTimerState,
  );
  const [customSoundscapes, setCustomSoundscapes] = useState<CustomSoundscape[]>(() =>
    loadCustomSoundscapes(),
  );

  const testOverrides = useMemo(readTestTransitionOverrides, []);

  const engineRef = useRef<DeepSpaceEngine | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sleepTimerRef = useRef(sleepTimer);
  sleepTimerRef.current = sleepTimer;
  const pendingFadeOutSecRef = useRef<number | undefined>(undefined);

  const meterRefs = useRef<Record<ChannelId, React.RefObject<HTMLDivElement | null>>>({
    reactor: createRef<HTMLDivElement | null>(),
    engines: createRef<HTMLDivElement | null>(),
    ventilation: createRef<HTMLDivElement | null>(),
    systems: createRef<HTMLDivElement | null>(),
    communications: createRef<HTMLDivElement | null>(),
    hull: createRef<HTMLDivElement | null>(),
  });

  const telemetryMeterRefs = useRef<Record<ChannelId, React.RefObject<HTMLDivElement | null>>>({
    reactor: createRef<HTMLDivElement | null>(),
    engines: createRef<HTMLDivElement | null>(),
    ventilation: createRef<HTMLDivElement | null>(),
    systems: createRef<HTMLDivElement | null>(),
    communications: createRef<HTMLDivElement | null>(),
    hull: createRef<HTMLDivElement | null>(),
  });

  // Lazily create engine and dispose on unmount
  useEffect(() => {
    const engine = new DeepSpaceEngine({
      onAmbientEvent: (ev) => {
        setLastAmbientEvent(ev);
      },
      onPlaybackPhaseChange: (phase, fadeSec) => {
        setPlaybackPhase(phase);
        setActiveFadeDurationSec(fadeSec);
      },
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Sync mixer state changes into Web Audio engine
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const fadeOutDurationSec = pendingFadeOutSecRef.current;
    pendingFadeOutSecRef.current = undefined;
    void engine.syncState(
      state,
      fadeOutDurationSec !== undefined ? { fadeOutDurationSec } : undefined,
    );
  }, [state]);

  // Clear recent event readout whenever Ambient Events are disabled or audio stops
  useEffect(() => {
    if (!state.ambientEventsEnabled || !state.isActive) {
      setLastAmbientEvent(null);
    }
  }, [state.ambientEventsEnabled, state.isActive]);

  // Reset sleep timer cleanly once its fade-out completes
  useEffect(() => {
    if (playbackPhase === 'stopped' && sleepTimerRef.current.status === 'fading-out') {
      setSleepTimer(createInitialSleepTimerState());
    }
  }, [playbackPhase]);

  // Deadline-based sleep timer ticker (resilient against tab throttling/sleep)
  useEffect(() => {
    if (sleepTimer.status !== 'running') {
      return;
    }

    const evaluateTick = () => {
      const { next, expired } = syncSleepTimerTick(sleepTimerRef.current, Date.now());
      if (next !== sleepTimerRef.current) {
        setSleepTimer(next);
      }
      if (expired) {
        setLastAmbientEvent(null);
        pendingFadeOutSecRef.current = testOverrides.sleepFadeDurationSec;
        dispatch({ type: 'STOP_ALL' });
      }
    };

    const intervalId = window.setInterval(evaluateTick, 250);
    const handleVisibility = () => {
      if (!document.hidden) {
        evaluateTick();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', evaluateTick);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', evaluateTick);
    };
  }, [sleepTimer.status, testOverrides.sleepFadeDurationSec]);

  // Lightweight direct-DOM meter updates only while audio environment is active
  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!state.isActive) {
      for (const ch of CHANNELS) {
        const el = meterRefs.current[ch.id].current;
        if (el) {
          el.style.transform = 'scaleX(0)';
        }
        const telEl = telemetryMeterRefs.current[ch.id].current;
        if (telEl) {
          telEl.style.transform = 'scaleX(0)';
        }
      }
      return;
    }

    if (prefersReducedMotion) {
      for (const ch of CHANNELS) {
        const active = state.channels[ch.id].enabled;
        const val = `scaleX(${active ? Math.max(0.15, state.channels[ch.id].volume) : 0})`;
        const el = meterRefs.current[ch.id].current;
        if (el) {
          el.style.transform = val;
        }
        const telEl = telemetryMeterRefs.current[ch.id].current;
        if (telEl) {
          telEl.style.transform = val;
        }
      }
      return;
    }

    let rafId = 0;
    const updateMeters = () => {
      const engine = engineRef.current;
      const current = stateRef.current;
      if (engine && current.isActive && !document.hidden) {
        const levels = engine.getChannelLevels(current);
        for (const ch of CHANNELS) {
          const level = current.channels[ch.id].enabled ? Math.max(0.08, levels[ch.id]) : 0;
          const transform = `scaleX(${level.toFixed(3)})`;
          const el = meterRefs.current[ch.id].current;
          if (el) {
            el.style.transform = transform;
          }
          const telEl = telemetryMeterRefs.current[ch.id].current;
          if (telEl) {
            telEl.style.transform = transform;
          }
        }
      }
      if (!document.hidden) {
        rafId = window.requestAnimationFrame(updateMeters);
      } else {
        rafId = 0;
      }
    };

    const handleVisibility = () => {
      if (!document.hidden && rafId === 0 && stateRef.current.isActive) {
        rafId = window.requestAnimationFrame(updateMeters);
      } else if (document.hidden && rafId !== 0) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    if (!document.hidden) {
      rafId = window.requestAnimationFrame(updateMeters);
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [state.isActive, state.channels]);

  const syncSleepTimerOnPlaybackStart = () => {
    setSleepTimer((prev) => {
      if (prev.status === 'armed') {
        return activateArmedSleepTimer(prev, Date.now());
      }
      if (prev.status === 'fading-out') {
        return createInitialSleepTimerState();
      }
      return prev;
    });
  };

  const handlePlayAll = () => {
    engineRef.current?.unlockFromGesture();
    syncSleepTimerOnPlaybackStart();
    dispatch({ type: 'PLAY_ALL' });
  };

  const handleToggleChannel = (channelId: ChannelId) => {
    const enabling = !state.channels[channelId].enabled;
    if (enabling) {
      engineRef.current?.unlockFromGesture();
      if (!state.isActive) {
        syncSleepTimerOnPlaybackStart();
      }
    } else if (state.isActive && countEnabledChannels(state) <= 1) {
      // Disabling the last active channel stops playback manually -> cancel active timer
      setSleepTimer(cancelSleepTimer());
      pendingFadeOutSecRef.current = DEFAULT_FADE_OUT_SEC;
    }
    dispatch({ type: 'TOGGLE_CHANNEL', channelId });
  };

  const handleSelectPreset = (presetId: PresetId) => {
    engineRef.current?.unlockFromGesture();
    const nextState = mixerReducer(state, { type: 'SELECT_PRESET', presetId });
    if (nextState.isActive && !state.isActive) {
      syncSleepTimerOnPlaybackStart();
    } else if (!nextState.isActive && state.isActive) {
      setSleepTimer(cancelSleepTimer());
      pendingFadeOutSecRef.current = DEFAULT_FADE_OUT_SEC;
    }
    dispatch({ type: 'SELECT_PRESET', presetId });
  };

  const handleLoadCustomSoundscape = (soundscape: CustomSoundscape) => {
    // Loading must never start playback automatically, recreate the engine, or interrupt sleep timers.
    dispatch({ type: 'LOAD_CUSTOM_SOUNDSCAPE', soundscape });
  };

  const handleSaveCustomSoundscape = (
    input: SaveSoundscapeInput,
  ): ValidationResult<CustomSoundscape> => {
    const result = createCustomSoundscape(customSoundscapes, state, input);
    if (!result.ok) {
      return result;
    }
    setCustomSoundscapes(result.value.soundscapes);
    persistCustomSoundscapes(result.value.soundscapes);
    return { ok: true, value: result.value.soundscape };
  };

  const handleUpdateCustomSoundscape = (
    id: string,
    input: SaveSoundscapeInput,
  ): ValidationResult<CustomSoundscape> => {
    const result = updateCustomSoundscapeMetadata(customSoundscapes, id, input);
    if (!result.ok) {
      return result;
    }
    const updated = result.value.find((s) => s.id === id);
    if (!updated) {
      return { ok: false, error: 'Custom soundscape not found.' };
    }
    setCustomSoundscapes(result.value);
    persistCustomSoundscapes(result.value);
    return { ok: true, value: updated };
  };

  const handleDeleteCustomSoundscape = (id: string) => {
    const result = deleteCustomSoundscape(customSoundscapes, id);
    if (!result.ok) {
      return;
    }
    setCustomSoundscapes(result.value);
    persistCustomSoundscapes(result.value);
  };

  const handleSelectAcousticProfile = (profileId: AcousticProfileId) => {
    dispatch({ type: 'SELECT_ACOUSTIC_PROFILE', profileId });
  };

  const handleToggleAmbientEvents = () => {
    if (state.ambientEventsEnabled) {
      setLastAmbientEvent(null);
    }
    dispatch({ type: 'TOGGLE_AMBIENT_EVENTS' });
  };

  const handleStopAll = () => {
    setLastAmbientEvent(null);
    setSleepTimer(cancelSleepTimer());
    pendingFadeOutSecRef.current = DEFAULT_FADE_OUT_SEC;
    dispatch({ type: 'STOP_ALL' });
  };

  const handleReset = () => {
    setLastAmbientEvent(null);
    setSleepTimer(cancelSleepTimer());
    pendingFadeOutSecRef.current = DEFAULT_FADE_OUT_SEC;
    dispatch({ type: 'RESET' });
  };

  const handleSelectSleepTimer = (durationMinutes: number) => {
    setSleepTimer(
      startOrSelectSleepTimer(
        durationMinutes,
        state.isActive,
        Date.now(),
        testOverrides.sleepTimerOverrideMs,
      ),
    );
  };

  const handleCancelSleepTimer = () => {
    setSleepTimer(cancelSleepTimer());
  };

  const activeChannelCount = countEnabledChannels(state);

  let headerStatusLabel = state.isActive ? 'Active' : 'Standby';
  let headerStatusColor = state.isActive ? 'text-emerald-400 font-medium' : 'text-amber-300 font-medium';
  let headerStatusGlyph = state.isActive ? '●' : '◌';
  let headerGlyphColor = state.isActive ? 'text-emerald-400' : 'text-amber-400';

  if (playbackPhase === 'fading-in') {
    headerStatusLabel = 'Fading In';
  } else if (playbackPhase === 'fading-out') {
    headerStatusLabel = 'Fading Out';
    headerStatusColor = 'text-amber-300 font-medium';
    headerGlyphColor = 'text-amber-400';
  }

  return (
    <div className="min-h-screen bg-[#07090b] text-zinc-100 flex flex-col">
      <main className="w-full max-w-5xl mx-auto px-4 py-4 sm:px-8 sm:py-4 flex-1 flex flex-col justify-center">
        {/* Console Header */}
        <header className="flex flex-col gap-2 pb-3 mb-3 border-b border-zinc-800/90 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-100">
              DEEP SPACE
            </h1>
            <p className="mt-0.5 text-xs font-mono tracking-[0.18em] text-zinc-400">
              SHIPBOARD AUDIO ENVIRONMENT
            </p>
          </div>

          <div
            data-testid="environment-status"
            data-active={state.isActive ? 'true' : 'false'}
            data-phase={playbackPhase}
            className="flex items-center gap-2.5 text-xs font-mono tabular-nums"
          >
            <span aria-hidden="true" className={headerGlyphColor}>
              {headerStatusGlyph}
            </span>
            <span className="text-zinc-400">Audio Environment:</span>
            <span className={headerStatusColor}>{headerStatusLabel}</span>
          </div>
        </header>

        {/* Ship Telemetry Dashboard */}
        <div className="mb-3">
          <ShipTelemetry
            state={state}
            lastAmbientEvent={lastAmbientEvent}
            telemetryMeterRefs={telemetryMeterRefs.current}
          />
        </div>

        {/* Master Controls */}
        <div className="mb-3">
          <MasterControls
            isActive={state.isActive}
            masterVolume={state.masterVolume}
            activeChannelCount={activeChannelCount}
            totalChannels={CHANNELS.length}
            ambientEventsEnabled={state.ambientEventsEnabled}
            lastAmbientEvent={lastAmbientEvent}
            onPlayAll={handlePlayAll}
            onStopAll={handleStopAll}
            onReset={handleReset}
            onMasterVolumeChange={(volume) =>
              dispatch({ type: 'SET_MASTER_VOLUME', volume })
            }
            onToggleAmbientEvents={handleToggleAmbientEvents}
          />
        </div>

        {/* Playback Transitions & Sleep Timer */}
        <div className="mb-3">
          <PlaybackTransitions
            playbackPhase={playbackPhase}
            fadeDurationSec={activeFadeDurationSec}
            sleepTimer={sleepTimer}
            onSelectSleepTimer={handleSelectSleepTimer}
            onCancelSleepTimer={handleCancelSleepTimer}
          />
        </div>

        {/* Compact Environment Presets & Custom Soundscapes */}
        <div className="mb-3">
          <PresetSelector
            activePresetId={state.activePresetId}
            activeCustomSoundscapeId={state.activeCustomSoundscapeId}
            customSoundscapes={customSoundscapes}
            onSelectPreset={handleSelectPreset}
            onLoadCustomSoundscape={handleLoadCustomSoundscape}
            onSaveCustomSoundscape={handleSaveCustomSoundscape}
            onUpdateCustomSoundscape={handleUpdateCustomSoundscape}
            onDeleteCustomSoundscape={handleDeleteCustomSoundscape}
          />
        </div>

        {/* Acoustic Environment Profiles */}
        <div className="mb-3">
          <AcousticProfileSelector
            activeProfileId={state.acousticProfileId}
            onSelectProfile={handleSelectAcousticProfile}
          />
        </div>

        {/* Six Independent Audio Channels */}
        <section aria-label="Audio Channels" className="flex flex-col gap-2">
          {CHANNELS.map((ch) => (
            <ChannelStrip
              key={ch.id}
              meta={ch}
              state={state.channels[ch.id]}
              environmentActive={state.isActive}
              meterRef={meterRefs.current[ch.id]}
              onToggle={() => handleToggleChannel(ch.id)}
              onVolumeChange={(volume) =>
                dispatch({
                  type: 'SET_CHANNEL_VOLUME',
                  channelId: ch.id,
                  volume,
                })
              }
            />
          ))}
        </section>
      </main>
    </div>
  );
}
