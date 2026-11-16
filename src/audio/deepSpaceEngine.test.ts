import assert from 'node:assert/strict';
import test from 'node:test';
import { getAcousticProfile } from './acousticProfiles';
import { createCustomSoundscape } from './customSoundscapes';
import { DeepSpaceEngine } from './deepSpaceEngine';
import { createInitialMixerState, mixerReducer } from './mixerState';
import { CHANNEL_SPATIAL_PROFILES } from './spatialLayout';

class MockAudioParam {
  public value: number;
  public calls: Array<{ method: string; args: number[] }> = [];

  constructor(initial = 0) {
    this.value = initial;
  }

  public setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.calls.push({ method: 'setValueAtTime', args: [value, time] });
  }

  public linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.calls.push({ method: 'linearRampToValueAtTime', args: [value, time] });
  }

  public exponentialRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.calls.push({ method: 'exponentialRampToValueAtTime', args: [value, time] });
  }

  public setTargetAtTime(target: number, startTime: number, timeConstant: number): void {
    this.value = target;
    this.calls.push({ method: 'setTargetAtTime', args: [target, startTime, timeConstant] });
  }

  public cancelScheduledValues(time: number): void {
    this.calls.push({ method: 'cancelScheduledValues', args: [time] });
  }
}

class MockAudioNode {
  public connections: MockAudioNode[] = [];
  public disconnected = false;
  public disconnectCount = 0;

  public connect(dest: MockAudioNode): MockAudioNode {
    this.connections.push(dest);
    return dest;
  }

  public disconnect(): void {
    this.disconnected = true;
    this.disconnectCount += 1;
    this.connections = [];
  }
}

class MockGainNode extends MockAudioNode {
  public gain = new MockAudioParam(1);
}

class MockBiquadFilterNode extends MockAudioNode {
  public type: BiquadFilterType = 'lowpass';
  public frequency = new MockAudioParam(350);
  public Q = new MockAudioParam(1);
  public gain = new MockAudioParam(0);
}

class MockDelayNode extends MockAudioNode {
  public delayTime = new MockAudioParam(0);
}

class MockChannelMergerNode extends MockAudioNode {}

class MockDynamicsCompressorNode extends MockAudioNode {
  public threshold = new MockAudioParam(-24);
  public knee = new MockAudioParam(30);
  public ratio = new MockAudioParam(12);
  public attack = new MockAudioParam(0.003);
  public release = new MockAudioParam(0.25);
}

class MockAnalyserNode extends MockAudioNode {
  public fftSize = 2048;
  public smoothingTimeConstant = 0.8;

  public getFloatTimeDomainData(array: Float32Array): void {
    array.fill(0);
  }
}

class MockPannerNode extends MockAudioNode {
  public distanceModel: DistanceModelType = 'inverse';
  public panningModel: PanningModelType = 'HRTF';
  public refDistance = 1;
  public maxDistance = 10000;
  public rolloffFactor = 1;
  public coneInnerAngle = 360;
  public coneOuterAngle = 360;
  public coneOuterGain = 0;
  public positionX = new MockAudioParam(0);
  public positionY = new MockAudioParam(0);
  public positionZ = new MockAudioParam(0);
}

class MockOscillatorNode extends MockAudioNode {
  public type: OscillatorType = 'sine';
  public frequency = new MockAudioParam(440);
  public onended: (() => void) | null = null;
  public stopped = false;

  public start(): void {}

  public stop(): void {
    this.stopped = true;
  }
}

class MockBufferSourceNode extends MockAudioNode {
  public buffer: AudioBuffer | null = null;
  public loop = false;
  public onended: (() => void) | null = null;
  public stopped = false;

  public start(): void {}

  public stop(): void {
    this.stopped = true;
  }
}

class MockAudioBuffer {
  public length: number;
  public sampleRate: number;
  private channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  public getChannelData(ch: number): Float32Array {
    return this.channels[ch];
  }
}

class MockAudioContext {
  public static instances: MockAudioContext[] = [];

  public sampleRate = 48000;
  public currentTime = 1.0;
  public state: AudioContextState = 'running';
  public destination = new MockAudioNode();
  public listener = {
    positionX: new MockAudioParam(0),
    positionY: new MockAudioParam(0),
    positionZ: new MockAudioParam(0),
    forwardX: new MockAudioParam(0),
    forwardY: new MockAudioParam(0),
    forwardZ: new MockAudioParam(-1),
    upX: new MockAudioParam(0),
    upY: new MockAudioParam(1),
    upZ: new MockAudioParam(0),
  };
  public onstatechange: (() => void) | null = null;

  public nodes: MockAudioNode[] = [];
  public panners: MockPannerNode[] = [];
  public delays: MockDelayNode[] = [];
  public biquads: MockBiquadFilterNode[] = [];
  public closed = false;

  constructor() {
    MockAudioContext.instances.push(this);
  }

  private track<T extends MockAudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  public createGain(): MockGainNode {
    return this.track(new MockGainNode());
  }

  public createBiquadFilter(): MockBiquadFilterNode {
    const bq = this.track(new MockBiquadFilterNode());
    this.biquads.push(bq);
    return bq;
  }

  public createDelay(): MockDelayNode {
    const d = this.track(new MockDelayNode());
    this.delays.push(d);
    return d;
  }

  public createChannelMerger(): MockChannelMergerNode {
    return this.track(new MockChannelMergerNode());
  }

  public createDynamicsCompressor(): MockDynamicsCompressorNode {
    return this.track(new MockDynamicsCompressorNode());
  }

  public createAnalyser(): MockAnalyserNode {
    return this.track(new MockAnalyserNode());
  }

  public createPanner(): MockPannerNode {
    const p = this.track(new MockPannerNode());
    this.panners.push(p);
    return p;
  }

  public createOscillator(): MockOscillatorNode {
    return this.track(new MockOscillatorNode());
  }

  public createBufferSource(): MockBufferSourceNode {
    return this.track(new MockBufferSourceNode());
  }

  public createBuffer(channels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(channels, length, sampleRate);
  }

  public async resume(): Promise<void> {
    this.state = 'running';
  }

  public async suspend(): Promise<void> {
    this.state = 'suspended';
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
  }
}

function installMockWindow() {
  MockAudioContext.instances = [];
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const mockWindow = {
    AudioContext: MockAudioContext,
    location: { search: '' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as Record<string, unknown>).window = mockWindow;

  return () => {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  };
}

test('pre-start profile selection does not allocate AudioContext and initializes directly in chosen profile', async () => {
  const restore = installMockWindow();
  const engine = new DeepSpaceEngine();
  try {
    let state = createInitialMixerState();
    await engine.syncState(state);
    assert.equal(MockAudioContext.instances.length, 0);

    // Switch acoustic profile while in Standby
    state = mixerReducer(state, {
      type: 'SELECT_ACOUSTIC_PROFILE',
      profileId: 'observation-deck',
    });
    await engine.syncState(state);
    assert.equal(MockAudioContext.instances.length, 0);

    // Start playback
    engine.unlockFromGesture();
    state = mixerReducer(state, { type: 'PLAY_ALL' });
    await engine.syncState(state);

    assert.equal(MockAudioContext.instances.length, 1);
    const ctx = MockAudioContext.instances[0];
    assert.equal(ctx.panners.length, 6);

    const obs = getAcousticProfile('observation-deck');
    // Check reflection delays initialized directly to Observation Deck timing
    assert.equal(ctx.delays.length, 2);
    assert.equal(ctx.delays[0].delayTime.value, obs.reflection.delayLeftSec);
    assert.equal(ctx.delays[1].delayTime.value, obs.reflection.delayRightSec);

    // Reactor bed PannerNode initialized with Observation Deck offset
    const reactorBaseZ = CHANNEL_SPATIAL_PROFILES.reactor.position.z;
    assert.equal(
      ctx.panners[0].positionZ.value,
      reactorBaseZ + obs.channels.reactor.positionOffset.z,
    );
  } finally {
    engine.dispose();
    restore();
  }
});

test('switching acoustic profiles while active updates parameters smoothly without recreating AudioContext or PannerNodes', async () => {
  const restore = installMockWindow();
  const engine = new DeepSpaceEngine();
  try {
    let state = createInitialMixerState();
    engine.unlockFromGesture();
    state = mixerReducer(state, { type: 'PLAY_ALL' });
    await engine.syncState(state);

    assert.equal(MockAudioContext.instances.length, 1);
    const ctx = MockAudioContext.instances[0];
    const initialPannerRefs = [...ctx.panners];
    assert.equal(initialPannerRefs.length, 6);

    for (const profileId of [
      'engine-room',
      'observation-deck',
      'research-lab',
      'bridge',
    ] as const) {
      ctx.currentTime += 1.0;
      state = mixerReducer(state, { type: 'SELECT_ACOUSTIC_PROFILE', profileId });
      await engine.syncState(state);

      assert.equal(MockAudioContext.instances.length, 1);
      assert.equal(ctx.panners.length, 6);
      assert.deepEqual(ctx.panners, initialPannerRefs);

      const profile = getAcousticProfile(profileId);
      assert.equal(ctx.delays[0].delayTime.value, profile.reflection.delayLeftSec);
      assert.equal(ctx.delays[1].delayTime.value, profile.reflection.delayRightSec);

      const reactorBaseZ = CHANNEL_SPATIAL_PROFILES.reactor.position.z;
      assert.equal(
        ctx.panners[0].positionZ.value,
        reactorBaseZ + profile.channels.reactor.positionOffset.z,
      );
    }
  } finally {
    engine.dispose();
    restore();
  }
});

test('dispose disconnects every created audio node including reflection bus and closes AudioContext', async () => {
  const restore = installMockWindow();
  const engine = new DeepSpaceEngine();
  try {
    let state = createInitialMixerState();
    engine.unlockFromGesture();
    state = mixerReducer(state, { type: 'PLAY_ALL' });
    await engine.syncState(state);

    const ctx = MockAudioContext.instances[0];
    assert.ok(ctx.nodes.length > 30);

    engine.dispose();

    assert.equal(ctx.closed, true);
    const leaked = ctx.nodes.filter((n) => !n.disconnected);
    assert.equal(leaked.length, 0, `Expected 0 leaked nodes, found ${leaked.length}`);
  } finally {
    restore();
  }
});

test('switching acoustic profiles does not interfere with Ambient Events scheduling state or trigger premature events', async () => {
  const restore = installMockWindow();
  const triggered: unknown[] = [];
  const engine = new DeepSpaceEngine({
    onAmbientEvent: (ev) => triggered.push(ev),
  });
  try {
    let state = createInitialMixerState();
    engine.unlockFromGesture();
    state = mixerReducer(state, { type: 'PLAY_ALL' });
    state = mixerReducer(state, { type: 'TOGGLE_AMBIENT_EVENTS' });
    await engine.syncState(state);

    state = mixerReducer(state, {
      type: 'SELECT_ACOUSTIC_PROFILE',
      profileId: 'research-lab',
    });
    await engine.syncState(state);

    assert.equal(state.ambientEventsEnabled, true);
    assert.equal(state.isActive, true);
    assert.equal(triggered.length, 0);
  } finally {
    engine.dispose();
    restore();
  }
});

test('CH-06 hull creaks & groans run when CH-06 is enabled with Ambient Events OFF, stop immediately on disable/Stop All, and pause when backgrounded', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevDoc = (globalThis as Record<string, unknown>).document;
  const prevDateNow = Date.now;

  let fakeNowMs = 1_000_000;
  Date.now = () => fakeNowMs;

  let nextTimerId = 1;
  const timers = new Map<number, { fn: () => void; delay: number }>();
  const clearedIds: number[] = [];
  const docListeners: Record<string, Array<() => void>> = {};
  const mockDoc = {
    hidden: false,
    addEventListener: (ev: string, cb: () => void) => {
      docListeners[ev] = docListeners[ev] ?? [];
      docListeners[ev].push(cb);
    },
    removeEventListener: (ev: string, cb: () => void) => {
      docListeners[ev] = (docListeners[ev] ?? []).filter((fn) => fn !== cb);
    },
  };

  MockAudioContext.instances = [];
  (globalThis as Record<string, unknown>).document = mockDoc;
  (globalThis as Record<string, unknown>).window = {
    AudioContext: MockAudioContext,
    location: { search: '' },
    setTimeout: (fn: () => void, delay = 0) => {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      clearedIds.push(id);
      timers.delete(id);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const triggeredEvents: unknown[] = [];
  const engine = new DeepSpaceEngine({
    onAmbientEvent: (ev) => triggeredEvents.push(ev),
  });

  try {
    let state = createInitialMixerState();
    assert.equal(state.ambientEventsEnabled, false);

    // Enable ONLY CH-06 Hull while Ambient Events remain OFF
    engine.unlockFromGesture();
    state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'hull' });
    await engine.syncState(state);

    const ctx = MockAudioContext.instances[0];
    assert.equal(ctx.panners.length, 6);
    const hullTimersBefore = [...timers.entries()].filter(([, t]) => t.delay !== 3000);
    assert.equal(hullTimersBefore.length, 1, 'Expected one active CH-06 hull scheduler timer');

    const [firstTimerId, firstTimer] = hullTimersBefore[0];
    const initialNodeCount = ctx.nodes.length;

    // Advance fake clock past initial creak delay and fire timer
    fakeNowMs += firstTimer.delay + 50;
    timers.delete(firstTimerId);
    firstTimer.fn();

    // Creak spawned transient oscillators + HRTF panner with Ambient Events completely OFF
    assert.ok(ctx.nodes.length > initialNodeCount, 'Expected CH-06 creak nodes to be created');
    assert.ok(ctx.panners.length > 6, 'Expected spatialized creak PannerNode');
    assert.equal(triggeredEvents.length, 0);
    const hullTimersAfterCreak = [...timers.entries()].filter(([, t]) => t.delay !== 3000);
    assert.equal(hullTimersAfterCreak.length, 1, 'Expected next CH-06 wakeup timer to be scheduled');

    const transientNodes = ctx.nodes.slice(initialNodeCount);

    // Backgrounding the tab must clear pending hull timer and stop active transient voices
    mockDoc.hidden = true;
    for (const cb of docListeners.visibilitychange ?? []) cb();
    assert.equal(
      [...timers.values()].filter((t) => t.delay !== 3000).length,
      0,
      'Expected pending CH-06 timer cleared when tab hidden',
    );
    for (const node of transientNodes) {
      if (node instanceof MockOscillatorNode) {
        assert.equal(node.stopped, true);
      }
    }

    // Returning to tab re-schedules CH-06 cleanly without firing an immediate burst
    mockDoc.hidden = false;
    fakeNowMs += 120_000;
    for (const cb of docListeners.visibilitychange ?? []) cb();
    const hullTimersResumed = [...timers.entries()].filter(([, t]) => t.delay !== 3000);
    assert.equal(hullTimersResumed.length, 1, 'Expected CH-06 timer re-scheduled on visibility return');
    const [resumedId, resumedTimer] = hullTimersResumed[0];
    assert.ok(resumedTimer.delay >= 1_000, 'Expected re-anchored delay instead of immediate burst');

    // Enabling Reactor alongside Hull keeps audio active; turning Hull OFF clears its timer immediately
    state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'reactor' });
    await engine.syncState(state);
    state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'hull' });
    await engine.syncState(state);
    assert.equal(timers.has(resumedId), false, 'Expected CH-06 timer cleared immediately on channel disable');
    assert.ok(clearedIds.includes(resumedId));

    // Turning Reactor (last active channel) OFF schedules fade-out and leaves 0 timers once completed
    const idsBeforeStop = new Set(timers.keys());
    state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'reactor' });
    await engine.syncState(state);
    const fadeOutIds = [...timers.keys()].filter((id) => !idsBeforeStop.has(id));
    assert.equal(fadeOutIds.length, 1, 'Expected fade-out timer when last channel disables');
    const fadeOutTimer = timers.get(fadeOutIds[0])!;
    timers.delete(fadeOutIds[0]);
    fadeOutTimer.fn();
    assert.equal(timers.size, 0, 'Expected 0 timers remaining after fade-out completes');
  } finally {
    engine.dispose();
    Date.now = prevDateNow;
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
    if (prevDoc === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = prevDoc;
    }
  }
});

test('fade-in ramps transitionGain over 3s without altering masterGain and does not re-trigger on additional channels', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  let nextTimerId = 1;
  const timers = new Map<number, { fn: () => void; delay: number }>();

  MockAudioContext.instances = [];
  (globalThis as Record<string, unknown>).window = {
    AudioContext: MockAudioContext,
    location: { search: '' },
    setTimeout: (fn: () => void, delay = 0) => {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const phases: string[] = [];
  const engine = new DeepSpaceEngine({
    onPlaybackPhaseChange: (phase) => phases.push(phase),
  });

  try {
    let state = createInitialMixerState();
    engine.unlockFromGesture();
    state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'reactor' });
    await engine.syncState(state);

    const ctx = MockAudioContext.instances[0];
    // masterGain is node 0, transitionGain is node 1, compressor is node 2
    const masterGain = ctx.nodes[0] as MockGainNode;
    const transitionGain = ctx.nodes[1] as MockGainNode;
    assert.ok(masterGain.connections.includes(transitionGain));

    assert.equal(engine.getPlaybackPhase(), 'fading-in');
    assert.deepEqual(phases, ['fading-in']);
    const fadeInRamp = transitionGain.gain.calls.find(
      (c) => c.method === 'linearRampToValueAtTime' && c.args[0] === 1,
    );
    assert.ok(fadeInRamp, 'Expected transitionGain linearRampToValueAtTime(1, now + 3)');
    assert.equal(fadeInRamp.args[1], ctx.currentTime + 3);

    // Master volume slider stays strictly on masterGain, never overwritten to 0 or 1 by fade
    const masterTargetCall = masterGain.gain.calls.find(
      (c) => c.method === 'setTargetAtTime',
    );
    assert.ok(masterTargetCall && masterTargetCall.args[0] > 0 && masterTargetCall.args[0] < 1);

    const callsBeforeSecondChannel = transitionGain.gain.calls.length;

    // Enabling a second channel during fade-in or active playback must NOT restart fade-in
    ctx.currentTime += 1.0;
    state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'engines' });
    await engine.syncState(state);
    assert.equal(transitionGain.gain.calls.length, callsBeforeSecondChannel);

    // Complete 3s fade-in timer -> transitions cleanly to active
    const fadeTimer = [...timers.entries()].find(([, t]) => t.delay === 3000);
    assert.ok(fadeTimer);
    timers.delete(fadeTimer[0]);
    fadeTimer[1].fn();
    assert.equal(engine.getPlaybackPhase(), 'active');
    assert.deepEqual(phases, ['fading-in', 'active']);

    // Enabling a third channel while active also does NOT restart fade-in
    const callsWhileActive = transitionGain.gain.calls.length;
    ctx.currentTime += 2.0;
    state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'ventilation' });
    await engine.syncState(state);
    assert.equal(transitionGain.gain.calls.length, callsWhileActive);
  } finally {
    engine.dispose();
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
});

test('Stop All fades out over 8s before suspending AudioContext, and mid-fade Play All smoothly reverses transition', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  let nextTimerId = 1;
  const timers = new Map<number, { fn: () => void; delay: number }>();

  MockAudioContext.instances = [];
  (globalThis as Record<string, unknown>).window = {
    AudioContext: MockAudioContext,
    location: { search: '' },
    setTimeout: (fn: () => void, delay = 0) => {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const engine = new DeepSpaceEngine();

  try {
    let state = createInitialMixerState();
    engine.unlockFromGesture();
    state = mixerReducer(state, { type: 'PLAY_ALL' });
    await engine.syncState(state);

    const ctx = MockAudioContext.instances[0];
    const transitionGain = ctx.nodes[1] as MockGainNode;

    // Complete initial 3s fade-in
    const fadeInEntry = [...timers.entries()].find(([, t]) => t.delay === 3000);
    assert.ok(fadeInEntry);
    timers.delete(fadeInEntry[0]);
    fadeInEntry[1].fn();
    ctx.currentTime += 3.0;
    assert.equal(engine.getPlaybackPhase(), 'active');

    // Trigger Stop All -> 8s fade-out begins, AudioContext remains running until fade completes
    state = mixerReducer(state, { type: 'STOP_ALL' });
    await engine.syncState(state);

    assert.equal(engine.getPlaybackPhase(), 'fading-out');
    assert.equal(ctx.state, 'running', 'AudioContext must not suspend before 8s fade completes');
    const fadeOutRamp = transitionGain.gain.calls.find(
      (c) => c.method === 'linearRampToValueAtTime' && c.args[0] === 0,
    );
    assert.ok(fadeOutRamp);
    assert.equal(fadeOutRamp.args[1], ctx.currentTime + 8);

    const stopTimerEntry = [...timers.entries()].find(([, t]) => t.delay === 8000);
    assert.ok(stopTimerEntry, 'Expected 8000ms stop fade timer');

    // Halfway through 8s fade-out (at +4s -> estimated gain 0.5), user clicks Play All to reverse
    ctx.currentTime += 4.0;
    state = mixerReducer(state, { type: 'PLAY_ALL' });
    await engine.syncState(state);

    assert.equal(timers.has(stopTimerEntry[0]), false, 'Pending stop timer must be cancelled');
    assert.equal(engine.getPlaybackPhase(), 'fading-in');
    assert.equal(ctx.state, 'running');

    // Reversal starts from ~0.5 rather than snapping to 0, and completes over ~1.5s
    const lastSet = [...transitionGain.gain.calls]
      .reverse()
      .find((c) => c.method === 'setValueAtTime');
    const lastRamp = [...transitionGain.gain.calls]
      .reverse()
      .find((c) => c.method === 'linearRampToValueAtTime');
    assert.ok(lastSet && Math.abs(lastSet.args[0] - 0.5) < 0.05);
    assert.ok(lastRamp && lastRamp.args[0] === 1 && Math.abs(lastRamp.args[1] - (ctx.currentTime + 1.5)) < 0.05);

    // Complete reversed fade-in, then test full 30s Sleep Timer fade-out completion
    const reverseTimer = [...timers.entries()].find(([, t]) => t.delay === 1500);
    assert.ok(reverseTimer);
    timers.delete(reverseTimer[0]);
    reverseTimer[1].fn();
    ctx.currentTime += 1.5;
    assert.equal(engine.getPlaybackPhase(), 'active');

    state = mixerReducer(state, { type: 'STOP_ALL' });
    await engine.syncState(state, { fadeOutDurationSec: 30 });
    assert.equal(engine.getPlaybackPhase(), 'fading-out');
    assert.equal(ctx.state, 'running');

    const sleepFadeTimer = [...timers.entries()].find(([, t]) => t.delay === 30_000);
    assert.ok(sleepFadeTimer, 'Expected 30000ms sleep timer fade-out timer');

    // Fire sleep fade completion -> AudioContext suspends and phase becomes stopped
    timers.delete(sleepFadeTimer[0]);
    sleepFadeTimer[1].fn();
    assert.equal(engine.getPlaybackPhase(), 'stopped');
    assert.equal(ctx.state, 'suspended');
  } finally {
    engine.dispose();
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
});

test('rapid start/stop toggles cancel previous fade timers cleanly with zero duplicates', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  let nextTimerId = 1;
  const timers = new Map<number, { fn: () => void; delay: number }>();

  MockAudioContext.instances = [];
  (globalThis as Record<string, unknown>).window = {
    AudioContext: MockAudioContext,
    location: { search: '' },
    setTimeout: (fn: () => void, delay = 0) => {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const engine = new DeepSpaceEngine();

  try {
    let state = createInitialMixerState();
    engine.unlockFromGesture();

    let lastFadeOutTimerId: number | undefined;
    for (let i = 0; i < 6; i += 1) {
      state = mixerReducer(state, { type: 'PLAY_ALL' });
      await engine.syncState(state);
      ctxAdvance(0.2);
      const beforeStop = new Set(timers.keys());
      state = mixerReducer(state, { type: 'STOP_ALL' });
      await engine.syncState(state);
      const addedOnStop = [...timers.keys()].filter((id) => !beforeStop.has(id));
      assert.equal(addedOnStop.length, 1);
      lastFadeOutTimerId = addedOnStop[0];
      ctxAdvance(0.2);
    }

    function ctxAdvance(sec: number) {
      if (MockAudioContext.instances[0]) {
        MockAudioContext.instances[0].currentTime += sec;
      }
    }

    // 3 intermittent channel timers (systems, comms, hull) + 1 fade-out timer = 4 total (never stacked fade timers)
    assert.equal(timers.size, 4);
    assert.ok(lastFadeOutTimerId !== undefined && timers.has(lastFadeOutTimerId));
    const fadeOutTimer = timers.get(lastFadeOutTimerId)!;
    timers.delete(lastFadeOutTimerId);
    fadeOutTimer.fn();
    assert.equal(timers.size, 0, 'Fade-out completion must stop all channel schedulers and leave 0 timers');

    // Dispose disconnects transitionGain and all channel nodes without leaks
    engine.dispose();
    const ctx = MockAudioContext.instances[0];
    const leaked = ctx.nodes.filter((n) => !n.disconnected);
    assert.equal(leaked.length, 0);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
});

test('loading a custom soundscape in Standby never allocates AudioContext and loading while active updates smoothly without fades', async () => {
  const prevWindow = (globalThis as Record<string, unknown>).window;
  let nextTimerId = 1;
  const timers = new Map<number, { fn: () => void; delay: number }>();

  MockAudioContext.instances = [];
  (globalThis as Record<string, unknown>).window = {
    AudioContext: MockAudioContext,
    location: { search: '' },
    setTimeout: (fn: () => void, delay = 0) => {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const phases: string[] = [];
  const engine = new DeepSpaceEngine({
    onPlaybackPhaseChange: (phase) => phases.push(phase),
  });

  try {
    // Build a custom soundscape with Observation Deck + specific levels
    let source = mixerReducer(createInitialMixerState(), {
      type: 'SELECT_PRESET',
      presetId: 'deep-transit',
    });
    source = mixerReducer(source, { type: 'SET_MASTER_VOLUME', volume: 0.45 });
    source = mixerReducer(source, {
      type: 'SELECT_ACOUSTIC_PROFILE',
      profileId: 'observation-deck',
    });
    const saved = createCustomSoundscape([], source, { name: 'Cruise Snapshot' });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;

    // 1. Load while Standby -> AudioContext must remain unallocated, phase stays stopped
    let state = mixerReducer(createInitialMixerState(), {
      type: 'LOAD_CUSTOM_SOUNDSCAPE',
      soundscape: saved.value.soundscape,
    });
    await engine.syncState(state);
    assert.equal(MockAudioContext.instances.length, 0);
    assert.equal(engine.getPlaybackPhase(), 'stopped');
    assert.equal(phases.length, 0);

    // 2. Start playback normally, finish 3s fade-in, then load a second custom soundscape while active
    engine.unlockFromGesture();
    state = mixerReducer(createInitialMixerState(), { type: 'PLAY_ALL' });
    await engine.syncState(state);
    const fadeInTimer = [...timers.entries()].find(([, t]) => t.delay === 3000);
    assert.ok(fadeInTimer);
    timers.delete(fadeInTimer[0]);
    fadeInTimer[1].fn();
    assert.equal(engine.getPlaybackPhase(), 'active');

    const ctx = MockAudioContext.instances[0];
    const transitionGain = ctx.nodes[1] as MockGainNode;
    const transitionCallsBeforeLoad = transitionGain.gain.calls.length;
    const pannerRefsBeforeLoad = [...ctx.panners];

    ctx.currentTime += 1.0;
    state = mixerReducer(state, {
      type: 'LOAD_CUSTOM_SOUNDSCAPE',
      soundscape: saved.value.soundscape,
    });
    await engine.syncState(state);

    // AudioContext & PannerNodes are NOT recreated, no fade transition triggered, acoustic profile updated
    assert.equal(MockAudioContext.instances.length, 1);
    assert.deepEqual(ctx.panners, pannerRefsBeforeLoad);
    assert.equal(engine.getPlaybackPhase(), 'active');
    assert.deepEqual(phases, ['fading-in', 'active']);
    assert.equal(transitionGain.gain.calls.length, transitionCallsBeforeLoad);

    const obs = getAcousticProfile('observation-deck');
    assert.equal(ctx.delays[0].delayTime.value, obs.reflection.delayLeftSec);
    assert.equal(ctx.delays[1].delayTime.value, obs.reflection.delayRightSec);
  } finally {
    engine.dispose();
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
});



