export type HullStructuralKind = 'creak' | 'groan' | 'heavy-flex';

export const HULL_TIMING_SPEC = {
  creak: {
    initialDelayMinMs: 3_500,
    initialDelayMaxMs: 8_500,
    intervalMinMs: 15_000,
    intervalMaxMs: 35_000,
    cooldownMs: 14_000,
    durationMinSec: 2.0,
    durationMaxSec: 5.0,
  },
  groan: {
    initialDelayMinMs: 14_000,
    initialDelayMaxMs: 26_000,
    intervalMinMs: 45_000,
    intervalMaxMs: 90_000,
    cooldownMs: 42_000,
    durationMinSec: 4.0,
    durationMaxSec: 9.0,
  },
  heavyFlex: {
    intervalMinMs: 180_000,
    intervalMaxMs: 360_000,
    cooldownMs: 175_000,
    durationMinSec: 7.0,
    durationMaxSec: 12.0,
  },
  interEventBufferMs: 2_500,
} as const;

export interface HullScheduleState {
  nextCreakAtMs: number;
  nextGroanAtMs: number;
  nextHeavyFlexAtMs: number;
  lastCreakAtMs: number;
  lastGroanAtMs: number;
  lastHeavyFlexAtMs: number;
  activeUntilMs: number;
}

export interface HullCreakParams {
  durationSec: number;
  baseFreq: number;
  bendMidDelta: number;
  bendLateDelta: number;
  bendEndDelta: number;
  peakGain: number;
  attackRatio: number;
  grainRateHz: number;
  grainDepthHz: number;
  bandpassQ: number;
}

export interface HullGroanParams {
  durationSec: number;
  rootFreq: number;
  bendMidDelta: number;
  bendLateDelta: number;
  bendEndDelta: number;
  peakGain: number;
  attackRatio: number;
  attachSecondaryCreak: boolean;
  secondaryCreakDelaySec: number;
}

export interface HullHeavyFlexParams {
  durationSec: number;
  rootFreq: number;
  bendMidDelta: number;
  bendLateDelta: number;
  bendEndDelta: number;
  peakGain: number;
  attackRatio: number;
}

export type HullScheduleStepResult =
  | {
      kind: null;
      nextSchedule: HullScheduleState;
    }
  | {
      kind: 'creak';
      params: HullCreakParams;
      nextSchedule: HullScheduleState;
    }
  | {
      kind: 'groan';
      params: HullGroanParams;
      secondaryCreakParams: HullCreakParams | null;
      nextSchedule: HullScheduleState;
    }
  | {
      kind: 'heavy-flex';
      params: HullHeavyFlexParams;
      nextSchedule: HullScheduleState;
    };

function randomRange(min: number, max: number, randomFn: () => number): number {
  return min + randomFn() * (max - min);
}

export function createInitialHullSchedule(
  nowMs: number,
  randomFn: () => number = Math.random,
): HullScheduleState {
  return {
    nextCreakAtMs:
      nowMs +
      randomRange(
        HULL_TIMING_SPEC.creak.initialDelayMinMs,
        HULL_TIMING_SPEC.creak.initialDelayMaxMs,
        randomFn,
      ),
    nextGroanAtMs:
      nowMs +
      randomRange(
        HULL_TIMING_SPEC.groan.initialDelayMinMs,
        HULL_TIMING_SPEC.groan.initialDelayMaxMs,
        randomFn,
      ),
    nextHeavyFlexAtMs:
      nowMs +
      randomRange(
        HULL_TIMING_SPEC.heavyFlex.intervalMinMs,
        HULL_TIMING_SPEC.heavyFlex.intervalMaxMs,
        randomFn,
      ),
    lastCreakAtMs: -Infinity,
    lastGroanAtMs: -Infinity,
    lastHeavyFlexAtMs: -Infinity,
    activeUntilMs: 0,
  };
}

/**
 * Re-anchors overdue scheduled timestamps after tab return so backgrounded tabs
 * never unleash a backlog of queued hull creaks/groans all at once.
 */
export function reanchorHullScheduleAfterResume(
  schedule: HullScheduleState,
  nowMs: number,
  randomFn: () => number = Math.random,
): HullScheduleState {
  const minSafe = Math.max(nowMs + 1_200, schedule.activeUntilMs + HULL_TIMING_SPEC.interEventBufferMs);
  return {
    ...schedule,
    nextCreakAtMs:
      schedule.nextCreakAtMs <= minSafe
        ? minSafe + randomRange(1_200, 4_800, randomFn)
        : schedule.nextCreakAtMs,
    nextGroanAtMs:
      schedule.nextGroanAtMs <= minSafe
        ? minSafe + randomRange(5_000, 14_000, randomFn)
        : schedule.nextGroanAtMs,
    nextHeavyFlexAtMs:
      schedule.nextHeavyFlexAtMs <= minSafe
        ? minSafe + randomRange(25_000, 75_000, randomFn)
        : schedule.nextHeavyFlexAtMs,
  };
}

export function getNextHullWakeDelayMs(
  schedule: HullScheduleState,
  nowMs: number,
): number {
  const earliestEvent = Math.min(
    schedule.nextCreakAtMs,
    schedule.nextGroanAtMs,
    schedule.nextHeavyFlexAtMs,
  );
  const earliestAllowed = schedule.activeUntilMs + HULL_TIMING_SPEC.interEventBufferMs;
  const targetMs = Math.max(earliestEvent, earliestAllowed);
  return Math.max(250, Math.round(targetMs - nowMs));
}

export function sampleHullCreakParams(
  isSecondary = false,
  randomFn: () => number = Math.random,
): HullCreakParams {
  const durationSec = isSecondary
    ? randomRange(2.0, 3.6, randomFn)
    : randomRange(
        HULL_TIMING_SPEC.creak.durationMinSec,
        HULL_TIMING_SPEC.creak.durationMaxSec,
        randomFn,
      );
  const baseFreq = randomRange(96, 168, randomFn);
  const direction = randomFn() < 0.5 ? -1 : 1;
  const span = randomRange(5.5, 13.5, randomFn);

  return {
    durationSec,
    baseFreq,
    // Slow uneven frequency bending (rise/sag, slip, settle)
    bendMidDelta: direction * span * randomRange(0.45, 0.85, randomFn),
    bendLateDelta: direction * span * randomRange(0.15, 1.15, randomFn),
    bendEndDelta: direction * span * randomRange(0.6, 1.0, randomFn),
    peakGain: isSecondary
      ? randomRange(0.048, 0.068, randomFn)
      : randomRange(0.088, 0.128, randomFn),
    attackRatio: randomRange(0.32, 0.46, randomFn),
    grainRateHz: randomRange(9.5, 16.5, randomFn),
    grainDepthHz: randomRange(1.8, 3.4, randomFn),
    bandpassQ: randomRange(2.9, 3.9, randomFn),
  };
}

export function sampleHullGroanParams(
  randomFn: () => number = Math.random,
): HullGroanParams {
  const durationSec = randomRange(
    HULL_TIMING_SPEC.groan.durationMinSec,
    HULL_TIMING_SPEC.groan.durationMaxSec,
    randomFn,
  );
  const rootFreq = randomRange(46, 72, randomFn);
  const bendMag = randomRange(1.8, 4.4, randomFn);
  const attachSecondaryCreak = randomFn() < 0.38;

  return {
    durationSec,
    rootFreq,
    bendMidDelta: randomRange(-0.4, 0.9, randomFn),
    bendLateDelta: -bendMag * randomRange(0.65, 1.0, randomFn),
    bendEndDelta: -bendMag * randomRange(0.85, 1.25, randomFn),
    peakGain: randomRange(0.125, 0.17, randomFn),
    attackRatio: randomRange(0.3, 0.42, randomFn),
    attachSecondaryCreak,
    secondaryCreakDelaySec: attachSecondaryCreak
      ? randomRange(1.1, Math.min(2.8, durationSec * 0.42), randomFn)
      : 0,
  };
}

export function sampleHullHeavyFlexParams(
  randomFn: () => number = Math.random,
): HullHeavyFlexParams {
  const durationSec = randomRange(
    HULL_TIMING_SPEC.heavyFlex.durationMinSec,
    HULL_TIMING_SPEC.heavyFlex.durationMaxSec,
    randomFn,
  );
  const rootFreq = randomRange(36, 54, randomFn);
  const bendMag = randomRange(2.2, 4.8, randomFn);

  return {
    durationSec,
    rootFreq,
    bendMidDelta: randomRange(0.5, 1.6, randomFn),
    bendLateDelta: -bendMag * randomRange(0.7, 1.05, randomFn),
    bendEndDelta: -bendMag * randomRange(0.95, 1.3, randomFn),
    peakGain: randomRange(0.14, 0.19, randomFn),
    attackRatio: randomRange(0.32, 0.42, randomFn),
  };
}

export function evaluateHullScheduleStep(
  schedule: HullScheduleState,
  nowMs: number,
  randomFn: () => number = Math.random,
): HullScheduleStepResult {
  const quietUntilMs = schedule.activeUntilMs + HULL_TIMING_SPEC.interEventBufferMs;
  if (nowMs < quietUntilMs) {
    return {
      kind: null,
      nextSchedule: {
        ...schedule,
        nextCreakAtMs: Math.max(schedule.nextCreakAtMs, quietUntilMs),
        nextGroanAtMs: Math.max(schedule.nextGroanAtMs, quietUntilMs),
        nextHeavyFlexAtMs: Math.max(schedule.nextHeavyFlexAtMs, quietUntilMs),
      },
    };
  }

  const flexEligible =
    nowMs >= schedule.nextHeavyFlexAtMs &&
    nowMs - schedule.lastHeavyFlexAtMs >= HULL_TIMING_SPEC.heavyFlex.cooldownMs;
  const groanEligible =
    nowMs >= schedule.nextGroanAtMs &&
    nowMs - schedule.lastGroanAtMs >= HULL_TIMING_SPEC.groan.cooldownMs;
  const creakEligible =
    nowMs >= schedule.nextCreakAtMs &&
    nowMs - schedule.lastCreakAtMs >= HULL_TIMING_SPEC.creak.cooldownMs;

  if (!flexEligible && !groanEligible && !creakEligible) {
    return {
      kind: null,
      nextSchedule: {
        ...schedule,
        nextCreakAtMs: Math.max(
          schedule.nextCreakAtMs,
          schedule.lastCreakAtMs + HULL_TIMING_SPEC.creak.cooldownMs,
        ),
        nextGroanAtMs: Math.max(
          schedule.nextGroanAtMs,
          schedule.lastGroanAtMs + HULL_TIMING_SPEC.groan.cooldownMs,
        ),
        nextHeavyFlexAtMs: Math.max(
          schedule.nextHeavyFlexAtMs,
          schedule.lastHeavyFlexAtMs + HULL_TIMING_SPEC.heavyFlex.cooldownMs,
        ),
      },
    };
  }

  if (flexEligible) {
    const params = sampleHullHeavyFlexParams(randomFn);
    const activeUntilMs = nowMs + params.durationSec * 1000 + 1_200; // includes opposite-bulkhead resonance tail
    const deferUntil = activeUntilMs + HULL_TIMING_SPEC.interEventBufferMs;
    return {
      kind: 'heavy-flex',
      params,
      nextSchedule: {
        ...schedule,
        lastHeavyFlexAtMs: nowMs,
        nextHeavyFlexAtMs:
          nowMs +
          randomRange(
            HULL_TIMING_SPEC.heavyFlex.intervalMinMs,
            HULL_TIMING_SPEC.heavyFlex.intervalMaxMs,
            randomFn,
          ),
        nextGroanAtMs: Math.max(
          schedule.nextGroanAtMs,
          deferUntil + randomRange(4_000, 12_000, randomFn),
        ),
        nextCreakAtMs: Math.max(
          schedule.nextCreakAtMs,
          deferUntil + randomRange(2_000, 7_000, randomFn),
        ),
        activeUntilMs,
      },
    };
  }

  if (groanEligible) {
    const params = sampleHullGroanParams(randomFn);
    const secondaryCreakParams = params.attachSecondaryCreak
      ? sampleHullCreakParams(true, randomFn)
      : null;
    const secondaryEndSec = secondaryCreakParams
      ? params.secondaryCreakDelaySec + secondaryCreakParams.durationSec
      : 0;
    const totalDurationSec = Math.max(params.durationSec + 0.55, secondaryEndSec);
    const activeUntilMs = nowMs + totalDurationSec * 1000;
    const deferUntil = activeUntilMs + HULL_TIMING_SPEC.interEventBufferMs;

    return {
      kind: 'groan',
      params,
      secondaryCreakParams,
      nextSchedule: {
        ...schedule,
        lastGroanAtMs: nowMs,
        nextGroanAtMs:
          nowMs +
          randomRange(
            HULL_TIMING_SPEC.groan.intervalMinMs,
            HULL_TIMING_SPEC.groan.intervalMaxMs,
            randomFn,
          ),
        nextCreakAtMs: Math.max(
          schedule.nextCreakAtMs,
          deferUntil + randomRange(1_500, 6_000, randomFn),
        ),
        nextHeavyFlexAtMs: Math.max(schedule.nextHeavyFlexAtMs, deferUntil),
        activeUntilMs,
      },
    };
  }

  const params = sampleHullCreakParams(false, randomFn);
  const activeUntilMs = nowMs + params.durationSec * 1000;
  const deferUntil = activeUntilMs + HULL_TIMING_SPEC.interEventBufferMs;
  return {
    kind: 'creak',
    params,
    nextSchedule: {
      ...schedule,
      lastCreakAtMs: nowMs,
      nextCreakAtMs:
        nowMs +
        randomRange(
          HULL_TIMING_SPEC.creak.intervalMinMs,
          HULL_TIMING_SPEC.creak.intervalMaxMs,
          randomFn,
        ),
      nextGroanAtMs: Math.max(schedule.nextGroanAtMs, deferUntil),
      nextHeavyFlexAtMs: Math.max(schedule.nextHeavyFlexAtMs, deferUntil),
      activeUntilMs,
    },
  };
}
