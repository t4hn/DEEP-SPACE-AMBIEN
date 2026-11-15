import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HULL_TIMING_SPEC,
  createInitialHullSchedule,
  evaluateHullScheduleStep,
  getNextHullWakeDelayMs,
  reanchorHullScheduleAfterResume,
  sampleHullCreakParams,
  sampleHullGroanParams,
  sampleHullHeavyFlexParams,
} from './hullScheduler';

test('CH-06 hull creak, groan, and heavy flex parameters obey physical ranges and uneven bends', () => {
  for (let i = 0; i < 40; i += 1) {
    const r = ((i * 37) % 100) / 100;
    const rng = () => r;

    const creak = sampleHullCreakParams(false, rng);
    assert.ok(creak.durationSec >= 2.0 && creak.durationSec <= 5.0);
    assert.ok(creak.baseFreq >= 90 && creak.baseFreq <= 180);
    assert.ok(creak.peakGain >= 0.08 && creak.peakGain <= 0.14);
    assert.ok(creak.grainRateHz >= 9 && creak.grainRateHz <= 17);

    const groan = sampleHullGroanParams(rng);
    assert.ok(groan.durationSec >= 4.0 && groan.durationSec <= 9.0);
    assert.ok(groan.rootFreq >= 45 && groan.rootFreq <= 75);
    assert.ok(groan.peakGain >= 0.12 && groan.peakGain <= 0.18);
    if (groan.attachSecondaryCreak) {
      assert.ok(groan.secondaryCreakDelaySec >= 1.0 && groan.secondaryCreakDelaySec <= 3.0);
    }

    const flex = sampleHullHeavyFlexParams(rng);
    assert.ok(flex.durationSec >= 7.0 && flex.durationSec <= 12.0);
    assert.ok(flex.rootFreq >= 35 && flex.rootFreq <= 56);
    assert.ok(flex.peakGain >= 0.13 && flex.peakGain <= 0.2);
  }
});

test('independent CH-06 scheduling respects 15-35s creaks, 45-90s groans, 3-6m heavy flexes, cooldowns, and zero overlap', () => {
  let seed = 17;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  let nowMs = 1_000_000;
  let schedule = createInitialHullSchedule(nowMs, rng);

  const creakTimes: number[] = [];
  const groanTimes: number[] = [];
  const flexTimes: number[] = [];
  let pairedSecondaryCount = 0;

  // Simulate 25 minutes of operational hull activity
  const endMs = nowMs + 25 * 60 * 1000;
  while (nowMs < endMs) {
    const stepDelay = getNextHullWakeDelayMs(schedule, nowMs);
    assert.ok(stepDelay >= 250);
    nowMs += stepDelay;

    const prevActiveUntil = schedule.activeUntilMs;
    const step = evaluateHullScheduleStep(schedule, nowMs, rng);
    schedule = step.nextSchedule;

    if (step.kind !== null) {
      // Never overlap a newly triggered sound with an active prominent structural sound + buffer
      assert.ok(
        nowMs >= prevActiveUntil + HULL_TIMING_SPEC.interEventBufferMs,
        `Event ${step.kind} fired before previous sound finished + buffer`,
      );
    }

    if (step.kind === 'creak') {
      creakTimes.push(nowMs);
    } else if (step.kind === 'groan') {
      groanTimes.push(nowMs);
      if (step.secondaryCreakParams) {
        pairedSecondaryCount += 1;
      }
    } else if (step.kind === 'heavy-flex') {
      flexTimes.push(nowMs);
    }
  }

  // Over 25 minutes we should observe frequent creaks, regular groans, and several rare heavy flexes
  assert.ok(creakTimes.length >= 25, `Expected frequent creaks, got ${creakTimes.length}`);
  assert.ok(groanTimes.length >= 10, `Expected periodic groans, got ${groanTimes.length}`);
  assert.ok(flexTimes.length >= 3 && flexTimes.length <= 10, `Expected rare heavy flexes, got ${flexTimes.length}`);
  assert.ok(pairedSecondaryCount >= 1, 'Expected at least one groan paired with a faint secondary creak');

  for (let i = 1; i < creakTimes.length; i += 1) {
    assert.ok(creakTimes[i] - creakTimes[i - 1] >= HULL_TIMING_SPEC.creak.cooldownMs);
  }
  for (let i = 1; i < groanTimes.length; i += 1) {
    assert.ok(groanTimes[i] - groanTimes[i - 1] >= HULL_TIMING_SPEC.groan.cooldownMs);
  }
  for (let i = 1; i < flexTimes.length; i += 1) {
    assert.ok(flexTimes[i] - flexTimes[i - 1] >= HULL_TIMING_SPEC.heavyFlex.cooldownMs);
  }
});

test('reanchorHullScheduleAfterResume prevents burst firing when returning from a backgrounded tab', () => {
  const startMs = 10_000;
  const initial = createInitialHullSchedule(startMs, () => 0.5);

  // Tab returns 10 minutes later — all three timers would otherwise be overdue
  const resumeMs = startMs + 600_000;
  const reanchored = reanchorHullScheduleAfterResume(initial, resumeMs, () => 0.5);

  assert.ok(reanchored.nextCreakAtMs > resumeMs + 1_000);
  assert.ok(reanchored.nextGroanAtMs > resumeMs + 4_500);
  assert.ok(reanchored.nextHeavyFlexAtMs > resumeMs + 20_000);
});
