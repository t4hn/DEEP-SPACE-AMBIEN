export const SLEEP_TIMER_DURATIONS_MIN = [15, 30, 45, 60, 90, 120] as const;

export const DEFAULT_FADE_IN_SEC = 3;
export const DEFAULT_FADE_OUT_SEC = 8;
export const SLEEP_FADE_OUT_SEC = 30;

export type PlaybackPhase = 'stopped' | 'fading-in' | 'active' | 'fading-out';

export type SleepTimerStatus = 'idle' | 'armed' | 'running' | 'fading-out';

export interface SleepTimerState {
  status: SleepTimerStatus;
  durationMinutes: number | null;
  durationMs: number;
  deadlineMs: number | null;
  remainingMs: number;
}

export function createInitialSleepTimerState(): SleepTimerState {
  return {
    status: 'idle',
    durationMinutes: null,
    durationMs: 0,
    deadlineMs: null,
    remainingMs: 0,
  };
}

export function startOrSelectSleepTimer(
  durationMinutes: number,
  isAudioActive: boolean,
  nowMs: number,
  overrideDurationMs?: number | null,
): SleepTimerState {
  const durationMs =
    overrideDurationMs !== undefined &&
    overrideDurationMs !== null &&
    Number.isFinite(overrideDurationMs) &&
    overrideDurationMs > 0
      ? Math.round(overrideDurationMs)
      : Math.max(1, Math.round(durationMinutes)) * 60_000;

  if (isAudioActive) {
    return {
      status: 'running',
      durationMinutes,
      durationMs,
      deadlineMs: nowMs + durationMs,
      remainingMs: durationMs,
    };
  }

  return {
    status: 'armed',
    durationMinutes,
    durationMs,
    deadlineMs: null,
    remainingMs: durationMs,
  };
}

export function activateArmedSleepTimer(
  timer: SleepTimerState,
  nowMs: number,
): SleepTimerState {
  if (timer.status !== 'armed' || timer.durationMs <= 0) {
    return timer;
  }

  return {
    ...timer,
    status: 'running',
    deadlineMs: nowMs + timer.durationMs,
    remainingMs: timer.durationMs,
  };
}

export function cancelSleepTimer(): SleepTimerState {
  return createInitialSleepTimerState();
}

export function computeSleepTimerRemainingMs(
  timer: SleepTimerState,
  nowMs: number,
): number {
  if (timer.status === 'running' && timer.deadlineMs !== null) {
    return Math.max(0, timer.deadlineMs - nowMs);
  }
  if (timer.status === 'armed') {
    return Math.max(0, timer.durationMs);
  }
  return 0;
}

export function syncSleepTimerTick(
  timer: SleepTimerState,
  nowMs: number,
): { next: SleepTimerState; expired: boolean } {
  if (timer.status !== 'running' || timer.deadlineMs === null) {
    return { next: timer, expired: false };
  }

  const remainingMs = Math.max(0, timer.deadlineMs - nowMs);
  if (remainingMs <= 0) {
    return {
      next: {
        status: 'fading-out',
        durationMinutes: timer.durationMinutes,
        durationMs: timer.durationMs,
        deadlineMs: null,
        remainingMs: 0,
      },
      expired: true,
    };
  }

  if (remainingMs === timer.remainingMs) {
    return { next: timer, expired: false };
  }

  return {
    next: {
      ...timer,
      remainingMs,
    },
    expired: false,
  };
}

export function formatSleepTimerMMSS(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
