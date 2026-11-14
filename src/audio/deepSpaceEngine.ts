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
  cleanup: () => void;
}

/**
 * Generates a crossfaded pink-ish / brown-ish noise AudioBuffer so looping
 * produces zero click or seam artefacts.
 */
function createSeamlessNoiseBuffer(
  ctx: AudioContext,
  durationSeconds: number,
  color: 'brown' | 'pink' | 'white',
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(sampleRate, Math.floor(sampleRate * durationSeconds));
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const fadeSamples = Math.min(Math.floor(sampleRate * 0.6), Math.floor(length / 8));

  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    let lastOut = 0;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;

    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      if (color === 'brown') {
        lastOut = (lastOut + 0.02 * white) / 1.02;
        data[i] = lastOut * 3.2;
      } else if (color === 'pink') {
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      } else {
        data[i] = white * 0.45;
      }
    }

    // Equal-power crossfade overlap at loop boundary to guarantee zero seam click
    for (let i = 0; i < fadeSamples; i += 1) {
      const t = i / fadeSamples;
      const head = data[i];
      const tail = data[length - fadeSamples + i];
      const fadeIn = Math.sin(t * Math.PI * 0.5);
      const fadeOut = Math.cos(t * Math.PI * 0.5);
      data[i] = head * fadeIn + tail * fadeOut;
    }
  }

  return buffer;
}

export class DeepSpaceEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private channels: Partial<Record<ChannelId, ChannelAudioNodes>> = {};
  private analyserScratch = new Float32Array(256);

  private systemsTimer: number | null = null;
  private commsTimer: number | null = null;
  private systemsActive = false;
  private commsActive = false;

  private ensureInitialized(): AudioContext {
    if (this.ctx) {
      return this.ctx;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;

    // Gentle mastering limiter so combining all 5 channels never clips
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;

    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    this.ctx = ctx;
    this.masterGain = masterGain;

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
  } {
    const input = ctx.createGain();
    input.gain.value = 1;

    const outputGain = ctx.createGain();
    outputGain.gain.value = 0;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;

    input.connect(outputGain);
    outputGain.connect(analyser);
    analyser.connect(destination);

    return { input, outputGain, analyser };
  }

  /**
   * CH-01: Reactor — Deep continuous low-frequency hum
   */
  private buildReactorChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, outputGain, analyser } = this.createChannelBus(ctx, dest);

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 135;
    lowpass.Q.value = 1.2;
    lowpass.connect(input);

    // Warm fundamental + slow beat detuned pair + subtle harmonic
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = 48;
    const g1 = ctx.createGain();
    g1.gain.value = 0.34;
    osc1.connect(g1).connect(lowpass);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 48.28;
    const g2 = ctx.createGain();
    g2.gain.value = 0.22;
    osc2.connect(g2).connect(lowpass);

    const osc3 = ctx.createOscillator();
    osc3.type = 'triangle';
    osc3.frequency.value = 96;
    const g3 = ctx.createGain();
    g3.gain.value = 0.08;
    osc3.connect(g3).connect(lowpass);

    // Very slow incommensurate LFOs so core modulation never feels periodic
    const lfo1 = ctx.createOscillator();
    lfo1.type = 'sine';
    lfo1.frequency.value = 0.071;
    const lfo1Gain = ctx.createGain();
    lfo1Gain.gain.value = 18;
    lfo1.connect(lfo1Gain).connect(lowpass.frequency);

    const lfo2 = ctx.createOscillator();
    lfo2.type = 'sine';
    lfo2.frequency.value = 0.113;
    const lfo2Gain = ctx.createGain();
    lfo2Gain.gain.value = 12;
    lfo2.connect(lfo2Gain).connect(lowpass.frequency);

    // Subtle deep brown noise bed for physical containment texture
    const noiseBuffer = createSeamlessNoiseBuffer(ctx, 17.3, 'brown');
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuffer;
    noiseSrc.loop = true;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.25;
    noiseSrc.connect(noiseGain).connect(lowpass);

    osc1.start();
    osc2.start();
    osc3.start();
    lfo1.start();
    lfo2.start();
    noiseSrc.start();

    return {
      gain: outputGain,
      analyser,
      cleanup: () => {
        osc1.stop();
        osc2.stop();
        osc3.stop();
        lfo1.stop();
        lfo2.stop();
        noiseSrc.stop();
      },
    };
  }

  /**
   * CH-02: Engines — Subtle mechanical engine rumble
   */
  private buildEnginesChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, outputGain, analyser } = this.createChannelBus(ctx, dest);

    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 165;
    rumbleFilter.Q.value = 1.6;
    rumbleFilter.connect(input);

    // Two prime-length noise sources layered so composite pattern never repeats audibly
    const bufA = createSeamlessNoiseBuffer(ctx, 13.7, 'brown');
    const bufB = createSeamlessNoiseBuffer(ctx, 19.3, 'pink');

    const srcA = ctx.createBufferSource();
    srcA.buffer = bufA;
    srcA.loop = true;
    const gA = ctx.createGain();
    gA.gain.value = 0.48;
    srcA.connect(gA).connect(rumbleFilter);

    const srcB = ctx.createBufferSource();
    srcB.buffer = bufB;
    srcB.loop = true;
    const bpB = ctx.createBiquadFilter();
    bpB.type = 'bandpass';
    bpB.frequency.value = 92;
    bpB.Q.value = 1.1;
    const gB = ctx.createGain();
    gB.gain.value = 0.36;
    srcB.connect(bpB).connect(gB).connect(rumbleFilter);

    // Subtle mechanical turbine pulse
    const turbineOsc = ctx.createOscillator();
    turbineOsc.type = 'sawtooth';
    turbineOsc.frequency.value = 61.5;
    const turbineFilter = ctx.createBiquadFilter();
    turbineFilter.type = 'lowpass';
    turbineFilter.frequency.value = 115;
    const turbineGain = ctx.createGain();
    turbineGain.gain.value = 0.07;
    turbineOsc.connect(turbineFilter).connect(turbineGain).connect(input);

    // Modulation for mechanical thrum
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.23;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 26;
    lfo.connect(lfoGain).connect(rumbleFilter.frequency);

    srcA.start();
    srcB.start();
    turbineOsc.start();
    lfo.start();

    return {
      gain: outputGain,
      analyser,
      cleanup: () => {
        srcA.stop();
        srcB.stop();
        turbineOsc.stop();
        lfo.stop();
      },
    };
  }

  /**
   * CH-03: Ventilation — Continuous airflow and environmental noise
   */
  private buildVentilationChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, outputGain, analyser } = this.createChannelBus(ctx, dest);

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 190;

    const airBand = ctx.createBiquadFilter();
    airBand.type = 'lowpass';
    airBand.frequency.value = 1550;
    airBand.Q.value = 0.55;

    const ductResonance = ctx.createBiquadFilter();
    ductResonance.type = 'peaking';
    ductResonance.frequency.value = 460;
    ductResonance.Q.value = 1.2;
    ductResonance.gain.value = 3.5;

    highpass.connect(airBand).connect(ductResonance).connect(input);

    // Dual prime-length pink noise buffers for >250s composite non-repeating airflow
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
    g2.gain.value = 0.26;
    src2.connect(g2).connect(highpass);

    // Gentle airflow pressure drift
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.085;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(airBand.frequency);

    src1.start();
    src2.start();
    lfo.start();

    return {
      gain: outputGain,
      analyser,
      cleanup: () => {
        src1.stop();
        src2.stop();
        lfo.stop();
      },
    };
  }

  /**
   * CH-04: Systems — Quiet electronic beeps, computer tones & processing sounds
   */
  private buildSystemsChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, outputGain, analyser } = this.createChannelBus(ctx, dest);

    // Subtle quiet console electronics bed
    const humOsc = ctx.createOscillator();
    humOsc.type = 'sine';
    humOsc.frequency.value = 240;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.012;
    humOsc.connect(humGain).connect(input);
    humOsc.start();

    const scale = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51];

    const scheduleNextEvent = () => {
      if (!this.systemsActive || !this.ctx) return;

      const now = ctx.currentTime;
      const roll = Math.random();

      if (roll < 0.52) {
        // Soft two-note or single telemetry tone
        const steps = Math.random() < 0.45 ? 2 : 1;
        for (let i = 0; i < steps; i += 1) {
          const start = now + i * 0.14;
          const freq = scale[Math.floor(Math.random() * scale.length)];
          const osc = ctx.createOscillator();
          const env = ctx.createGain();
          const pan = ctx.createStereoPanner();
          osc.type = 'sine';
          osc.frequency.value = freq;
          pan.pan.value = (Math.random() - 0.5) * 0.5;

          env.gain.setValueAtTime(0.0001, start);
          env.gain.linearRampToValueAtTime(0.09, start + 0.014);
          env.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);

          osc.connect(env).connect(pan).connect(input);
          osc.start(start);
          osc.stop(start + 0.2);
        }
      } else {
        // Quiet rapid processing micro-burst (3-5 soft data ticks)
        const count = 3 + Math.floor(Math.random() * 4);
        const baseFreq = scale[Math.floor(Math.random() * 4)] * 1.5;
        const panVal = (Math.random() - 0.5) * 0.65;
        for (let i = 0; i < count; i += 1) {
          const start = now + i * (0.055 + Math.random() * 0.02);
          const osc = ctx.createOscillator();
          const env = ctx.createGain();
          const pan = ctx.createStereoPanner();
          osc.type = 'triangle';
          osc.frequency.value = baseFreq * (1 + (i % 3) * 0.125);
          pan.pan.value = panVal;

          env.gain.setValueAtTime(0.0001, start);
          env.gain.linearRampToValueAtTime(0.055, start + 0.006);
          env.gain.exponentialRampToValueAtTime(0.0001, start + 0.042);

          osc.connect(env).connect(pan).connect(input);
          osc.start(start);
          osc.stop(start + 0.05);
        }
      }

      const nextDelayMs = 1700 + Math.random() * 4200;
      this.systemsTimer = window.setTimeout(scheduleNextEvent, nextDelayMs);
    };

    const startScheduler = () => {
      if (this.systemsTimer !== null) return;
      this.systemsTimer = window.setTimeout(scheduleNextEvent, 350);
    };

    const stopScheduler = () => {
      if (this.systemsTimer !== null) {
        window.clearTimeout(this.systemsTimer);
        this.systemsTimer = null;
      }
    };

    // Expose hook via custom property on cleanup or separate method
    (this as unknown as { _startSystems?: () => void; _stopSystems?: () => void })._startSystems =
      startScheduler;
    (this as unknown as { _startSystems?: () => void; _stopSystems?: () => void })._stopSystems =
      stopScheduler;

    return {
      gain: outputGain,
      analyser,
      cleanup: () => {
        stopScheduler();
        humOsc.stop();
      },
    };
  }

  /**
   * CH-05: Communications — Subtle radio static and distant signal interference
   */
  private buildCommunicationsChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, outputGain, analyser } = this.createChannelBus(ctx, dest);

    const staticFilter = ctx.createBiquadFilter();
    staticFilter.type = 'bandpass';
    staticFilter.frequency.value = 1480;
    staticFilter.Q.value = 1.5;

    const staticLowpass = ctx.createBiquadFilter();
    staticLowpass.type = 'lowpass';
    staticLowpass.frequency.value = 2800;

    staticFilter.connect(staticLowpass).connect(input);

    // Continuous subtle radio static bed
    const staticBuf = createSeamlessNoiseBuffer(ctx, 15.7, 'white');
    const staticSrc = ctx.createBufferSource();
    staticSrc.buffer = staticBuf;
    staticSrc.loop = true;
    const staticGain = ctx.createGain();
    staticGain.gain.value = 0.085;
    staticSrc.connect(staticGain).connect(staticFilter);

    // Slow ionospheric frequency drift
    const driftLfo = ctx.createOscillator();
    driftLfo.type = 'sine';
    driftLfo.frequency.value = 0.09;
    const driftGain = ctx.createGain();
    driftGain.gain.value = 340;
    driftLfo.connect(driftGain).connect(staticFilter.frequency);

    staticSrc.start();
    driftLfo.start();

    const scheduleSignal = () => {
      if (!this.commsActive || !this.ctx) return;

      const now = ctx.currentTime;
      const pan = ctx.createStereoPanner();
      pan.pan.value = (Math.random() - 0.5) * 0.7;
      pan.connect(input);

      if (Math.random() < 0.6) {
        // Distant narrow-band carrier sweep / beacon tone
        const osc = ctx.createOscillator();
        const bp = ctx.createBiquadFilter();
        const env = ctx.createGain();

        const startFreq = 850 + Math.random() * 1100;
        const endFreq = startFreq + (Math.random() - 0.5) * 140;
        const duration = 0.6 + Math.random() * 1.4;

        osc.type = 'sine';
        osc.frequency.setValueAtTime(startFreq, now);
        osc.frequency.linearRampToValueAtTime(endFreq, now + duration);

        bp.type = 'bandpass';
        bp.frequency.value = startFreq;
        bp.Q.value = 6;

        env.gain.setValueAtTime(0.0001, now);
        env.gain.linearRampToValueAtTime(0.05, now + duration * 0.35);
        env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        osc.connect(bp).connect(env).connect(pan);
        osc.start(now);
        osc.stop(now + duration + 0.05);
      } else {
        // Brief distant static squelch burst
        const burst = ctx.createBufferSource();
        burst.buffer = staticBuf;
        burst.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1800 + Math.random() * 900;
        bp.Q.value = 2.4;
        const env = ctx.createGain();
        const duration = 0.35 + Math.random() * 0.5;

        env.gain.setValueAtTime(0.0001, now);
        env.gain.linearRampToValueAtTime(0.11, now + 0.05);
        env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        burst.connect(bp).connect(env).connect(pan);
        burst.start(now, Math.random() * 10);
        burst.stop(now + duration + 0.05);
      }

      const nextDelayMs = 2400 + Math.random() * 5800;
      this.commsTimer = window.setTimeout(scheduleSignal, nextDelayMs);
    };

    const startScheduler = () => {
      if (this.commsTimer !== null) return;
      this.commsTimer = window.setTimeout(scheduleSignal, 600);
    };

    const stopScheduler = () => {
      if (this.commsTimer !== null) {
        window.clearTimeout(this.commsTimer);
        this.commsTimer = null;
      }
    };

    (this as unknown as { _startComms?: () => void; _stopComms?: () => void })._startComms =
      startScheduler;
    (this as unknown as { _startComms?: () => void; _stopComms?: () => void })._stopComms =
      stopScheduler;

    return {
      gain: outputGain,
      analyser,
      cleanup: () => {
        stopScheduler();
        staticSrc.stop();
        driftLfo.stop();
      },
    };
  }

  public async syncState(state: MixerState): Promise<void> {
    if (!state.isActive && !this.ctx) {
      // Do not touch Web Audio API until user activates audio
      return;
    }

    const ctx = this.ensureInitialized();
    const now = ctx.currentTime;
    const ramp = 0.06;

    if (state.isActive && ctx.state === 'suspended') {
      await ctx.resume();
    }

    const targetMaster = state.isActive ? sliderToGain(state.masterVolume) : 0;
    this.masterGain?.gain.setTargetAtTime(targetMaster, now, ramp);

    for (const ch of CHANNELS) {
      const node = this.channels[ch.id];
      if (!node) continue;
      const targetGain = effectiveChannelGain(state, ch.id);
      node.gain.gain.setTargetAtTime(targetGain, now, ramp);
    }

    const hooks = this as unknown as {
      _startSystems?: () => void;
      _stopSystems?: () => void;
      _startComms?: () => void;
      _stopComms?: () => void;
    };

    const shouldSystemsRun = state.isActive && state.channels.systems.enabled;
    if (shouldSystemsRun && !this.systemsActive) {
      this.systemsActive = true;
      hooks._startSystems?.();
    } else if (!shouldSystemsRun && this.systemsActive) {
      this.systemsActive = false;
      hooks._stopSystems?.();
    }

    const shouldCommsRun = state.isActive && state.channels.communications.enabled;
    if (shouldCommsRun && !this.commsActive) {
      this.commsActive = true;
      hooks._startComms?.();
    } else if (!shouldCommsRun && this.commsActive) {
      this.commsActive = false;
      hooks._stopComms?.();
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
      // Perceptual meter curve so quieter high-frequency channels remain readable
      result[ch.id] = rms > 0.0005 ? Math.min(1, Math.pow(rms * 8.5, 0.58)) : 0.06;
    }

    return result;
  }

  public dispose(): void {
    this.systemsActive = false;
    this.commsActive = false;
    for (const ch of CHANNELS) {
      this.channels[ch.id]?.cleanup();
    }
    this.channels = {};
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.masterGain = null;
  }
}
