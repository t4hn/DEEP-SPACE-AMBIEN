import { createRef, useEffect, useReducer, useRef } from 'react';
import { DeepSpaceEngine } from './audio/deepSpaceEngine';
import {
  CHANNELS,
  type ChannelId,
  countEnabledChannels,
  createInitialMixerState,
  mixerReducer,
} from './audio/mixerState';
import { ChannelStrip } from './components/ChannelStrip';
import { MasterControls } from './components/MasterControls';

export default function App() {
  const [state, dispatch] = useReducer(mixerReducer, undefined, createInitialMixerState);
  const engineRef = useRef<DeepSpaceEngine | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const meterRefs = useRef<Record<ChannelId, React.RefObject<HTMLDivElement | null>>>({
    reactor: createRef<HTMLDivElement | null>(),
    engines: createRef<HTMLDivElement | null>(),
    ventilation: createRef<HTMLDivElement | null>(),
    systems: createRef<HTMLDivElement | null>(),
    communications: createRef<HTMLDivElement | null>(),
  });

  // Lazily create engine and dispose on unmount
  useEffect(() => {
    const engine = new DeepSpaceEngine();
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
      }
      return;
    }

    if (prefersReducedMotion) {
      for (const ch of CHANNELS) {
        const el = meterRefs.current[ch.id].current;
        if (el) {
          const active = state.channels[ch.id].enabled;
          el.style.transform = `scaleX(${active ? Math.max(0.15, state.channels[ch.id].volume) : 0})`;
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
          const el = meterRefs.current[ch.id].current;
          if (!el) continue;
          const level = current.channels[ch.id].enabled ? Math.max(0.08, levels[ch.id]) : 0;
          el.style.transform = `scaleX(${level.toFixed(3)})`;
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

  const activeChannelCount = countEnabledChannels(state);

  return (
    <div className="min-h-screen bg-[#07090b] text-zinc-100 flex flex-col">
      <main className="w-full max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-10 flex-1 flex flex-col justify-center">
        {/* Console Header */}
        <header className="flex flex-col gap-3 pb-5 mb-6 border-b border-zinc-800/90 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-100">
              DEEP SPACE
            </h1>
            <p className="mt-1 text-xs font-mono tracking-[0.18em] text-zinc-400">
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

        {/* Master Controls */}
        <div className="mb-5">
          <MasterControls
            isActive={state.isActive}
            masterVolume={state.masterVolume}
            activeChannelCount={activeChannelCount}
            totalChannels={CHANNELS.length}
            onPlayAll={handlePlayAll}
            onStopAll={() => dispatch({ type: 'STOP_ALL' })}
            onReset={() => dispatch({ type: 'RESET' })}
            onMasterVolumeChange={(volume) =>
              dispatch({ type: 'SET_MASTER_VOLUME', volume })
            }
          />
        </div>

        {/* Five Independent Audio Channels */}
        <section aria-label="Audio Channels" className="flex flex-col gap-3">
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
