import {
  CHANNELS,
  type ChannelId,
  type MixerState,
  effectiveChannelGain,
  sliderToGain,
} from './mixerState';

interface ChannelAudioNodes {
  gain: GainNode;
  analyser: AnalyserNode;
  start?: () => void;
  stop?: () => void;
  cleanup: () => void;
}

/**
 * Generates a phase-continuous looping noise AudioBuffer (brown or pink) by
 * synthesizing `N + fadeSamples` samples and equal-power crossfading the extra
 * tail back into the head of the `N`-sample buffer. Because `tail[0]` is the
 * natural continuation of `data[N - 1]`, the loop boundary has zero sample
 * discontinuity or click.
 */
function createSeamlessNoiseBuffer(
  ctx: AudioContext,
  durationSeconds: number,
  color: 'brown' | 'pink',
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(sampleRate, Math.floor(sampleRate * durationSeconds));
  const fadeSamples = Math.min(Math.floor(sampleRate * 0.75), Math.floor(length / 6));
  const totalSamples = length + fadeSamples;
  const buffer = ctx.createBuffer(2, length, sampleRate);

  for (let ch = 0; ch < 2; ch += 1) {
    const raw = new Float32Array(totalSamples);
    let lastOut = 0;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;

    for (let i = 0; i < totalSamples; i += 1) {
      const white = Math.random() * 2 - 1;
      if (color === 'brown') {
        lastOut = (lastOut + 0.018 * white) / 1.018;
        raw[i] = lastOut * 3.1;
      } else {
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    }

    const data = buffer.getChannelData(ch);
    data.set(raw.subarray(0, length));

    // Equal-power crossfade of raw[length..] into data[0..fadeSamples-1]
    for (let i = 0; i < fadeSamples; i += 1) {
      const t = i / fadeSamples;
      const head = raw[i];
      const tail = raw[length + i];
      const fadeIn = Math.sin(t * Math.PI * 0.5);
      const fadeOut = Math.cos(t * Math.PI * 0.5);
      data[i] = head * fadeIn + tail * fadeOut;
    }
  }

  return buffer;
}

/**
 * Smoothly updates an AudioParam without clicks or abrupt jumps, cancelling any
 * previously scheduled curves cleanly from the current value.
 */
function smoothSetParam(param: AudioParam, target: number, now: number, timeConstant = 0.055): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.setTargetAtTime(target, now, timeConstant);
}

/**
 * Tracks ephemeral scheduled audio sources (oscillators / buffer sources) so
 * they disconnect cleanly on completion and can be silenced immediately when
 * their channel or the master environment is stopped.
 */
class TransientVoicePool {
  private voices = new Set<{ stop: (when?: number) => void; disconnect: () => void }>();

  public track(
    source: AudioScheduledSourceNode,
    disconnectFn: () => void,
  ): void {
    const entry = {
      stop: (when?: number) => {
        try {
          source.stop(when);
        } catch {
          // Ignore if source has not started or already stopped
        }
      },
      disconnect: disconnectFn,
    };

    this.voices.add(entry);
    source.onended = () => {
      this.voices.delete(entry);
      disconnectFn();
    };
  }

  public stopAll(now: number): void {
    for (const voice of this.voices) {
      voice.stop(now + 0.03);
      voice.disconnect();
    }
    this.voices.clear();
  }
}

export class DeepSpaceEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private channels: Partial<Record<ChannelId, ChannelAudioNodes>> = {};
  private analyserScratch = new Float32Array(256);

  private latestState: MixerState | null = null;
  private suspendTimer: number | null = null;
  private disposed = false;

  private readonly handleVisibilityOrFocus = (): void => {
    if (this.disposed || !this.ctx || !this.latestState?.isActive) return;

    if (typeof document !== 'undefined' && !document.hidden) {
      if (this.ctx.state !== 'running') {
        void this.ctx.resume().catch(() => {
          // Will retry on next user gesture if browser blocks background resume
        });
      }
      // Ensure intermittent schedulers resume cleanly when returning to tab
      if (this.latestState.channels.systems.enabled) {
        this.channels.systems?.start?.();
      }
      if (this.latestState.channels.communications.enabled) {
        this.channels.communications?.start?.();
      }
    }
  };

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityOrFocus);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.handleVisibilityOrFocus);
    }
  }

  /**
   * Must be called synchronously inside a user interaction handler (click/tap)
   * when activating audio so browsers permit AudioContext creation/resumption.
   */
  public unlockFromGesture(): void {
    if (this.disposed) return;
    this.clearPendingSuspend();
    const ctx = this.ensureInitialized();
    if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
      void ctx.resume().catch(() => {
        // Handled safely if gesture context was unavailable
      });
    }
  }

  private clearPendingSuspend(): void {
    if (this.suspendTimer !== null) {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
  }

  private ensureInitialized(): AudioContext {
    if (this.ctx) {
      return this.ctx;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();

    ctx.onstatechange = () => {
      if (
        !this.disposed &&
        this.latestState?.isActive &&
        (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') &&
        (typeof document === 'undefined' || !document.hidden)
      ) {
        void ctx.resume().catch(() => {});
      }
    };

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;

    // Gentle transparent mastering compressor so all 5 channels blend without clipping
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 20;
    compressor.ratio.value = 3.2;
    compressor.attack.value = 0.015;
    compressor.release.value = 0.3;

    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    this.ctx = ctx;
    this.masterGain = masterGain;
    this.compressor = compressor;

    this.channels.reactor = this.buildReactorChannel(ctx, masterGain);
    this.channels.engines = this.buildEnginesChannel(ctx, masterGain);
    this.channels.ventilation = this.buildVentilationChannel(ctx, masterGain);
    this.channels.systems = this.buildSystemsChannel(ctx, masterGain);
    this.channels.communications = this.buildCommunicationsChannel(ctx, masterGain);

    return ctx;
  }

  private createChannelBus(ctx: AudioContext, destination: AudioNode): {
    input: GainNode;
    outputGain: GainNode;
    analyser: AnalyserNode;
    disconnectBus: () => void;
  } {
    const input = ctx.createGain();
    input.gain.value = 1;

    const outputGain = ctx.createGain();
    outputGain.gain.value = 0;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;

    input.connect(outputGain);
    outputGain.connect(analyser);
    analyser.connect(destination);

    return {
      input,
      outputGain,
      analyser,
      disconnectBus: () => {
        input.disconnect();
        outputGain.disconnect();
        analyser.disconnect();
      },
    };
  }

  /**
   * CH-01: Reactor — Deep, warm, continuous mechanical hum with subtle fluctuations
   */
  private buildReactorChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, outputGain, analyser, disconnectBus } = this.createChannelBus(ctx, dest);

    // Subsonic highpass removes DC / ultra-low mud without thinning the 52 Hz core
    const subsonicFilter = ctx.createBiquadFilter();
    subsonicFilter.type = 'highpass';
    subsonicFilter.frequency.value = 24;
    subsonicFilter.Q.value = 0.7;

    const warmthLowpass = ctx.createBiquadFilter();
    warmthLowpass.type = 'lowpass';
    warmthLowpass.frequency.value = 140;
    warmthLowpass.Q.value = 0.85;

    subsonicFilter.connect(warmthLowpass).connect(input);

    // Warm fundamental + slow-beating pair + subtle octave & fifth harmonics
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = 52;
    const g1 = ctx.createGain();
    g1.gain.value = 0.32;
    osc1.connect(g1).connect(subsonicFilter);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 52.19;
    const g2 = ctx.createGain();
    g2.gain.value = 0.21;
    osc2.connect(g2).connect(subsonicFilter);

    const osc3 = ctx.createOscillator();
    osc3.type = 'sine';
    osc3.frequency.value = 78;
    const g3 = ctx.createGain();
    g3.gain.value = 0.045;
    osc3.connect(g3).connect(subsonicFilter);

    const osc4 = ctx.createOscillator();
    osc4.type = 'triangle';
    osc4.frequency.value = 104;
    const g4 = ctx.createGain();
    g4.gain.value = 0.055;
    osc4.connect(g4).connect(subsonicFilter);

    // Two slow incommensurate LFOs for natural, non-periodic core breathing
    const lfo1 = ctx.createOscillator();
    lfo1.type = 'sine';
    lfo1.frequency.value = 0.047;
    const lfo1Gain = ctx.createGain();
    lfo1Gain.gain.value = 14;
    lfo1.connect(lfo1Gain).connect(warmthLowpass.frequency);

    const lfo2 = ctx.createOscillator();
    lfo2.type = 'sine';
    lfo2.frequency.value = 0.083;
    const lfo2Gain = ctx.createGain();
    lfo2Gain.gain.value = 9;
    lfo2.connect(lfo2Gain).connect(warmthLowpass.frequency);

    // Deep containment brown noise bed
    const noiseBuffer = createSeamlessNoiseBuffer(ctx, 17.3, 'brown');
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuffer;
    noiseSrc.loop = true;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.24;
    noiseSrc.connect(noiseGain).connect(subsonicFilter);

    osc1.start();
    osc2.start();
    osc3.start();
    osc4.start();
    lfo1.start();
    lfo2.start();
    noiseSrc.start();

    return {
      gain: outputGain,
      analyser,
      cleanup: () => {
        for (const src of [osc1, osc2, osc3, osc4, lfo1, lfo2, noiseSrc]) {
          try {
            src.stop();
          } catch {
            // Ignore already stopped
          }
          src.disconnect();
        }
        g1.disconnect();
        g2.disconnect();
        g3.disconnect();
        g4.disconnect();
        lfo1Gain.disconnect();
        lfo2Gain.disconnect();
        noiseGain.disconnect();
        subsonicFilter.disconnect();
        warmthLowpass.disconnect();
        disconnectBus();
      },
    };
  }

  /**
   * CH-02: Engines — Layered, low-frequency mechanical rumble
   */
  private buildEnginesChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, outputGain, analyser, disconnectBus } = this.createChannelBus(ctx, dest);

    const subsonicHp = ctx.createBiquadFilter();
    subsonicHp.type = 'highpass';
    subsonicHp.frequency.value = 26;
    subsonicHp.Q.value = 0.7;

    const rumbleLowpass = ctx.createBiquadFilter();
    rumbleLowpass.type = 'lowpass';
    rumbleLowpass.frequency.value = 138;
    rumbleLowpass.Q.value = 0.8;

    subsonicHp.connect(rumbleLowpass).connect(input);

    // Prime-length brown + pink noise layers prevent any audible loop cycle
    const bufA = createSeamlessNoiseBuffer(ctx, 13.7, 'brown');
    const bufB = createSeamlessNoiseBuffer(ctx, 19.3, 'pink');

    const srcA = ctx.createBufferSource();
    srcA.buffer = bufA;
    srcA.loop = true;
    const gA = ctx.createGain();
    gA.gain.value = 0.52;
    srcA.connect(gA).connect(subsonicHp);

    const srcB = ctx.createBufferSource();
    srcB.buffer = bufB;
    srcB.loop = true;
    const bpB = ctx.createBiquadFilter();
    bpB.type = 'bandpass';
    bpB.frequency.value = 88;
    bpB.Q.value = 0.85;
    const gB = ctx.createGain();
    gB.gain.value = 0.34;
    srcB.connect(bpB).connect(gB).connect(subsonicHp);

    // Warm layered mechanical drive tones (triangle + sine, no harsh sawtooth buzz)
    const driveOsc1 = ctx.createOscillator();
    driveOsc1.type = 'triangle';
    driveOsc1.frequency.value = 39;
    const driveOsc2 = ctx.createOscillator();
    driveOsc2.type = 'sine';
    driveOsc2.frequency.value = 78.35;
    const driveFilter = ctx.createBiquadFilter();
    driveFilter.type = 'lowpass';
    driveFilter.frequency.value = 105;
    driveFilter.Q.value = 0.7;
    const driveGain = ctx.createGain();
    driveGain.gain.value = 0.085;
    driveOsc1.connect(driveFilter);
    driveOsc2.connect(driveFilter);
    driveFilter.connect(driveGain).connect(input);

    // Dual slow LFOs for organic propulsion thrum
    const lfoA = ctx.createOscillator();
    lfoA.type = 'sine';
    lfoA.frequency.value = 0.13;
    const lfoAGain = ctx.createGain();
    lfoAGain.gain.value = 16;
    lfoA.connect(lfoAGain).connect(rumbleLowpass.frequency);

    const lfoB = ctx.createOscillator();
    lfoB.type = 'sine';
    lfoB.frequency.value = 0.21;
    const lfoBGain = ctx.createGain();
    lfoBGain.gain.value = 10;
    lfoB.connect(lfoBGain).connect(rumbleLowpass.frequency);

    srcA.start();
    srcB.start();
    driveOsc1.start();
    driveOsc2.start();
    lfoA.start();
    lfoB.start();

    return {
      gain: outputGain,
      analyser,
      cleanup: () => {
        for (const src of [srcA, srcB, driveOsc1, driveOsc2, lfoA, lfoB]) {
          try {
            src.stop();
          } catch {
            // Ignore already stopped
          }
          src.disconnect();
        }
        gA.disconnect();
        bpB.disconnect();
        gB.disconnect();
        driveFilter.disconnect();
        driveGain.disconnect();
        lfoAGain.disconnect();
        lfoBGain.disconnect();
        subsonicHp.disconnect();
        rumbleLowpass.disconnect();
        disconnectBus();
      },
    };
  }

  /**
   * CH-03: Ventilation — Soft, consistent airflow without excessive high-frequency noise
   */
  private buildVentilationChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, outputGain, analyser, disconnectBus } = this.createChannelBus(ctx, dest);

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 160;
    highpass.Q.value = 0.6;

    // Cascaded gentle lowpasses roll off upper-mid/treble hiss cleanly
    const airLowpass1 = ctx.createBiquadFilter();
    airLowpass1.type = 'lowpass';
    airLowpass1.frequency.value = 960;
    airLowpass1.Q.value = 0.5;

    const airLowpass2 = ctx.createBiquadFilter();
    airLowpass2.type = 'lowpass';
    airLowpass2.frequency.value = 1150;
    airLowpass2.Q.value = 0.5;

    const ductBody = ctx.createBiquadFilter();
    ductBody.type = 'peaking';
    ductBody.frequency.value = 320;
    ductBody.Q.value = 0.85;
    ductBody.gain.value = 2.2;

    highpass.connect(airLowpass1).connect(airLowpass2).connect(ductBody).connect(input);

    // Dual prime-length pink noise buffers (>250s composite cycle)
    const buf1 = createSeamlessNoiseBuffer(ctx, 11.3, 'pink');
    const buf2 = createSeamlessNoiseBuffer(ctx, 23.1, 'pink');

    const src1 = ctx.createBufferSource();
    src1.buffer = buf1;
    src1.loop = true;
    const g1 = ctx.createGain();
    g1.gain.value = 0.34;
    src1.connect(g1).connect(highpass);

    const src2 = ctx.createBufferSource();
    src2.buffer = buf2;
    src2.loop = true;
    const g2 = ctx.createGain();
    g2.gain.value = 0.28;
    src2.connect(g2).connect(highpass);

    // Ultra-subtle cabin pressure circulation drift
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 75;
    lfo.connect(lfoGain).connect(airLowpass1.frequency);

    src1.start();
    src2.start();
    lfo.start();

    return {
      gain: outputGain,
      analyser,
      cleanup: () => {
        for (const src of [src1, src2, lfo]) {
          try {
            src.stop();
          } catch {
            // Ignore already stopped
          }
          src.disconnect();
        }
        g1.disconnect();
        g2.disconnect();
        lfoGain.disconnect();
        highpass.disconnect();
        airLowpass1.disconnect();
        airLowpass2.disconnect();
        ductBody.disconnect();
        disconnectBus();
      },
    };
  }

  /**
   * CH-04: Systems — Subtle, intermittent electronic activity
   */
  private buildSystemsChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, outputGain, analyser, disconnectBus } = this.createChannelBus(ctx, dest);

    // Warm lowpass on the systems bus prevents any piercing digital edges
    const busToneFilter = ctx.createBiquadFilter();
    busToneFilter.type = 'lowpass';
    busToneFilter.frequency.value = 1400;
    busToneFilter.Q.value = 0.6;
    busToneFilter.connect(input);

    // Quiet console electronics whisper bed
    const humOsc = ctx.createOscillator();
    humOsc.type = 'sine';
    humOsc.frequency.value = 180;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.008;
    humOsc.connect(humGain).connect(busToneFilter);
    humOsc.start();

    // Calm, restrained harmonic register for non-fatiguing extended listening
    const scale = [392.0, 440.0, 523.25, 587.33, 659.25, 783.99];
    const voices = new TransientVoicePool();
    let timerId: number | null = null;
    let running = false;

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    const scheduleNextEvent = () => {
      if (!running || this.disposed || this.ctx !== ctx) return;

      // Avoid queuing events while tab is backgrounded
      if (typeof document !== 'undefined' && document.hidden) {
        timerId = window.setTimeout(scheduleNextEvent, 1500);
        return;
      }

      if (ctx.state === 'running') {
        const now = ctx.currentTime;
        const roll = Math.random();

        if (roll < 0.58) {
          // Soft single or quiet two-step telemetry tone
          const steps = Math.random() < 0.4 ? 2 : 1;
          const baseIdx = Math.floor(Math.random() * scale.length);
          for (let i = 0; i < steps; i += 1) {
            const start = now + i * 0.18;
            const freq = scale[(baseIdx + i * 2) % scale.length];
            const osc = ctx.createOscillator();
            const env = ctx.createGain();
            const pan = ctx.createStereoPanner();

            osc.type = 'sine';
            osc.frequency.value = freq;
            pan.pan.value = (Math.random() - 0.5) * 0.42;

            env.gain.setValueAtTime(0.0001, start);
            env.gain.linearRampToValueAtTime(0.065, start + 0.018);
            env.gain.exponentialRampToValueAtTime(0.0001, start + 0.21);

            osc.connect(env).connect(pan).connect(busToneFilter);
            voices.track(osc, () => {
              osc.disconnect();
              env.disconnect();
              pan.disconnect();
            });
            osc.start(start);
            osc.stop(start + 0.24);
          }
        } else {
          // Muffled processing micro-burst (3-4 gentle muted pulses)
          const count = 3 + Math.floor(Math.random() * 2);
          const baseFreq = scale[Math.floor(Math.random() * 4)];
          const panVal = (Math.random() - 0.5) * 0.5;
          for (let i = 0; i < count; i += 1) {
            const start = now + i * (0.068 + Math.random() * 0.02);
            const osc = ctx.createOscillator();
            const env = ctx.createGain();
            const pan = ctx.createStereoPanner();

            osc.type = 'sine';
            osc.frequency.value = baseFreq * (1 + (i % 3) * 0.125);
            pan.pan.value = panVal;

            env.gain.setValueAtTime(0.0001, start);
            env.gain.linearRampToValueAtTime(0.038, start + 0.008);
            env.gain.exponentialRampToValueAtTime(0.0001, start + 0.055);

            osc.connect(env).connect(pan).connect(busToneFilter);
            voices.track(osc, () => {
              osc.disconnect();
              env.disconnect();
              pan.disconnect();
            });
            osc.start(start);
            osc.stop(start + 0.065);
          }
        }
      }

      const nextDelayMs = 2600 + Math.random() * 5200;
      timerId = window.setTimeout(scheduleNextEvent, nextDelayMs);
    };

    const start = () => {
      if (running) return;
      running = true;
      clearTimer();
      timerId = window.setTimeout(scheduleNextEvent, 450);
    };

    const stop = () => {
      if (!running && timerId === null) return;
      running = false;
      clearTimer();
      voices.stopAll(ctx.currentTime);
    };

    return {
      gain: outputGain,
      analyser,
      start,
      stop,
      cleanup: () => {
        stop();
        try {
          humOsc.stop();
        } catch {
          // Ignore already stopped
        }
        humOsc.disconnect();
        humGain.disconnect();
        busToneFilter.disconnect();
        disconnectBus();
      },
    };
  }

  /**
   * CH-05: Communications — Atmospheric radio static and occasional distant signals
   */
  private buildCommunicationsChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, outputGain, analyser, disconnectBus } = this.createChannelBus(ctx, dest);

    // Pink noise base produces warm receiver hiss rather than harsh white static
    const staticFilter = ctx.createBiquadFilter();
    staticFilter.type = 'bandpass';
    staticFilter.frequency.value = 980;
    staticFilter.Q.value = 1.1;

    const staticLowpass = ctx.createBiquadFilter();
    staticLowpass.type = 'lowpass';
    staticLowpass.frequency.value = 1850;
    staticLowpass.Q.value = 0.6;

    staticFilter.connect(staticLowpass).connect(input);

    const staticBuf = createSeamlessNoiseBuffer(ctx, 15.7, 'pink');
    const staticSrc = ctx.createBufferSource();
    staticSrc.buffer = staticBuf;
    staticSrc.loop = true;
    const staticGain = ctx.createGain();
    staticGain.gain.value = 0.14;
    staticSrc.connect(staticGain).connect(staticFilter);

    // Slow ionospheric band drift
    const driftLfo = ctx.createOscillator();
    driftLfo.type = 'sine';
    driftLfo.frequency.value = 0.065;
    const driftGain = ctx.createGain();
    driftGain.gain.value = 210;
    driftLfo.connect(driftGain).connect(staticFilter.frequency);

    staticSrc.start();
    driftLfo.start();

    const voices = new TransientVoicePool();
    let timerId: number | null = null;
    let running = false;

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    const scheduleSignal = () => {
      if (!running || this.disposed || this.ctx !== ctx) return;

      if (typeof document !== 'undefined' && document.hidden) {
        timerId = window.setTimeout(scheduleSignal, 1500);
        return;
      }

      if (ctx.state === 'running') {
        const now = ctx.currentTime;
        const pan = ctx.createStereoPanner();
        pan.pan.value = (Math.random() - 0.5) * 0.65;
        pan.connect(input);

        if (Math.random() < 0.6) {
          // Distant narrow-band carrier sweep / subspace beacon
          const osc = ctx.createOscillator();
          const bp = ctx.createBiquadFilter();
          const env = ctx.createGain();

          const startFreq = 560 + Math.random() * 620;
          const endFreq = startFreq + (Math.random() - 0.5) * 90;
          const duration = 0.9 + Math.random() * 1.5;

          osc.type = 'sine';
          osc.frequency.setValueAtTime(startFreq, now);
          osc.frequency.linearRampToValueAtTime(endFreq, now + duration);

          bp.type = 'bandpass';
          bp.frequency.value = startFreq;
          bp.Q.value = 5.5;

          env.gain.setValueAtTime(0.0001, now);
          env.gain.linearRampToValueAtTime(0.036, now + duration * 0.4);
          env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

          osc.connect(bp).connect(env).connect(pan);
          voices.track(osc, () => {
            osc.disconnect();
            bp.disconnect();
            env.disconnect();
            pan.disconnect();
          });
          osc.start(now);
          osc.stop(now + duration + 0.05);
        } else {
          // Soft atmospheric squelch swell (pink noise, smooth attack)
          const burst = ctx.createBufferSource();
          burst.buffer = staticBuf;
          burst.loop = true;
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = 920 + Math.random() * 520;
          bp.Q.value = 1.9;
          const env = ctx.createGain();
          const duration = 0.55 + Math.random() * 0.65;

          env.gain.setValueAtTime(0.0001, now);
          env.gain.linearRampToValueAtTime(0.11, now + 0.14);
          env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

          burst.connect(bp).connect(env).connect(pan);
          voices.track(burst, () => {
            burst.disconnect();
            bp.disconnect();
            env.disconnect();
            pan.disconnect();
          });
          burst.start(now, Math.random() * 10);
          burst.stop(now + duration + 0.05);
        }
      }

      const nextDelayMs = 3600 + Math.random() * 6800;
      timerId = window.setTimeout(scheduleSignal, nextDelayMs);
    };

    const start = () => {
      if (running) return;
      running = true;
      clearTimer();
      timerId = window.setTimeout(scheduleSignal, 700);
    };

    const stop = () => {
      if (!running && timerId === null) return;
      running = false;
      clearTimer();
      voices.stopAll(ctx.currentTime);
    };

    return {
      gain: outputGain,
      analyser,
      start,
      stop,
      cleanup: () => {
        stop();
        for (const src of [staticSrc, driftLfo]) {
          try {
            src.stop();
          } catch {
            // Ignore already stopped
          }
          src.disconnect();
        }
        staticGain.disconnect();
        driftGain.disconnect();
        staticFilter.disconnect();
        staticLowpass.disconnect();
        disconnectBus();
      },
    };
  }

  public async syncState(state: MixerState): Promise<void> {
    if (this.disposed) return;
    this.latestState = state;

    if (!state.isActive && !this.ctx) {
      // Respect browser autoplay policy: do not allocate AudioContext until user activates audio
      return;
    }

    const ctx = this.ensureInitialized();
    const now = ctx.currentTime;

    if (state.isActive) {
      this.clearPendingSuspend();
      if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
        try {
          await ctx.resume();
        } catch {
          // Will recover on next gesture or visibility restore
        }
      }

      const targetMaster = sliderToGain(state.masterVolume);
      if (this.masterGain) {
        smoothSetParam(this.masterGain.gain, targetMaster, now, 0.055);
      }

      for (const ch of CHANNELS) {
        const node = this.channels[ch.id];
        if (!node) continue;
        const targetGain = effectiveChannelGain(state, ch.id);
        smoothSetParam(node.gain.gain, targetGain, now, 0.055);
      }

      if (state.channels.systems.enabled) {
        this.channels.systems?.start?.();
      } else {
        this.channels.systems?.stop?.();
      }

      if (state.channels.communications.enabled) {
        this.channels.communications?.start?.();
      } else {
        this.channels.communications?.stop?.();
      }
    } else {
      // Stop All / last channel turned off: stop intermittent schedulers immediately,
      // perform a fast 40ms click-free fade to exact 0, and suspend AudioContext.
      this.channels.systems?.stop?.();
      this.channels.communications?.stop?.();

      if (this.masterGain) {
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.linearRampToValueAtTime(0, now + 0.04);
      }

      for (const ch of CHANNELS) {
        const node = this.channels[ch.id];
        if (!node) continue;
        node.gain.gain.cancelScheduledValues(now);
        node.gain.gain.setValueAtTime(node.gain.gain.value, now);
        node.gain.gain.linearRampToValueAtTime(0, now + 0.04);
      }

      this.clearPendingSuspend();
      this.suspendTimer = window.setTimeout(() => {
        this.suspendTimer = null;
        if (!this.disposed && this.ctx && !this.latestState?.isActive && this.ctx.state === 'running') {
          void this.ctx.suspend().catch(() => {});
        }
      }, 60);
    }
  }

  /**
   * Returns normalized [0..1] live RMS signal level per channel for subtle
   * visual indicator bars without allocating arrays per frame.
   */
  public getChannelLevels(state: MixerState): Record<ChannelId, number> {
    const result: Record<ChannelId, number> = {
      reactor: 0,
      engines: 0,
      ventilation: 0,
      systems: 0,
      communications: 0,
    };

    if (!this.ctx || !state.isActive || this.ctx.state !== 'running') {
      return result;
    }

    for (const ch of CHANNELS) {
      const node = this.channels[ch.id];
      if (!node || !state.channels[ch.id].enabled) continue;
      node.analyser.getFloatTimeDomainData(this.analyserScratch);
      let sumSq = 0;
      for (let i = 0; i < this.analyserScratch.length; i += 1) {
        const s = this.analyserScratch[i];
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / this.analyserScratch.length);
      result[ch.id] = rms > 0.0005 ? Math.min(1, Math.pow(rms * 8.5, 0.58)) : 0.06;
    }

    return result;
  }

  public dispose(): void {
    this.disposed = true;
    this.clearPendingSuspend();

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityOrFocus);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.handleVisibilityOrFocus);
    }

    for (const ch of CHANNELS) {
      this.channels[ch.id]?.cleanup();
    }
    this.channels = {};

    if (this.masterGain) {
      this.masterGain.disconnect();
      this.masterGain = null;
    }
    if (this.compressor) {
      this.compressor.disconnect();
      this.compressor = null;
    }
    if (this.ctx) {
      this.ctx.onstatechange = null;
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
