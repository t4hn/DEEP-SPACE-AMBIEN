import { Clock, X } from 'lucide-react';
import {
  type PlaybackPhase,
  SLEEP_TIMER_DURATIONS_MIN,
  type SleepTimerState,
  formatSleepTimerMMSS,
} from '../audio/sleepTimer';

interface PlaybackTransitionsProps {
  playbackPhase: PlaybackPhase;
  fadeDurationSec?: number;
  sleepTimer: SleepTimerState;
  onSelectSleepTimer: (durationMinutes: number) => void;
  onCancelSleepTimer: () => void;
}

export function PlaybackTransitions({
  playbackPhase,
  fadeDurationSec,
  sleepTimer,
  onSelectSleepTimer,
  onCancelSleepTimer,
}: PlaybackTransitionsProps) {
  let phaseLabel = 'Standby';
  let phaseClass = 'text-zinc-400';
  let phaseDotClass = 'bg-zinc-600';

  if (playbackPhase === 'fading-in') {
    phaseLabel = `Fading In (${Math.max(1, Math.round(fadeDurationSec ?? 3))}s)`;
    phaseClass = 'text-emerald-300';
    phaseDotClass = 'bg-emerald-400';
  } else if (playbackPhase === 'active') {
    phaseLabel = 'Active';
    phaseClass = 'text-emerald-400';
    phaseDotClass = 'bg-emerald-400';
  } else if (playbackPhase === 'fading-out') {
    phaseLabel = `Fading Out (${Math.max(1, Math.round(fadeDurationSec ?? 8))}s)`;
    phaseClass = 'text-amber-300';
    phaseDotClass = 'bg-amber-400';
  }

  const timerActiveOrArmed =
    sleepTimer.status === 'running' || sleepTimer.status === 'armed';
  const formattedRemaining = formatSleepTimerMMSS(sleepTimer.remainingMs);

  let timerStatusLabel = 'Off';
  let timerStatusClass = 'text-zinc-500';
  if (sleepTimer.status === 'running') {
    timerStatusLabel = formattedRemaining;
    timerStatusClass = 'text-emerald-300 font-medium';
  } else if (sleepTimer.status === 'armed') {
    timerStatusLabel = `Armed · ${formattedRemaining}`;
    timerStatusClass = 'text-amber-300 font-medium';
  } else if (sleepTimer.status === 'fading-out') {
    timerStatusLabel = '00:00 · Sleep Fade';
    timerStatusClass = 'text-amber-300 font-medium';
  }

  return (
    <section
      aria-label="Playback Transitions"
      data-testid="playback-transitions"
      className="border border-zinc-800 bg-[#0d1115] px-5 py-3.5 sm:px-6"
    >
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 mb-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-xs font-mono uppercase tracking-wider text-zinc-300 whitespace-nowrap shrink-0">
            Playback Transitions
          </h2>
          <span className="text-[11px] font-mono text-zinc-500">
            3s fade-in · 8s stop fade-out
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums">
          <div
            data-testid="playback-transition-status"
            data-phase={playbackPhase}
            className="flex items-center gap-2 whitespace-nowrap"
          >
            <span className="text-zinc-500">Transition:</span>
            <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${phaseDotClass}`} />
            <span className={phaseClass}>{phaseLabel}</span>
          </div>

          <div
            data-testid="sleep-timer-countdown"
            data-status={sleepTimer.status}
            className="flex items-center gap-1.5 whitespace-nowrap"
          >
            <Clock className="h-3.5 w-3.5 text-zinc-500 shrink-0" aria-hidden="true" />
            <span className="text-zinc-500">Sleep Timer:</span>
            <span className={timerStatusClass}>{timerStatusLabel}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="group"
          aria-label="Sleep Timer Duration"
          className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-2 flex-1"
        >
          {SLEEP_TIMER_DURATIONS_MIN.map((minutes) => {
            const isSelected =
              timerActiveOrArmed && sleepTimer.durationMinutes === minutes;
            return (
              <button
                key={minutes}
                type="button"
                onClick={() => onSelectSleepTimer(minutes)}
                aria-pressed={isSelected}
                data-testid={`sleep-timer-option-${minutes}`}
                className={`inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px] px-3 py-1.5 text-xs font-mono font-medium tracking-wider border transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
                  isSelected
                    ? 'bg-emerald-950/60 border-emerald-500/75 text-emerald-300'
                    : 'bg-[#0a0e12] border-zinc-800/90 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900/60 hover:text-zinc-100'
                }`}
              >
                {minutes}m
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onCancelSleepTimer}
          disabled={!timerActiveOrArmed}
          data-testid="sleep-timer-cancel"
          aria-label="Cancel sleep timer"
          className={`inline-flex items-center justify-center gap-1.5 min-h-[44px] sm:min-h-[36px] px-3.5 py-1.5 text-xs font-mono font-medium tracking-wider border transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
            timerActiveOrArmed
              ? 'bg-amber-950/35 border-amber-700/60 text-amber-300 hover:bg-amber-950/60 hover:border-amber-500 cursor-pointer'
              : 'bg-zinc-900/50 border-zinc-800/70 text-zinc-600 cursor-not-allowed'
          }`}
        >
          <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Cancel Timer</span>
        </button>
      </div>
    </section>
  );
}
