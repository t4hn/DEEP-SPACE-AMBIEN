import assert from 'node:assert/strict';
import test from 'node:test';
import { getAcousticProfile } from './acousticProfiles';
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
    assert.equal(timers.size, 1, 'Expected one active CH-06 hull scheduler timer');

    const [firstTimerId, firstTimer] = [...timers.entries()][0];
    const initialNodeCount = ctx.nodes.length;

    // Advance fake clock past initial creak delay and fire timer
    fakeNowMs += firstTimer.delay + 50;
    timers.delete(firstTimerId);
    firstTimer.fn();

    // Creak spawned transient oscillators + HRTF panner with Ambient Events completely OFF
    assert.ok(ctx.nodes.length > initialNodeCount, 'Expected CH-06 creak nodes to be created');
    assert.ok(ctx.panners.length > 6, 'Expected spatialized creak PannerNode');
    assert.equal(triggeredEvents.length, 0);
    assert.equal(timers.size, 1, 'Expected next CH-06 wakeup timer to be scheduled');

    const transientNodes = ctx.nodes.slice(initialNodeCount);

    // Backgrounding the tab must clear pending timer and stop active transient voices
    mockDoc.hidden = true;
    for (const cb of docListeners.visibilitychange ?? []) cb();
    assert.equal(timers.size, 0, 'Expected pending CH-06 timer cleared when tab hidden');
    for (const node of transientNodes) {
      if (node instanceof MockOscillatorNode) {
        assert.equal(node.stopped, true);
      }
    }

    // Returning to tab re-schedules CH-06 cleanly without firing an immediate burst
    mockDoc.hidden = false;
    fakeNowMs += 120_000;
    for (const cb of docListeners.visibilitychange ?? []) cb();
    assert.equal(timers.size, 1, 'Expected CH-06 timer re-scheduled on visibility return');
    const [resumedId, resumedTimer] = [...timers.entries()][0];
    assert.ok(resumedTimer.delay >= 1_000, 'Expected re-anchored delay instead of immediate burst');

    // Turning CH-06 OFF clears its pending timer immediately (only 60ms AudioContext suspend timer may exist)
    state = mixerReducer(state, { type: 'TOGGLE_CHANNEL', channelId: 'hull' });
    await engine.syncState(state);
    assert.equal(timers.has(resumedId), false, 'Expected CH-06 timer cleared immediately on channel disable');
    assert.equal(
      [...timers.values()].every((t) => t.delay === 60),
      true,
      'Only 60ms AudioContext suspend timer may remain after last channel disables',
    );
    assert.ok(clearedIds.includes(resumedId));
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

