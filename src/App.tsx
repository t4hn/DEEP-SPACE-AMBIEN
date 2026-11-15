import { createRef, useEffect, useReducer, useRef, useState } from 'react';
import type { AmbientEventDescriptor } from './audio/ambientEvents';
import { DeepSpaceEngine } from './audio/deepSpaceEngine';
import {
  CHANNELS,
  type ChannelId,
  type PresetId,
  countEnabledChannels,
  createInitialMixerState,
  mixerReducer,
} from './audio/mixerState';
import { ChannelStrip } from './components/ChannelStrip';
import { MasterControls } from './components/MasterControls';
import { PresetSelector } from './components/PresetSelector';
import { ShipTelemetry } from './components/ShipTelemetry';

export default function App() {
  const [state, dispatch] = useReducer(mixerReducer, undefined, createInitialMixerState);
  const [lastAmbientEvent, setLastAmbientEvent] = useState<AmbientEventDescriptor | null>(null);
  const engineRef = useRef<DeepSpaceEngine | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

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
    void engine.syncState(state);
  }, [state]);

  // Clear recent event readout whenever Ambient Events are disabled or audio stops
  useEffect(() => {
    if (!state.ambientEventsEnabled || !state.isActive) {
      setLastAmbientEvent(null);
    }
  }, [state.ambientEventsEnabled, state.isActive]);

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

  const handlePlayAll = () => {
    engineRef.current?.unlockFromGesture();
    dispatch({ type: 'PLAY_ALL' });
  };

  const handleToggleChannel = (channelId: ChannelId) => {
    if (!state.channels[channelId].enabled) {
      engineRef.current?.unlockFromGesture();
    }
    dispatch({ type: 'TOGGLE_CHANNEL', channelId });
  };

  const handleSelectPreset = (presetId: PresetId) => {
    engineRef.current?.unlockFromGesture();
    dispatch({ type: 'SELECT_PRESET', presetId });
  };

  const handleToggleAmbientEvents = () => {
    if (state.ambientEventsEnabled) {
      setLastAmbientEvent(null);
    }
    dispatch({ type: 'TOGGLE_AMBIENT_EVENTS' });
  };

  const handleStopAll = () => {
    setLastAmbientEvent(null);
    dispatch({ type: 'STOP_ALL' });
  };

  const handleReset = () => {
    setLastAmbientEvent(null);
    dispatch({ type: 'RESET' });
  };

  const activeChannelCount = countEnabledChannels(state);

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
            className="flex items-center gap-2.5 text-xs font-mono tabular-nums"
          >
            <span
              aria-hidden="true"
              className={state.isActive ? 'text-emerald-400' : 'text-amber-400'}
            >
              {state.isActive ? '●' : '◌'}
            </span>
            <span className="text-zinc-400">Audio Environment:</span>
            <span className={state.isActive ? 'text-emerald-400 font-medium' : 'text-amber-300 font-medium'}>
              {state.isActive ? 'Active' : 'Standby'}
            </span>
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

        {/* Compact Environment Presets */}
        <div className="mb-3">
          <PresetSelector
            activePresetId={state.activePresetId}
            onSelectPreset={handleSelectPreset}
          />
        </div>

        {/* Five Independent Audio Channels */}
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
