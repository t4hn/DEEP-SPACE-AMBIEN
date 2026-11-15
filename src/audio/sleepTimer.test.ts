import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_FADE_IN_SEC,
  DEFAULT_FADE_OUT_SEC,
  SLEEP_FADE_OUT_SEC,
  SLEEP_TIMER_DURATIONS_MIN,
  activateArmedSleepTimer,
  cancelSleepTimer,
  computeSleepTimerRemainingMs,
  createInitialSleepTimerState,
  formatSleepTimerMMSS,
  startOrSelectSleepTimer,
  syncSleepTimerTick,
} from './sleepTimer';

test('playback transition constants match specification', () => {
  assert.equal(DEFAULT_FADE_IN_SEC, 3);
  assert.equal(DEFAULT_FADE_OUT_SEC, 8);
  assert.equal(SLEEP_FADE_OUT_SEC, 30);
  assert.deepEqual([...SLEEP_TIMER_DURATIONS_MIN], [15, 30, 45, 60, 90, 120]);
});

test('deadline-based sleep timer tracks remaining time accurately across tab throttling jumps', () => {
  const startMs = 1_700_000_000_000;
  const timer = startOrSelectSleepTimer(30, true, startMs);

  assert.equal(timer.status, 'running');
  assert.equal(timer.durationMinutes, 30);
  assert.equal(timer.deadlineMs, startMs + 30 * 60_000);
  assert.equal(formatSleepTimerMMSS(timer.remainingMs), '30:00');

  // Jump clock forward 12m 15s in one step (simulating background tab throttling)
  const afterJumpMs = startMs + (12 * 60 + 15) * 1000;
  const tick1 = syncSleepTimerTick(timer, afterJumpMs);
  assert.equal(tick1.expired, false);
  assert.equal(tick1.next.status, 'running');
  assert.equal(tick1.next.remainingMs, (17 * 60 + 45) * 1000);
  assert.equal(formatSleepTimerMMSS(tick1.next.remainingMs), '17:45');

  // Jump past deadline -> expires cleanly
  const pastDeadlineMs = startMs + 30 * 60_000 + 250;
  const tick2 = syncSleepTimerTick(tick1.next, pastDeadlineMs);
  assert.equal(tick2.expired, true);
  assert.equal(tick2.next.status, 'fading-out');
  assert.equal(tick2.next.remainingMs, 0);
  assert.equal(formatSleepTimerMMSS(tick2.next.remainingMs), '00:00');
});

test('selecting a new duration resets an already-running sleep timer', () => {
  const t0 = 10_000;
  let timer = startOrSelectSleepTimer(15, true, t0);
  timer = syncSleepTimerTick(timer, t0 + 120_000).next;
  assert.equal(formatSleepTimerMMSS(timer.remainingMs), '13:00');

  const t1 = t0 + 120_000;
  timer = startOrSelectSleepTimer(90, true, t1);
  assert.equal(timer.durationMinutes, 90);
  assert.equal(timer.deadlineMs, t1 + 90 * 60_000);
  assert.equal(formatSleepTimerMMSS(timer.remainingMs), '90:00');

  // Also handles 120:00 formatting cleanly
  const maxTimer = startOrSelectSleepTimer(120, true, t1);
  assert.equal(formatSleepTimerMMSS(maxTimer.remainingMs), '120:00');
});

test('cancelling sleep timer resets to idle and prevents expiry or reactivation', () => {
  const t0 = 50_000;
  const running = startOrSelectSleepTimer(15, true, t0);
  const cancelled = cancelSleepTimer();

  assert.equal(running.status, 'running');
  assert.equal(cancelled.status, 'idle');
  assert.equal(cancelled.deadlineMs, null);
  assert.equal(computeSleepTimerRemainingMs(cancelled, t0 + 20 * 60_000), 0);

  const tick = syncSleepTimerTick(cancelled, t0 + 20 * 60_000);
  assert.equal(tick.expired, false);
  assert.equal(tick.next.status, 'idle');

  // Re-activating playback after cancel does NOT reactivate cancelled timer
  const afterRestart = activateArmedSleepTimer(cancelled, t0 + 25 * 60_000);
  assert.equal(afterRestart.status, 'idle');
});

test('arming timer in Standby starts countdown once playback begins and stays idle when cancelled', () => {
  const t0 = 100_000;
  const armed = startOrSelectSleepTimer(45, false, t0);
  assert.equal(armed.status, 'armed');
  assert.equal(armed.deadlineMs, null);
  assert.equal(formatSleepTimerMMSS(armed.remainingMs), '45:00');

  // Ticking while armed does not expire or decrement before audio starts
  const armedTick = syncSleepTimerTick(armed, t0 + 60_000);
  assert.equal(armedTick.expired, false);
  assert.equal(armedTick.next.status, 'armed');

  // Starting audio activates armed timer with fresh deadline
  const tPlay = t0 + 60_000;
  const started = activateArmedSleepTimer(armed, tPlay);
  assert.equal(started.status, 'running');
  assert.equal(started.deadlineMs, tPlay + 45 * 60_000);
  assert.equal(formatSleepTimerMMSS(started.remainingMs), '45:00');

  // Initial state remains idle on playback start
  const initial = createInitialSleepTimerState();
  assert.equal(activateArmedSleepTimer(initial, tPlay).status, 'idle');
});
