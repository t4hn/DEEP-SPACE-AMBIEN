import { Clock, Play, Square, Volume2, X } from 'lucide-react';
import { useState } from 'react';
import { formatPercent } from '../audio/mixerState';
import {
  type PlaybackPhase,
  SLEEP_TIMER_DURATIONS_MIN,
  type SleepTimerState,
  formatSleepTimerMMSS,
} from '../audio/sleepTimer';

interface PersistentPlaybackBarProps {
  isActive: boolean;
  playbackPhase: PlaybackPhase;
  fadeDurationSec?: number;
  masterVolume: number;
  activeChannelCount: number;
  totalChannels: number;
  sleepTimer: SleepTimerState;
  onPlayAll: () => void;
  onStopAll: () => void;
  onMasterVolumeChange: (volume: number) => void;
  onSelectSleepTimer: (durationMinutes: number) => void;
  onCancelSleepTimer: () => void;
}

export function PersistentPlaybackBar({
  isActive,
  playbackPhase,
  fadeDurationSec,
  masterVolume,
  activeChannelCount,
  totalChannels,
  sleepTimer,
  onPlayAll,
  onStopAll,
  onMasterVolumeChange,
  onSelectSleepTimer,
  onCancelSleepTimer,
}: PersistentPlaybackBarProps) {
  const [timerMenuOpen, setTimerMenuOpen] = useState(false);

  const volumePercent = Math.round(masterVolume * 100);
  const timerActiveOrArmed =
    sleepTimer.status === 'running' || sleepTimer.status === 'armed';
  const formattedRemaining = formatSleepTimerMMSS(sleepTimer.remainingMs);

  let stateLabel = isActive ? 'Active' : 'Standby';
  let stateGlyph = isActive ? '●' : '◌';
  let stateColor = isActive ? 'text-emerald-400' : 'text-amber-300';

  if (playbackPhase === 'fading-in') {
    stateLabel = `Fading In (${Math.max(1, Math.round(fadeDurationSec ?? 3))}s)`;
    stateGlyph = '●';
    stateColor = 'text-emerald-300';
  } else if (playbackPhase === 'fading-out') {
    stateLabel = `Fading Out (${Math.max(1, Math.round(fadeDurationSec ?? 8))}s)`;
    stateGlyph = '●';
    stateColor = 'text-amber-300';
  }

  let timerButtonLabel = 'Off';
  let timerButtonColor = 'text-zinc-400 border-zinc-800 bg-[#0a0e12]';
  if (sleepTimer.status === 'running') {
    timerButtonLabel = formattedRemaining;
    timerButtonColor = 'text-emerald-300 border-emerald-700/70 bg-emerald-950/40';
  } else if (sleepTimer.status === 'armed') {
    timerButtonLabel = formattedRemaining;
    timerButtonColor = 'text-amber-300 border-amber-700/60 bg-amber-950/30';
  } else if (sleepTimer.status === 'fading-out') {
    timerButtonLabel = 'Fade';
    timerButtonColor = 'text-amber-300 border-amber-700/60 bg-amber-950/30';
  }

  return (
    <section
      aria-label="Persistent Playback Controls"
      data-testid="persistent-playback-bar"
      className="relative border-t border-zinc-800 bg-[#0b0f13]/95 backdrop-blur-sm"
    >
      {/* Quick Sleep Timer Popover */}
      {timerMenuOpen && (
        <div
          role="dialog"
          aria-label="Quick Sleep Timer"
          data-testid="persistent-timer-popover"
          className="absolute right-2 sm:right-4 bottom-full mb-1.5 w-[min(320px,calc(100vw-1rem))] border border-zinc-700 bg-[#0d1115] p-3 shadow-lg z-50"
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-300">
              Sleep Timer
            </span>
            <button
              type="button"
              onClick={() => setTimerMenuOpen(false)}
              aria-label="Close sleep timer menu"
              className="inline-flex items-center justify-center min-w-[32px] min-h-[32px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {SLEEP_TIMER_DURATIONS_MIN.map((minutes) => {
              const isSelected =
                timerActiveOrArmed && sleepTimer.durationMinutes === minutes;
              return (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => {
                    onSelectSleepTimer(minutes);
                    setTimerMenuOpen(false);
                  }}
                  aria-pressed={isSelected}
                  data-testid={`persistent-timer-option-${minutes}`}
                  className={`inline-flex items-center justify-center min-h-[40px] sm:min-h-[34px] px-2 py-1 text-xs font-mono border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-emerald-950/60 border-emerald-500/75 text-emerald-300'
                      : 'bg-[#0a0e12] border-zinc-800 text-zinc-300 hover:border-zinc-600'
                  }`}
                >
                  {minutes}m
                </button>
              );
            })}
          </div>

          {timerActiveOrArmed && (
            <button
              type="button"
              onClick={() => {
                onCancelSleepTimer();
                setTimerMenuOpen(false);
              }}
              data-testid="persistent-timer-cancel"
              className="mt-2 w-full inline-flex items-center justify-center gap-1.5 min-h-[38px] px-3 py-1 text-xs font-mono border border-amber-700/60 bg-amber-950/35 text-amber-300 hover:bg-amber-950/60 cursor-pointer"
            >
              <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Cancel Timer</span>
            </button>
          )}
        </div>
      )}

      <div className="w-full max-w-5xl mx-auto px-3 py-1.5 sm:px-8 md:py-2">
        {/* Mobile Status Row (compact single-line status + master % above control strip) */}
        <div className="flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums mb-1 md:hidden">
          <div className="flex items-center gap-1.5 min-w-0">
            <span aria-hidden="true" className={stateColor}>
              {stateGlyph}
            </span>
            <span className={`font-medium truncate ${stateColor}`}>{stateLabel}</span>
            <span className="text-zinc-600" aria-hidden="true">
              ·
            </span>
            <span className="text-zinc-500 shrink-0">
              {activeChannelCount}/{totalChannels} ch
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-zinc-500">Master</span>
            <span className={isActive ? 'text-emerald-400 font-medium' : 'text-zinc-300 font-medium'}>
              {formatPercent(masterVolume)}
            </span>
          </div>
        </div>

        {/* Main Responsive Control Row */}
        <div className="flex items-center gap-2 sm:gap-4">
          {/* Desktop Status Indicator */}
          <div className="hidden md:flex items-center gap-2 min-w-[140px] text-xs font-mono tabular-nums shrink-0">
            <span aria-hidden="true" className={stateColor}>
              {stateGlyph}
            </span>
            <span className={`font-medium whitespace-nowrap ${stateColor}`}>
              {stateLabel}
            </span>
            <span className="text-zinc-600" aria-hidden="true">
              ·
            </span>
            <span className="text-zinc-500 whitespace-nowrap">
              {activeChannelCount}/{totalChannels}
            </span>
          </div>

          {/* Play All & Stop All */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onPlayAll}
              data-testid="persistent-play-all"
              aria-label="Play All channels"
              className={`inline-flex items-center justify-center gap-1.5 min-h-[44px] md:min-h-[36px] px-2.5 md:px-3 py-1 text-xs font-mono font-medium tracking-wider border transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
                isActive && activeChannelCount === totalChannels
                  ? 'bg-emerald-950/70 border-emerald-500/80 text-emerald-300'
                  : 'bg-emerald-950/40 border-emerald-700/70 text-emerald-300 hover:bg-emerald-900/50 hover:border-emerald-500'
              }`}
            >
              <Play className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Play</span>
            </button>

            <button
              type="button"
              onClick={onStopAll}
              data-testid="persistent-stop-all"
              aria-label="Stop All channels"
              className={`inline-flex items-center justify-center gap-1.5 min-h-[44px] md:min-h-[36px] px-2.5 md:px-3 py-1 text-xs font-mono font-medium tracking-wider border transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
                !isActive
                  ? 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                  : 'bg-amber-950/35 border-amber-700/60 text-amber-300 hover:bg-amber-950/60 hover:border-amber-500'
              }`}
            >
              <Square className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Stop</span>
            </button>
          </div>

          {/* Synchronized Master Volume Slider */}
          <div className="flex-1 min-w-[76px] flex items-center gap-2.5">
            <Volume2
              className="hidden md:block h-4 w-4 text-emerald-400/80 shrink-0"
              aria-hidden="true"
            />
            <div className="relative flex-1 flex items-center h-9 min-w-0">
              <div className="absolute inset-x-0 h-1.5 rounded-xs bg-zinc-800 overflow-hidden pointer-events-none">
                <div
                  className={`h-full transition-[width] duration-100 ${
                    isActive ? 'bg-emerald-500/75' : 'bg-zinc-500/60'
                  }`}
                  style={{ width: `${volumePercent}%` }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={volumePercent}
                data-active={isActive ? 'true' : 'false'}
                data-testid="persistent-master-volume"
                aria-label="Persistent master output volume"
                onChange={(e) => onMasterVolumeChange(Number(e.target.value) / 100)}
                className="console-slider relative z-10 w-full"
              />
            </div>
            <span
              data-testid="persistent-master-readout"
              className={`hidden md:inline-block w-10 text-right text-xs font-mono tabular-nums shrink-0 ${
                isActive ? 'text-emerald-400 font-medium' : 'text-zinc-300 font-medium'
              }`}
            >
              {formatPercent(masterVolume)}
            </span>
          </div>

          {/* Quick Sleep Timer Access */}
          <button
            type="button"
            onClick={() => setTimerMenuOpen((open) => !open)}
            aria-expanded={timerMenuOpen}
            aria-label={`Sleep timer quick access (${timerButtonLabel})`}
            data-testid="persistent-timer-button"
            className={`inline-flex items-center justify-center gap-1.5 min-h-[44px] md:min-h-[36px] px-2.5 md:px-3 py-1 text-xs font-mono tabular-nums border transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${timerButtonColor}`}
          >
            <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{timerButtonLabel}</span>
          </button>
        </div>
      </div>
    </section>
  );
}
