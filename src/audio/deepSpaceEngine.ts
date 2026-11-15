import {
  ACOUSTIC_BYPASS_LOWPASS_HZ,
  type AcousticProfile,
  type AcousticProfileId,
  DEFAULT_ACOUSTIC_PROFILE_ID,
  applySpatialOffset,
  getAcousticProfile,
} from './acousticProfiles';
import {
  type AmbientEventDescriptor,
  type AmbientEventType,
  computeAmbientEventDelayMs,
  getEligibleAmbientEvents,
  selectAmbientEvent,
} from './ambientEvents';
import {
  CHANNELS,
  type ChannelId,
  type MixerState,
  effectiveChannelGain,
  sliderToGain,
} from './mixerState';
import {
  CHANNEL_SPATIAL_PROFILES,
  type ChannelSpatialProfile,
  LISTENER_FORWARD,
  LISTENER_POSITION,
  LISTENER_UP,
  type SpatialTrajectory,
  type SpatialVec3,
  computeDistanceAttenuation,
  computeDistanceLowpassHz,
  computeFallbackStereoPan,
  sampleCommunicationsTrajectory,
  sampleHullCreakTrajectory,
  sampleHullGroanTrajectory,
  sampleHullHeavyFlexTrajectory,
  sampleHullSurroundingTrajectory,
  sampleSystemsTransientPosition,
} from './spatialLayout';
import {
  type HullCreakParams,
  type HullGroanParams,
  type HullHeavyFlexParams,
  type HullScheduleState,
  createInitialHullSchedule,
  evaluateHullScheduleStep,
  getNextHullWakeDelayMs,
  reanchorHullScheduleAfterResume,
} from './hullScheduler';

interface ChannelAudioNodes {
  gain: GainNode;
  eventBus: GainNode;
  analyser: AnalyserNode;
  applyProfile: (profile: AcousticProfile, now: number) => void;
  start?: () => void;
  pause?: () => void;
  stop?: () => void;
  cleanup: () => void;
}

interface SpatialVoiceConfig {
  startPos: SpatialVec3;
  endPos?: SpatialVec3;
  startTime?: number;
  durationSec?: number;
  panningModel: 'HRTF' | 'equalpower';
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  distanceGain?: number;
  airAbsorptionHz?: number | null;
  lowShelfGainDb?: number;
  mutable?: boolean;
}

interface SpatialBusUpdateParams {
  pos: SpatialVec3;
  refDistance: number;
  rolloffFactor: number;
  distanceGain: number;
  airAbsorptionHz: number | null;
  lowShelfGainDb: number;
  now: number;
}

interface SpatialBusHandle {
  input: AudioNode;
  update?: (params: SpatialBusUpdateParams) => void;
  disconnect: () => void;
}

interface AcousticReflectionBusHandle {
  input: GainNode;
  applyProfile: (profile: AcousticProfile, now: number) => void;
  disconnect: () => void;
}

export interface DeepSpaceEngineOptions {
  onAmbientEvent?: (event: AmbientEventDescriptor | null) => void;
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
 * Configures the Web Audio AudioListener at the center of the spacecraft's
 * operational area facing forward (-Z), supporting both modern AudioParam
 * properties and legacy setter methods.
 */
function configureSpatialListener(ctx: AudioContext): void {
  const listener = ctx.listener as AudioListener & {
    setPosition?: (x: number, y: number, z: number) => void;
    setOrientation?: (
      fx: number,
      fy: number,
      fz: number,
      ux: number,
      uy: number,
      uz: number,
    ) => void;
  };
  if (!listener) return;

  const now = ctx.currentTime;
  try {
    if ('positionX' in listener && listener.positionX) {
      listener.positionX.setValueAtTime(LISTENER_POSITION.x, now);
      listener.positionY.setValueAtTime(LISTENER_POSITION.y, now);
      listener.positionZ.setValueAtTime(LISTENER_POSITION.z, now);
    } else if (typeof listener.setPosition === 'function') {
      listener.setPosition(LISTENER_POSITION.x, LISTENER_POSITION.y, LISTENER_POSITION.z);
    }

    if ('forwardX' in listener && listener.forwardX && listener.upX) {
      listener.forwardX.setValueAtTime(LISTENER_FORWARD.x, now);
      listener.forwardY.setValueAtTime(LISTENER_FORWARD.y, now);
      listener.forwardZ.setValueAtTime(LISTENER_FORWARD.z, now);
      listener.upX.setValueAtTime(LISTENER_UP.x, now);
      listener.upY.setValueAtTime(LISTENER_UP.y, now);
      listener.upZ.setValueAtTime(LISTENER_UP.z, now);
    } else if (typeof listener.setOrientation === 'function') {
      listener.setOrientation(
        LISTENER_FORWARD.x,
        LISTENER_FORWARD.y,
        LISTENER_FORWARD.z,
        LISTENER_UP.x,
        LISTENER_UP.y,
        LISTENER_UP.z,
      );
    }
  } catch {
    // Ignore unsupported listener mutations in constrained Web Audio implementations
  }
}

function setPannerPositionAt(panner: PannerNode, pos: SpatialVec3, time: number): void {
  if ('positionX' in panner && panner.positionX) {
    panner.positionX.setValueAtTime(pos.x, time);
    panner.positionY.setValueAtTime(pos.y, time);
    panner.positionZ.setValueAtTime(pos.z, time);
  } else {
    const legacy = panner as PannerNode & {
      setPosition?: (x: number, y: number, z: number) => void;
    };
    if (typeof legacy.setPosition === 'function') {
      legacy.setPosition(pos.x, pos.y, pos.z);
    }
  }
}

function rampPannerPositionTo(panner: PannerNode, pos: SpatialVec3, endTime: number): void {
  if ('positionX' in panner && panner.positionX) {
    panner.positionX.linearRampToValueAtTime(pos.x, endTime);
    panner.positionY.linearRampToValueAtTime(pos.y, endTime);
    panner.positionZ.linearRampToValueAtTime(pos.z, endTime);
  }
}

/**
 * Creates a safe 3D spatial bus routing `input -> [optional air-absorption lowpass] ->
 * [distance trim] -> PannerNode (HRTF or equalpower) -> dest`, falling back cleanly to
 * StereoPannerNode + distance GainNode if PannerNode or HRTF is unsupported.
 */
function createSpatialBus(
  ctx: AudioContext,
  dest: AudioNode,
  config: SpatialVoiceConfig,
): SpatialBusHandle {
  const {
    startPos,
    endPos,
    startTime = ctx.currentTime,
    durationSec = 0,
    panningModel,
    refDistance,
    maxDistance,
    rolloffFactor,
    distanceGain = 1,
    airAbsorptionHz = null,
    lowShelfGainDb = 0,
    mutable = false,
  } = config;

  const chain: AudioNode[] = [];
  let lowShelfFilter: BiquadFilterNode | null = null;
  let airFilter: BiquadFilterNode | null = null;
  let trimGain: GainNode | null = null;
  let pannerNode: PannerNode | null = null;
  let fallbackAttenGain: GainNode | null = null;
  let fallbackStereoNode: StereoPannerNode | null = null;

  if (mutable || lowShelfGainDb !== 0) {
    lowShelfFilter = ctx.createBiquadFilter();
    lowShelfFilter.type = 'lowshelf';
    lowShelfFilter.frequency.value = 105;
    lowShelfFilter.Q.value = 0.7;
    lowShelfFilter.gain.value = lowShelfGainDb;
    chain.push(lowShelfFilter);
  }

  if (mutable || airAbsorptionHz !== null) {
    airFilter = ctx.createBiquadFilter();
    airFilter.type = 'lowpass';
    airFilter.frequency.value = airAbsorptionHz ?? ACOUSTIC_BYPASS_LOWPASS_HZ;
    airFilter.Q.value = 0.65;
    chain.push(airFilter);
  }

  let usedPanner = false;
  if (typeof ctx.createPanner === 'function') {
    try {
      const panner = ctx.createPanner();
      panner.distanceModel = 'inverse';
      panner.refDistance = refDistance;
      panner.maxDistance = maxDistance;
      panner.rolloffFactor = rolloffFactor;
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 0;

      try {
        panner.panningModel = panningModel;
      } catch {
        panner.panningModel = 'equalpower';
      }

      setPannerPositionAt(panner, startPos, startTime);
      if (
        endPos &&
        durationSec > 0.05 &&
        (endPos.x !== startPos.x || endPos.y !== startPos.y || endPos.z !== startPos.z)
      ) {
        rampPannerPositionTo(panner, endPos, startTime + durationSec);
      }

      if (mutable || distanceGain !== 1) {
        trimGain = ctx.createGain();
        trimGain.gain.value = distanceGain;
        chain.push(trimGain);
      }
      chain.push(panner);
      pannerNode = panner;
      usedPanner = true;
    } catch {
      // Fall through to StereoPannerNode fallback
    }
  }

  if (!usedPanner) {
    const attenGain = ctx.createGain();
    const startAtten = computeDistanceAttenuation(startPos, refDistance, rolloffFactor) * distanceGain;
    attenGain.gain.setValueAtTime(startAtten, startTime);
    if (endPos && durationSec > 0.05) {
      const endAtten = computeDistanceAttenuation(endPos, refDistance, rolloffFactor) * distanceGain;
      attenGain.gain.linearRampToValueAtTime(endAtten, startTime + durationSec);
    }
    chain.push(attenGain);
    fallbackAttenGain = attenGain;

    if (typeof ctx.createStereoPanner === 'function') {
      const stereo = ctx.createStereoPanner();
      stereo.pan.setValueAtTime(computeFallbackStereoPan(startPos), startTime);
      if (
        endPos &&
        durationSec > 0.05 &&
        (endPos.x !== startPos.x || endPos.z !== startPos.z)
      ) {
        stereo.pan.linearRampToValueAtTime(
          computeFallbackStereoPan(endPos),
          startTime + durationSec,
        );
      }
      chain.push(stereo);
      fallbackStereoNode = stereo;
    }
  }

  if (chain.length > 0) {
    for (let i = 0; i < chain.length - 1; i += 1) {
      chain[i].connect(chain[i + 1]);
    }
    chain[chain.length - 1].connect(dest);
    return {
      input: chain[0],
      update: mutable
        ? (params: SpatialBusUpdateParams) => {
            if (lowShelfFilter) {
              smoothSetParam(lowShelfFilter.gain, params.lowShelfGainDb, params.now, 0.08);
            }
            if (airFilter) {
              smoothSetParam(
                airFilter.frequency,
                params.airAbsorptionHz ?? ACOUSTIC_BYPASS_LOWPASS_HZ,
                params.now,
                0.08,
              );
            }
            if (pannerNode) {
              pannerNode.refDistance = params.refDistance;
              pannerNode.rolloffFactor = params.rolloffFactor;
              if (trimGain) {
                smoothSetParam(trimGain.gain, params.distanceGain, params.now, 0.08);
              }
              if ('positionX' in pannerNode && pannerNode.positionX) {
                smoothSetParam(pannerNode.positionX, params.pos.x, params.now, 0.09);
                smoothSetParam(pannerNode.positionY, params.pos.y, params.now, 0.09);
                smoothSetParam(pannerNode.positionZ, params.pos.z, params.now, 0.09);
              } else {
                setPannerPositionAt(pannerNode, params.pos, params.now);
              }
            } else if (fallbackAttenGain) {
              const targetAtten =
                computeDistanceAttenuation(params.pos, params.refDistance, params.rolloffFactor) *
                params.distanceGain;
              smoothSetParam(fallbackAttenGain.gain, targetAtten, params.now, 0.08);
              if (fallbackStereoNode) {
                smoothSetParam(
                  fallbackStereoNode.pan,
                  computeFallbackStereoPan(params.pos),
                  params.now,
                  0.08,
                );
              }
            }
          }
        : undefined,
      disconnect: () => {
        for (const node of chain) {
          node.disconnect();
        }
      },
    };
  }

  // Ultimate passthrough safeguard
  const passthrough = ctx.createGain();
  passthrough.gain.value = distanceGain;
  passthrough.connect(dest);
  return {
    input: passthrough,
    disconnect: () => {
      passthrough.disconnect();
    },
  };
}

/**
 * Lightweight stereo early-reflection bus using native Web Audio DelayNode &
 * BiquadFilterNode pairs. Strips sub-bass below 160 Hz so deep Reactor/Engine
 * fundamentals stay tight and phase-clean across all acoustic profiles.
 */
function createAcousticReflectionBus(
  ctx: AudioContext,
  masterGain: AudioNode,
  initialProfile: AcousticProfile,
): AcousticReflectionBusHandle {
  const input = ctx.createGain();
  input.gain.value = 1;

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 160;
  highpass.Q.value = 0.7;

  const dampLowpass = ctx.createBiquadFilter();
  dampLowpass.type = 'lowpass';
  dampLowpass.frequency.value = initialProfile.reflection.dampingHz;
  dampLowpass.Q.value = 0.65;

  const delayL = ctx.createDelay(0.15);
  delayL.delayTime.value = initialProfile.reflection.delayLeftSec;

  const delayR = ctx.createDelay(0.15);
  delayR.delayTime.value = initialProfile.reflection.delayRightSec;

  const feedbackL = ctx.createGain();
  feedbackL.gain.value = Math.min(0.35, initialProfile.reflection.feedbackGain);

  const feedbackR = ctx.createGain();
  feedbackR.gain.value = Math.min(0.35, initialProfile.reflection.feedbackGain);

  const wetGain = ctx.createGain();
  wetGain.gain.value = initialProfile.reflection.wetGain;

  const merger =
    typeof ctx.createChannelMerger === 'function' ? ctx.createChannelMerger(2) : null;

  input.connect(highpass);
  highpass.connect(dampLowpass);
  dampLowpass.connect(delayL);
  dampLowpass.connect(delayR);

  // Subtle cross-coupled early bounce (loop gain = feedback^2 <= 0.12)
  delayL.connect(feedbackL);
  feedbackL.connect(delayR);
  delayR.connect(feedbackR);
  feedbackR.connect(delayL);

  if (merger) {
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);
    merger.connect(wetGain);
  } else {
    delayL.connect(wetGain);
    delayR.connect(wetGain);
  }
  wetGain.connect(masterGain);

  return {
    input,
    applyProfile: (profile: AcousticProfile, now: number) => {
      const r = profile.reflection;
      smoothSetParam(dampLowpass.frequency, r.dampingHz, now, 0.08);
      smoothSetParam(delayL.delayTime, r.delayLeftSec, now, 0.12);
      smoothSetParam(delayR.delayTime, r.delayRightSec, now, 0.12);
      const safeFeedback = Math.min(0.35, r.feedbackGain);
      smoothSetParam(feedbackL.gain, safeFeedback, now, 0.08);
      smoothSetParam(feedbackR.gain, safeFeedback, now, 0.08);
      smoothSetParam(wetGain.gain, r.wetGain, now, 0.08);
    },
    disconnect: () => {
      input.disconnect();
      highpass.disconnect();
      dampLowpass.disconnect();
      delayL.disconnect();
      delayR.disconnect();
      feedbackL.disconnect();
      feedbackR.disconnect();
      if (merger) {
        merger.disconnect();
      }
      wetGain.disconnect();
    },
  };
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

  public stopAll(now: number, immediate = false): void {
    for (const voice of this.voices) {
      voice.stop(immediate ? now : now + 0.035);
      if (immediate) {
        voice.disconnect();
      }
    }
    if (immediate) {
      this.voices.clear();
    }
  }
}

export class DeepSpaceEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private reflectionBus: AcousticReflectionBusHandle | null = null;
  private channels: Partial<Record<ChannelId, ChannelAudioNodes>> = {};
  private analyserScratch = new Float32Array(256);

  private activeAcousticProfileId: AcousticProfileId = DEFAULT_ACOUSTIC_PROFILE_ID;
  private latestState: MixerState | null = null;
  private suspendTimer: number | null = null;
  private disposed = false;

  // Optional procedural Ambient Event System state
  private onAmbientEvent?: (event: AmbientEventDescriptor | null) => void;
  private eventVoices = new TransientVoicePool();
  private eventNoiseBuf: AudioBuffer | null = null;
  private eventTimerId: number | null = null;
  private activeEventTimerId: number | null = null;
  private activeEventTarget: ChannelId | null = null;
  private eventGeneration = 0;
  private lastEventTriggeredAt: Partial<Record<AmbientEventType, number>> = {};
  private schedulerRunning = false;
  private overrideEventDelayMs: number | null = null;

  private readonly handleVisibilityOrFocus = (): void => {
    if (this.disposed) return;

    if (typeof document !== 'undefined' && document.hidden) {
      this.clearEventScheduleTimer();
      this.channels.hull?.pause?.();
      return;
    }

    if (!this.ctx || !this.latestState?.isActive) return;

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
    if (this.latestState.channels.hull.enabled) {
      this.channels.hull?.start?.();
    }
    // Resume ambient event scheduling with a fresh delay (never firing immediately on tab return)
    if (this.latestState.ambientEventsEnabled && this.eventTimerId === null) {
      this.scheduleNextAmbientEvent(true);
    }
  };

  constructor(options?: DeepSpaceEngineOptions) {
    this.onAmbientEvent = options?.onAmbientEvent;

    if (typeof window !== 'undefined') {
      const raw = new URLSearchParams(window.location.search).get('ambientEventMs');
      if (raw !== null) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) {
          this.overrideEventDelayMs = Math.max(80, parsed);
        }
      }
      window.addEventListener('focus', this.handleVisibilityOrFocus);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityOrFocus);
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

    // Gentle transparent mastering compressor so all 6 channels blend without clipping
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 20;
    compressor.ratio.value = 3.2;
    compressor.attack.value = 0.015;
    compressor.release.value = 0.3;

    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    configureSpatialListener(ctx);

    const initialProfileId =
      this.latestState?.acousticProfileId ?? DEFAULT_ACOUSTIC_PROFILE_ID;
    this.activeAcousticProfileId = initialProfileId;
    const initialProfile = getAcousticProfile(initialProfileId);

    this.ctx = ctx;
    this.masterGain = masterGain;
    this.compressor = compressor;
    this.reflectionBus = createAcousticReflectionBus(ctx, masterGain, initialProfile);

    this.channels.reactor = this.buildReactorChannel(ctx, masterGain);
    this.channels.engines = this.buildEnginesChannel(ctx, masterGain);
    this.channels.ventilation = this.buildVentilationChannel(ctx, masterGain);
    this.channels.systems = this.buildSystemsChannel(ctx, masterGain);
    this.channels.communications = this.buildCommunicationsChannel(ctx, masterGain);
    this.channels.hull = this.buildHullChannel(ctx, masterGain);

    return ctx;
  }

  private applyAcousticProfile(profileId: AcousticProfileId): void {
    this.activeAcousticProfileId = profileId;
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const profile = getAcousticProfile(profileId);
    this.reflectionBus?.applyProfile(profile, now);

    for (const ch of CHANNELS) {
      this.channels[ch.id]?.applyProfile(profile, now);
    }
  }

  private resolveChannelSpatial(
    channelId: ChannelId,
    baseStart: SpatialVec3,
    baseEnd?: SpatialVec3,
    baseAirHz?: number | null,
  ): {
    startPos: SpatialVec3;
    endPos?: SpatialVec3;
    refDistance: number;
    maxDistance: number;
    rolloffFactor: number;
    distanceGain: number;
    airAbsorptionHz: number | null;
  } {
    const baseProfile = CHANNEL_SPATIAL_PROFILES[channelId];
    const adj = getAcousticProfile(this.activeAcousticProfileId).channels[channelId];
    const startPos = applySpatialOffset(baseStart, adj.positionOffset);
    const endPos = baseEnd ? applySpatialOffset(baseEnd, adj.positionOffset) : undefined;
    return {
      startPos,
      endPos,
      refDistance: baseProfile.refDistance * adj.refDistanceScale,
      maxDistance: baseProfile.maxDistance,
      rolloffFactor: baseProfile.rolloffFactor * adj.rolloffScale,
      distanceGain: baseProfile.distanceGain * adj.distanceTrim,
      airAbsorptionHz:
        baseAirHz !== undefined && baseAirHz !== null
          ? computeDistanceLowpassHz(startPos, baseAirHz)
          : null,
    };
  }

  private createChannelBus(
    ctx: AudioContext,
    destination: AudioNode,
    channelId: ChannelId,
  ): {
    input: GainNode;
    spatialInput: GainNode;
    eventBus: GainNode;
    outputGain: GainNode;
    analyser: AnalyserNode;
    spatialProfile: ChannelSpatialProfile;
    applyProfile: (profile: AcousticProfile, now: number) => void;
    disconnectBus: () => void;
  } {
    const spatialProfile = CHANNEL_SPATIAL_PROFILES[channelId];
    const initialProfile = getAcousticProfile(this.activeAcousticProfileId);
    const initialAdj = initialProfile.channels[channelId];

    // Continuous bed path: input -> channel spatial panner -> outputGain
    const input = ctx.createGain();
    input.gain.value = 1;

    // Pre-spatialized transient & ambient-event path avoids double-panning while sharing acoustic EQ
    const spatialInput = ctx.createGain();
    spatialInput.gain.value = 1;

    const transientLowShelf = ctx.createBiquadFilter();
    transientLowShelf.type = 'lowshelf';
    transientLowShelf.frequency.value = 105;
    transientLowShelf.Q.value = 0.7;
    transientLowShelf.gain.value = initialAdj.lowShelfGainDb;

    const transientAirFilter = ctx.createBiquadFilter();
    transientAirFilter.type = 'lowpass';
    transientAirFilter.frequency.value = initialAdj.lowpassCutoffHz ?? ACOUSTIC_BYPASS_LOWPASS_HZ;
    transientAirFilter.Q.value = 0.65;

    const eventBus = ctx.createGain();
    eventBus.gain.value = 1;
    eventBus.connect(spatialInput);

    const outputGain = ctx.createGain();
    outputGain.gain.value = 0;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;

    const initialBedPos = applySpatialOffset(spatialProfile.position, initialAdj.positionOffset);
    const initialAirHz =
      spatialProfile.airAbsorptionHz !== null && initialAdj.lowpassCutoffHz !== null
        ? Math.min(spatialProfile.airAbsorptionHz, initialAdj.lowpassCutoffHz)
        : (spatialProfile.airAbsorptionHz ?? initialAdj.lowpassCutoffHz);

    const bedSpatial = createSpatialBus(ctx, outputGain, {
      startPos: initialBedPos,
      panningModel: spatialProfile.panningModel,
      refDistance: spatialProfile.refDistance * initialAdj.refDistanceScale,
      maxDistance: spatialProfile.maxDistance,
      rolloffFactor: spatialProfile.rolloffFactor * initialAdj.rolloffScale,
      distanceGain: spatialProfile.distanceGain * initialAdj.distanceTrim,
      airAbsorptionHz: initialAirHz,
      lowShelfGainDb: initialAdj.lowShelfGainDb,
      mutable: true,
    });

    const reflectionSend = ctx.createGain();
    reflectionSend.gain.value = initialAdj.reflectionSend;
    if (this.reflectionBus) {
      outputGain.connect(reflectionSend);
      reflectionSend.connect(this.reflectionBus.input);
    }

    input.connect(bedSpatial.input);
    spatialInput.connect(transientLowShelf).connect(transientAirFilter).connect(outputGain);
    outputGain.connect(analyser);
    analyser.connect(destination);

    const applyProfile = (profile: AcousticProfile, now: number) => {
      const adj = profile.channels[channelId];
      const nextPos = applySpatialOffset(spatialProfile.position, adj.positionOffset);
      const nextAirHz =
        spatialProfile.airAbsorptionHz !== null && adj.lowpassCutoffHz !== null
          ? Math.min(spatialProfile.airAbsorptionHz, adj.lowpassCutoffHz)
          : (spatialProfile.airAbsorptionHz ?? adj.lowpassCutoffHz);

      bedSpatial.update?.({
        pos: nextPos,
        refDistance: spatialProfile.refDistance * adj.refDistanceScale,
        rolloffFactor: spatialProfile.rolloffFactor * adj.rolloffScale,
        distanceGain: spatialProfile.distanceGain * adj.distanceTrim,
        airAbsorptionHz: nextAirHz,
        lowShelfGainDb: adj.lowShelfGainDb,
        now,
      });

      smoothSetParam(transientLowShelf.gain, adj.lowShelfGainDb, now, 0.08);
      smoothSetParam(
        transientAirFilter.frequency,
        adj.lowpassCutoffHz ?? ACOUSTIC_BYPASS_LOWPASS_HZ,
        now,
        0.08,
      );
      smoothSetParam(reflectionSend.gain, adj.reflectionSend, now, 0.08);
    };

    return {
      input,
      spatialInput,
      eventBus,
      outputGain,
      analyser,
      spatialProfile,
      applyProfile,
      disconnectBus: () => {
        eventBus.disconnect();
        spatialInput.disconnect();
        transientLowShelf.disconnect();
        transientAirFilter.disconnect();
        input.disconnect();
        bedSpatial.disconnect();
        reflectionSend.disconnect();
        outputGain.disconnect();
        analyser.disconnect();
      },
    };
  }

  /**
   * CH-01: Reactor — Deep, warm, continuous mechanical hum with subtle fluctuations
   */
  private buildReactorChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const { input, eventBus, outputGain, analyser, applyProfile, disconnectBus } =
      this.createChannelBus(ctx, dest, 'reactor');

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
      eventBus,
      analyser,
      applyProfile,
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
    const { input, eventBus, outputGain, analyser, applyProfile, disconnectBus } =
      this.createChannelBus(ctx, dest, 'engines');

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
      eventBus,
      analyser,
      applyProfile,
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
    const { input, eventBus, outputGain, analyser, applyProfile, disconnectBus } =
      this.createChannelBus(ctx, dest, 'ventilation');

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
      eventBus,
      analyser,
      applyProfile,
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
   * CH-04: Systems — Layered spacecraft computer environment:
   * A. Background Processing (continuous subtle electronic hum + modulated bus texture)
   * B. Telemetry Activity (varied short electronic pulses & confirmation pairs)
   * C. Machinery Relays (muted damped electro-mechanical switching clicks/ticks)
   * D. Diagnostic Sequences (coherent multi-note system check routines)
   */
  private buildSystemsChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const {
      input,
      spatialInput,
      eventBus,
      outputGain,
      analyser,
      applyProfile,
      disconnectBus,
    } = this.createChannelBus(ctx, dest, 'systems');

    // Master lowpass keeps continuous computational bed warm and non-fatiguing
    const busToneFilter = ctx.createBiquadFilter();
    busToneFilter.type = 'lowpass';
    busToneFilter.frequency.value = 1280;
    busToneFilter.Q.value = 0.65;
    busToneFilter.connect(input);

    // Sub-gate for 3D-spatialized transient voices (bypasses bed panner to preserve HRTF image)
    const activityToneFilter = ctx.createBiquadFilter();
    activityToneFilter.type = 'lowpass';
    activityToneFilter.frequency.value = 1280;
    activityToneFilter.Q.value = 0.65;
    activityToneFilter.connect(spatialInput);

    const activityGain = ctx.createGain();
    activityGain.gain.value = 0;
    activityGain.connect(activityToneFilter);

    // --- Layer A: Background Processing (continuous electronic computing texture) ---
    const procFilter = ctx.createBiquadFilter();
    procFilter.type = 'bandpass';
    procFilter.frequency.value = 310;
    procFilter.Q.value = 0.9;
    procFilter.connect(busToneFilter);

    const procGain = ctx.createGain();
    procGain.gain.value = 0.032;
    procGain.connect(procFilter);

    // Soft dual-harmonic solid-state hum (216 Hz root + 324 Hz fifth + 432 Hz octave)
    const hum1 = ctx.createOscillator();
    hum1.type = 'sine';
    hum1.frequency.value = 216;
    const hum1Gain = ctx.createGain();
    hum1Gain.gain.value = 0.55;
    hum1.connect(hum1Gain).connect(procGain);

    const hum2 = ctx.createOscillator();
    hum2.type = 'sine';
    hum2.frequency.value = 324;
    const hum2Gain = ctx.createGain();
    hum2Gain.gain.value = 0.28;
    hum2.connect(hum2Gain).connect(procGain);

    const hum3 = ctx.createOscillator();
    hum3.type = 'sine';
    hum3.frequency.value = 432;
    const hum3Gain = ctx.createGain();
    hum3Gain.gain.value = 0.14;
    hum3.connect(hum3Gain).connect(procGain);

    // Subtle incommensurate modulation for gentle electronic shimmer
    const procFilterLfo = ctx.createOscillator();
    procFilterLfo.type = 'sine';
    procFilterLfo.frequency.value = 0.11;
    const procFilterLfoGain = ctx.createGain();
    procFilterLfoGain.gain.value = 55;
    procFilterLfo.connect(procFilterLfoGain).connect(procFilter.frequency);

    const procAmpLfo = ctx.createOscillator();
    procAmpLfo.type = 'sine';
    procAmpLfo.frequency.value = 0.17;
    const procAmpLfoGain = ctx.createGain();
    procAmpLfoGain.gain.value = 0.008;
    procAmpLfo.connect(procAmpLfoGain).connect(procGain.gain);

    // Subtle continuous data-bus whisper bed (narrow-band modulated pink noise)
    const busNoiseBuf = createSeamlessNoiseBuffer(ctx, 4.7, 'pink');
    const busNoiseSrc = ctx.createBufferSource();
    busNoiseSrc.buffer = busNoiseBuf;
    busNoiseSrc.loop = true;

    const busNoiseBp = ctx.createBiquadFilter();
    busNoiseBp.type = 'bandpass';
    busNoiseBp.frequency.value = 560;
    busNoiseBp.Q.value = 2.8;

    const busNoiseGain = ctx.createGain();
    busNoiseGain.gain.value = 0.022;
    busNoiseSrc.connect(busNoiseBp).connect(busNoiseGain).connect(busToneFilter);

    const busNoiseLfo = ctx.createOscillator();
    busNoiseLfo.type = 'sine';
    busNoiseLfo.frequency.value = 0.43;
    const busNoiseLfoGain = ctx.createGain();
    busNoiseLfoGain.gain.value = 0.011;
    busNoiseLfo.connect(busNoiseLfoGain).connect(busNoiseGain.gain);

    hum1.start();
    hum2.start();
    hum3.start();
    procFilterLfo.start();
    procAmpLfo.start();
    busNoiseSrc.start();
    busNoiseLfo.start();

    // --- Reusable damped relay impulse buffer for Layer C (Machinery Relays) ---
    const relayLength = Math.floor(ctx.sampleRate * 0.032);
    const relayBuf = ctx.createBuffer(1, relayLength, ctx.sampleRate);
    const relayData = relayBuf.getChannelData(0);
    for (let i = 0; i < relayLength; i += 1) {
      const t = i / relayLength;
      // Fast soft transient envelope without harsh peak spike
      const env = Math.sin(Math.min(1, t * 14) * Math.PI * 0.5) * Math.exp(-t * 9.5);
      relayData[i] = (Math.random() * 2 - 1) * env;
    }

    // Coherent telemetry pitch family (G4, A4, B4, D5, E5, G5)
    const scale = [392.0, 440.0, 493.88, 587.33, 659.25, 783.99];
    // Structured diagnostic phrase contours (scale indices)
    const diagnosticContours = [
      [0, 2, 3, 5],
      [4, 2, 3, 1, 2],
      [0, 3, 5, 3],
      [1, 3, 4, 2],
    ];

    const voices = new TransientVoicePool();
    let timerId: number | null = null;
    let running = false;
    let eventCounter = 0;
    let lastContourIdx = -1;

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    const spawnTone = (
      start: number,
      freq: number,
      duration: number,
      peakGain: number,
      position: SpatialVec3,
      harmonicBlend = 0,
    ) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      const spatialCfg = this.resolveChannelSpatial('systems', position);
      const spatial = createSpatialBus(ctx, activityGain, {
        ...spatialCfg,
        startTime: start,
        panningModel: 'HRTF',
      });

      osc.type = 'sine';
      osc.frequency.value = freq;

      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(peakGain, start + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      osc.connect(env).connect(spatial.input);

      if (harmonicBlend > 0) {
        const sub = ctx.createOscillator();
        const subEnv = ctx.createGain();
        sub.type = 'triangle';
        sub.frequency.value = freq * 0.5;
        subEnv.gain.setValueAtTime(0.0001, start);
        subEnv.gain.linearRampToValueAtTime(peakGain * harmonicBlend, start + 0.015);
        subEnv.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        sub.connect(subEnv).connect(spatial.input);

        let remaining = 2;
        const releaseSpatial = () => {
          remaining -= 1;
          if (remaining <= 0) {
            spatial.disconnect();
          }
        };
        voices.track(osc, () => {
          osc.disconnect();
          env.disconnect();
          releaseSpatial();
        });
        voices.track(sub, () => {
          sub.disconnect();
          subEnv.disconnect();
          releaseSpatial();
        });
        osc.start(start);
        osc.stop(start + duration + 0.025);
        sub.start(start);
        sub.stop(start + duration + 0.025);
      } else {
        voices.track(osc, () => {
          osc.disconnect();
          env.disconnect();
          spatial.disconnect();
        });
        osc.start(start);
        osc.stop(start + duration + 0.025);
      }
    };

    const spawnRelayTick = (
      start: number,
      centerFreq: number,
      peakGain: number,
      position: SpatialVec3,
    ) => {
      const src = ctx.createBufferSource();
      src.buffer = relayBuf;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = centerFreq;
      bp.Q.value = 2.4;

      const env = ctx.createGain();
      env.gain.value = peakGain;

      const spatialCfg = this.resolveChannelSpatial('systems', position);
      const spatial = createSpatialBus(ctx, activityGain, {
        ...spatialCfg,
        startTime: start,
        panningModel: 'HRTF',
      });

      src.connect(bp).connect(env).connect(spatial.input);
      voices.track(src, () => {
        src.disconnect();
        bp.disconnect();
        env.disconnect();
        spatial.disconnect();
      });
      src.start(start);
      src.stop(start + 0.036);
    };

    const scheduleNextEvent = () => {
      if (!running || this.disposed || this.ctx !== ctx) return;

      // Pause scheduling cleanly while backgrounded; visibilitychange restarts it on return
      if (typeof document !== 'undefined' && document.hidden) {
        timerId = null;
        return;
      }

      let nextDelayMs = 1900 + Math.random() * 2100;

      if (ctx.state === 'running') {
        const now = ctx.currentTime;
        eventCounter += 1;

        // Layer D: Intentional diagnostic sequence every ~5-6 cycles (~12-18s)
        if (eventCounter % 5 === 0) {
          let contourIdx = Math.floor(Math.random() * diagnosticContours.length);
          if (contourIdx === lastContourIdx) {
            contourIdx = (contourIdx + 1) % diagnosticContours.length;
          }
          lastContourIdx = contourIdx;
          const contour = diagnosticContours[contourIdx];
          const stepSec = 0.145 + Math.random() * 0.03;
          const transpose = Math.random() < 0.5 ? 1 : 0.8909; // G4 or F4 root center
          const pos = sampleSystemsTransientPosition();

          for (let i = 0; i < contour.length; i += 1) {
            const isFinal = i === contour.length - 1;
            const freq = scale[contour[i]] * transpose;
            spawnTone(
              now + i * stepSec,
              freq,
              isFinal ? 0.24 : 0.14,
              isFinal ? 0.056 : 0.044,
              pos,
              0.22,
            );
          }
          nextDelayMs = 2800 + Math.random() * 2200;
        } else {
          const roll = Math.random();

          if (roll < 0.46) {
            // Layer B: Telemetry pulse / confirmation pair or register burst
            const pos = sampleSystemsTransientPosition();
            if (Math.random() < 0.65) {
              const baseIdx = Math.floor(Math.random() * scale.length);
              const secondIdx = (baseIdx + (Math.random() < 0.6 ? 2 : 1)) % scale.length;
              spawnTone(now, scale[baseIdx], 0.09, 0.052, pos);
              spawnTone(now + 0.115 + Math.random() * 0.03, scale[secondIdx], 0.13, 0.048, pos);
            } else {
              // Quiet 3-4 step data register check
              const count = 3 + Math.floor(Math.random() * 2);
              const baseIdx = Math.floor(Math.random() * 4);
              for (let i = 0; i < count; i += 1) {
                const start = now + i * (0.072 + Math.random() * 0.015);
                const freq = scale[(baseIdx + i) % scale.length];
                spawnTone(start, freq, 0.065, 0.036, pos);
              }
            }
          } else if (roll < 0.8) {
            // Layer C: Muted machinery relay switching (single tick or latch/release pair)
            const pos = sampleSystemsTransientPosition();
            const baseFreq = 430 + Math.random() * 280;
            spawnRelayTick(now, baseFreq, 0.075, pos);
            if (Math.random() < 0.58) {
              const releaseOffset = 0.068 + Math.random() * 0.045;
              spawnRelayTick(now + releaseOffset, baseFreq + (Math.random() < 0.5 ? 110 : -85), 0.055, pos);
            }
          } else {
            // Combined relay switch followed immediately by telemetry confirmation pulse
            const pos = sampleSystemsTransientPosition();
            spawnRelayTick(now, 490 + Math.random() * 180, 0.065, pos);
            const toneFreq = scale[Math.floor(Math.random() * scale.length)];
            spawnTone(now + 0.085, toneFreq, 0.11, 0.045, pos);
          }
        }
      }

      timerId = window.setTimeout(scheduleNextEvent, nextDelayMs);
    };

    const start = () => {
      if (running && timerId !== null) return;
      running = true;
      smoothSetParam(activityGain.gain, 1, ctx.currentTime, 0.035);
      clearTimer();
      timerId = window.setTimeout(scheduleNextEvent, 320);
    };

    const stop = () => {
      if (!running && timerId === null) return;
      running = false;
      clearTimer();
      const now = ctx.currentTime;
      activityGain.gain.cancelScheduledValues(now);
      activityGain.gain.setValueAtTime(activityGain.gain.value, now);
      activityGain.gain.linearRampToValueAtTime(0, now + 0.025);
      voices.stopAll(now, ctx.state !== 'running');
    };

    return {
      gain: outputGain,
      eventBus,
      analyser,
      applyProfile,
      start,
      stop,
      cleanup: () => {
        running = false;
        clearTimer();
        voices.stopAll(ctx.currentTime, true);
        for (const src of [hum1, hum2, hum3, procFilterLfo, procAmpLfo, busNoiseSrc, busNoiseLfo]) {
          try {
            src.stop();
          } catch {
            // Ignore already stopped
          }
          src.disconnect();
        }
        hum1Gain.disconnect();
        hum2Gain.disconnect();
        hum3Gain.disconnect();
        procGain.disconnect();
        procFilter.disconnect();
        procFilterLfoGain.disconnect();
        procAmpLfoGain.disconnect();
        busNoiseBp.disconnect();
        busNoiseGain.disconnect();
        busNoiseLfoGain.disconnect();
        activityGain.disconnect();
        activityToneFilter.disconnect();
        busToneFilter.disconnect();
        disconnectBus();
      },
    };
  }

  /**
   * CH-05: Communications — Deep Space Signal Reception:
   * A. Receiver Standby (almost silent narrowband electronic receiver floor, no broadband wind/hiss)
   * B. Signal Acquisition (distant drifting narrowband FM carrier tones)
   * C. Transmission Fragments (related irregular FSK-style narrow-interval digital clusters)
   * D. Signal Interference & Loss (restrained narrowband RF interference & soft squelch cutoffs)
   */
  private buildCommunicationsChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const {
      input,
      spatialInput,
      eventBus,
      outputGain,
      analyser,
      applyProfile,
      disconnectBus,
    } = this.createChannelBus(ctx, dest, 'communications');

    // Band-limit continuous Communications standby bed to clean narrow receiver spectrum
    const commsHighpass = ctx.createBiquadFilter();
    commsHighpass.type = 'highpass';
    commsHighpass.frequency.value = 220;
    commsHighpass.Q.value = 0.7;

    const commsLowpass = ctx.createBiquadFilter();
    commsLowpass.type = 'lowpass';
    commsLowpass.frequency.value = 1650;
    commsLowpass.Q.value = 0.7;

    commsHighpass.connect(commsLowpass).connect(input);

    // Stereo-preserving band-limiting for 3D-spatialized transient transmissions
    const activityHighpass = ctx.createBiquadFilter();
    activityHighpass.type = 'highpass';
    activityHighpass.frequency.value = 220;
    activityHighpass.Q.value = 0.7;

    const activityLowpass = ctx.createBiquadFilter();
    activityLowpass.type = 'lowpass';
    activityLowpass.frequency.value = 1650;
    activityLowpass.Q.value = 0.7;

    activityHighpass.connect(activityLowpass).connect(spatialInput);

    // Sub-gate for transient transmissions so disabling Communications fades cleanly without clicks
    const activityGain = ctx.createGain();
    activityGain.gain.value = 0;
    activityGain.connect(activityHighpass);

    // --- Layer A: Receiver Standby (faint narrowband electronic texture, nearly silent) ---
    const standbyNoiseBuf = createSeamlessNoiseBuffer(ctx, 13.1, 'pink');
    const standbySrc = ctx.createBufferSource();
    standbySrc.buffer = standbyNoiseBuf;
    standbySrc.loop = true;

    const standbyBp = ctx.createBiquadFilter();
    standbyBp.type = 'bandpass';
    standbyBp.frequency.value = 740;
    standbyBp.Q.value = 6.5; // High-Q tuned IF stage avoids rushing wind/rain sound

    const standbyGain = ctx.createGain();
    standbyGain.gain.value = 0.011;
    standbySrc.connect(standbyBp).connect(standbyGain).connect(commsHighpass);

    // Very faint solid-state local oscillator floor
    const standbyOsc = ctx.createOscillator();
    standbyOsc.type = 'sine';
    standbyOsc.frequency.value = 148;
    const standbyOscGain = ctx.createGain();
    standbyOscGain.gain.value = 0.005;
    standbyOsc.connect(standbyOscGain).connect(commsHighpass);

    // Slow narrowband tuning drift on the standby IF filter
    const standbyDriftLfo = ctx.createOscillator();
    standbyDriftLfo.type = 'sine';
    standbyDriftLfo.frequency.value = 0.045;
    const standbyDriftGain = ctx.createGain();
    standbyDriftGain.gain.value = 42;
    standbyDriftLfo.connect(standbyDriftGain).connect(standbyBp.frequency);

    standbySrc.start();
    standbyOsc.start();
    standbyDriftLfo.start();

    const voices = new TransientVoicePool();
    let timerId: number | null = null;
    let running = false;
    let cycleCount = 0;

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    /**
     * Layer D helper: soft electronic squelch / narrowband interference burst
     */
    const spawnSquelchOrInterference = (
      start: number,
      centerFreq: number,
      duration: number,
      peakGain: number,
      trajectory: SpatialTrajectory,
      sweepDown = true,
    ) => {
      const src = ctx.createBufferSource();
      src.buffer = standbyNoiseBuf;
      src.loop = true;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(centerFreq, start);
      bp.frequency.exponentialRampToValueAtTime(
        Math.max(280, sweepDown ? centerFreq * 0.48 : centerFreq * 1.25),
        start + duration,
      );
      bp.Q.value = 8.5; // Steep electronic resonance rather than broadband noise

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(peakGain, start + Math.min(0.04, duration * 0.25));
      env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      const spatialCfg = this.resolveChannelSpatial(
        'communications',
        trajectory.start,
        trajectory.end,
        1850,
      );
      const spatial = createSpatialBus(ctx, activityGain, {
        ...spatialCfg,
        startTime: start,
        durationSec: duration,
        panningModel: 'HRTF',
      });

      src.connect(bp).connect(env).connect(spatial.input);
      voices.track(src, () => {
        src.disconnect();
        bp.disconnect();
        env.disconnect();
        spatial.disconnect();
      });
      src.start(start, Math.random() * 9);
      src.stop(start + duration + 0.03);
    };

    /**
     * Layer B: Distant drifting narrowband carrier with subtle instability (FM wobble)
     */
    const spawnCarrierAcquisition = (
      start: number,
      duration: number,
      peakGain: number,
      trajectory: SpatialTrajectory,
      abruptLoss: boolean,
    ) => {
      const startFreq = 440 + Math.random() * 560;
      const driftDelta = (Math.random() - 0.5) * 48;

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(startFreq, start);
      osc.frequency.linearRampToValueAtTime(startFreq + driftDelta, start + duration);

      // Subtle instability / ionospheric flutter
      const fmOsc = ctx.createOscillator();
      fmOsc.type = 'sine';
      fmOsc.frequency.value = 1.6 + Math.random() * 2.8;
      const fmGain = ctx.createGain();
      fmGain.gain.value = 2.5 + Math.random() * 5.5;
      fmOsc.connect(fmGain).connect(osc.frequency);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = startFreq + driftDelta * 0.5;
      bp.Q.value = 4.5;

      const env = ctx.createGain();
      const attack = Math.min(0.9, duration * 0.42);
      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(peakGain, start + attack);

      if (abruptLoss) {
        const cutoffTime = start + duration * 0.78;
        env.gain.setValueAtTime(peakGain * 0.85, cutoffTime);
        env.gain.exponentialRampToValueAtTime(0.0001, cutoffTime + 0.045);
        spawnSquelchOrInterference(
          cutoffTime - 0.015,
          startFreq + driftDelta,
          0.16,
          0.035,
          { start: trajectory.end, end: trajectory.end },
          true,
        );
      } else {
        env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      }

      const spatialCfg = this.resolveChannelSpatial(
        'communications',
        trajectory.start,
        trajectory.end,
        1850,
      );
      const spatial = createSpatialBus(ctx, activityGain, {
        ...spatialCfg,
        startTime: start,
        durationSec: duration,
        panningModel: 'HRTF',
      });

      osc.connect(bp).connect(env).connect(spatial.input);

      voices.track(osc, () => {
        osc.disconnect();
        bp.disconnect();
        env.disconnect();
        spatial.disconnect();
      });
      voices.track(fmOsc, () => {
        fmOsc.disconnect();
        fmGain.disconnect();
      });

      osc.start(start);
      fmOsc.start(start);
      osc.stop(start + duration + 0.04);
      fmOsc.stop(start + duration + 0.04);
    };

    /**
     * Layer C: Fragmented narrow-interval FSK-style transmission cluster
     */
    const spawnTransmissionFragment = (start: number, trajectory: SpatialTrajectory) => {
      const baseFreq = 540 + Math.random() * 380;
      // Narrow related frequency ratios (avoiding musical scales or Morse regularity)
      const ratios = [1.0, 1.055, 1.125];
      const count = 3 + Math.floor(Math.random() * 4);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = baseFreq * 1.06;
      bp.Q.value = 4.0;

      const estDuration = count * 0.19;
      const spatialCfg = this.resolveChannelSpatial(
        'communications',
        trajectory.start,
        trajectory.end,
        1850,
      );
      const spatial = createSpatialBus(ctx, activityGain, {
        ...spatialCfg,
        startTime: start,
        durationSec: estDuration,
        panningModel: 'HRTF',
      });
      bp.connect(spatial.input);

      let cursor = start;
      // Shape overall cluster fade so the fragment feels like a passing packet
      const peakScale = 0.032 + Math.random() * 0.018;
      let lastEnd = start;
      let remaining = count;

      for (let i = 0; i < count; i += 1) {
        const pulseDur = 0.048 + Math.random() * 0.085;
        const gap = 0.055 + Math.random() * 0.13;
        const ratio = ratios[(i + Math.floor(Math.random() * 2)) % ratios.length];
        const fadeFactor = 0.55 + 0.45 * Math.sin(((i + 0.5) / count) * Math.PI);

        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = baseFreq * ratio;

        env.gain.setValueAtTime(0.0001, cursor);
        env.gain.linearRampToValueAtTime(peakScale * fadeFactor, cursor + 0.012);
        env.gain.exponentialRampToValueAtTime(0.0001, cursor + pulseDur);

        osc.connect(env).connect(bp);
        voices.track(osc, () => {
          osc.disconnect();
          env.disconnect();
          remaining -= 1;
          if (remaining <= 0) {
            bp.disconnect();
            spatial.disconnect();
          }
        });
        osc.start(cursor);
        osc.stop(cursor + pulseDur + 0.02);

        lastEnd = cursor + pulseDur;
        cursor += pulseDur + gap;
      }

      // Occasional soft squelch tail as the fragment breaks apart
      if (Math.random() < 0.65) {
        spawnSquelchOrInterference(
          lastEnd - 0.01,
          baseFreq * 1.08,
          0.15,
          0.03,
          { start: trajectory.end, end: trajectory.end },
          true,
        );
      }
    };

    const scheduleSignal = () => {
      if (!running || this.disposed || this.ctx !== ctx) return;

      // Pause cleanly while tab is backgrounded; visibilitychange restarts on return
      if (typeof document !== 'undefined' && document.hidden) {
        timerId = null;
        return;
      }

      let nextDelayMs = 4200 + Math.random() * 4800;

      if (ctx.state === 'running') {
        const now = ctx.currentTime;
        cycleCount += 1;

        // Occasional longer drifting signal sequence (~every 7th cycle)
        if (cycleCount % 7 === 0) {
          const longDur = 3.2 + Math.random() * 1.4;
          const trajectory = sampleCommunicationsTrajectory(true);
          spawnCarrierAcquisition(now, longDur, 0.038, trajectory, false);
          spawnTransmissionFragment(now + 1.1, {
            start: trajectory.end,
            end: trajectory.end,
          });
          nextDelayMs = 6800 + Math.random() * 5200;
        } else {
          const roll = Math.random();

          if (roll < 0.36) {
            // Faint carrier acquisition emerging and fading (or dropping with soft squelch)
            const dur = 1.4 + Math.random() * 1.8;
            const abrupt = Math.random() < 0.35;
            const trajectory = sampleCommunicationsTrajectory(Math.random() < 0.42);
            spawnCarrierAcquisition(now, dur, 0.032 + Math.random() * 0.014, trajectory, abrupt);
            nextDelayMs = 3600 + Math.random() * 3800;
          } else if (roll < 0.62) {
            // Fragmented transmission cluster
            const trajectory = sampleCommunicationsTrajectory(Math.random() < 0.35);
            spawnTransmissionFragment(now, trajectory);
            nextDelayMs = 4600 + Math.random() * 4400;
          } else if (roll < 0.78) {
            // Brief restrained narrowband RF interference burst
            const freq = 620 + Math.random() * 540;
            const trajectory = sampleCommunicationsTrajectory(false);
            spawnSquelchOrInterference(now, freq, 0.22 + Math.random() * 0.18, 0.034, trajectory, false);
            nextDelayMs = 3800 + Math.random() * 4200;
          } else {
            // Intentional quiet listening gap — vast silent deep space between detections
            nextDelayMs = 5500 + Math.random() * 6000;
          }
        }
      }

      timerId = window.setTimeout(scheduleSignal, nextDelayMs);
    };

    const start = () => {
      if (running && timerId !== null) return;
      running = true;
      smoothSetParam(activityGain.gain, 1, ctx.currentTime, 0.04);
      clearTimer();
      timerId = window.setTimeout(scheduleSignal, 650);
    };

    const stop = () => {
      if (!running && timerId === null) return;
      running = false;
      clearTimer();
      const now = ctx.currentTime;
      activityGain.gain.cancelScheduledValues(now);
      activityGain.gain.setValueAtTime(activityGain.gain.value, now);
      activityGain.gain.linearRampToValueAtTime(0, now + 0.025);
      voices.stopAll(now, ctx.state !== 'running');
    };

    return {
      gain: outputGain,
      eventBus,
      analyser,
      applyProfile,
      start,
      stop,
      cleanup: () => {
        running = false;
        clearTimer();
        voices.stopAll(ctx.currentTime, true);
        for (const src of [standbySrc, standbyOsc, standbyDriftLfo]) {
          try {
            src.stop();
          } catch {
            // Ignore already stopped
          }
          src.disconnect();
        }
        standbyGain.disconnect();
        standbyOscGain.disconnect();
        standbyDriftGain.disconnect();
        standbyBp.disconnect();
        activityGain.disconnect();
        activityHighpass.disconnect();
        activityLowpass.disconnect();
        commsHighpass.disconnect();
        commsLowpass.disconnect();
        disconnectBus();
      },
    };
  }

  /**
   * CH-06: Hull / Structural — Deep metallic resonance, distant creaks and structural stress
   * A. Deep Structural Resonance (slowly shifting inharmonic metallic bulkhead modes, distinct from Reactor)
   * B. Metallic Hull Creaks (infrequent, slowly flexing resonant metallic bends with soft attack & decay)
   * C. Structural Stress Events (uncommon deeper metallic groans with layered resonances & spatial depth)
   * D. Background Mechanical Texture (extremely subtle tonal structure ambience, zero broadband noise)
   */
  private buildHullChannel(ctx: AudioContext, dest: AudioNode): ChannelAudioNodes {
    const {
      input,
      spatialInput,
      eventBus,
      outputGain,
      analyser,
      applyProfile,
      disconnectBus,
    } = this.createChannelBus(ctx, dest, 'hull');

    // Shape continuous structural bed to heavy, dark industrial metallic spectrum
    const hullHighpass = ctx.createBiquadFilter();
    hullHighpass.type = 'highpass';
    hullHighpass.frequency.value = 28;
    hullHighpass.Q.value = 0.7;

    const hullLowpass = ctx.createBiquadFilter();
    hullLowpass.type = 'lowpass';
    hullLowpass.frequency.value = 640;
    hullLowpass.Q.value = 0.65;

    hullHighpass.connect(hullLowpass).connect(input);

    // Stereo-preserving spectrum shaping for 360-degree spatialized hull creaks, groans & heavy flexes
    const activityHighpass = ctx.createBiquadFilter();
    activityHighpass.type = 'highpass';
    activityHighpass.frequency.value = 28;
    activityHighpass.Q.value = 0.7;

    const activityLowpass = ctx.createBiquadFilter();
    activityLowpass.type = 'lowpass';
    activityLowpass.frequency.value = 760;
    activityLowpass.Q.value = 0.65;

    activityHighpass.connect(activityLowpass).connect(spatialInput);

    // Sub-gate for transient creaks and groans so disabling Hull fades smoothly without clicks
    const activityGain = ctx.createGain();
    activityGain.gain.value = 0;
    activityGain.connect(activityHighpass);

    // --- Layer A: Deep Structural Resonance (inharmonic steel modal frequencies) ---
    const modalFilter = ctx.createBiquadFilter();
    modalFilter.type = 'lowpass';
    modalFilter.frequency.value = 155;
    modalFilter.Q.value = 1.8;

    const modalGain = ctx.createGain();
    modalGain.gain.value = 0.14;
    modalFilter.connect(modalGain).connect(hullHighpass);

    // Inharmonic modal cluster (41.5 Hz, 67.2 Hz, 109.4 Hz) + slow beating pair (42.05 Hz)
    const res1 = ctx.createOscillator();
    res1.type = 'sine';
    res1.frequency.value = 41.5;
    const res1Gain = ctx.createGain();
    res1Gain.gain.value = 0.42;
    res1.connect(res1Gain).connect(modalFilter);

    const res2 = ctx.createOscillator();
    res2.type = 'sine';
    res2.frequency.value = 42.05;
    const res2Gain = ctx.createGain();
    res2Gain.gain.value = 0.24;
    res2.connect(res2Gain).connect(modalFilter);

    const res3 = ctx.createOscillator();
    res3.type = 'sine';
    res3.frequency.value = 67.2;
    const res3Gain = ctx.createGain();
    res3Gain.gain.value = 0.22;
    res3.connect(res3Gain).connect(modalFilter);

    const res4 = ctx.createOscillator();
    res4.type = 'triangle';
    res4.frequency.value = 109.4;
    const res4Gain = ctx.createGain();
    res4Gain.gain.value = 0.12;
    res4.connect(res4Gain).connect(modalFilter);

    // Slow incommensurate LFOs for thermal/mechanical bulkhead breathing
    const modalCutoffLfo = ctx.createOscillator();
    modalCutoffLfo.type = 'sine';
    modalCutoffLfo.frequency.value = 0.031;
    const modalCutoffLfoGain = ctx.createGain();
    modalCutoffLfoGain.gain.value = 34;
    modalCutoffLfo.connect(modalCutoffLfoGain).connect(modalFilter.frequency);

    const modalPitchLfo = ctx.createOscillator();
    modalPitchLfo.type = 'sine';
    modalPitchLfo.frequency.value = 0.023;
    const modalPitchLfoGain = ctx.createGain();
    modalPitchLfoGain.gain.value = 0.45;
    modalPitchLfo.connect(modalPitchLfoGain).connect(res3.frequency);

    const modalAmpLfo = ctx.createOscillator();
    modalAmpLfo.type = 'sine';
    modalAmpLfo.frequency.value = 0.037;
    const modalAmpLfoGain = ctx.createGain();
    modalAmpLfoGain.gain.value = 0.032;
    modalAmpLfo.connect(modalAmpLfoGain).connect(modalGain.gain);

    // --- Layer D: Background Mechanical Texture (extremely subtle tonal structure, no broadband noise) ---
    const texFilter = ctx.createBiquadFilter();
    texFilter.type = 'bandpass';
    texFilter.frequency.value = 178;
    texFilter.Q.value = 3.2;

    const texGain = ctx.createGain();
    texGain.gain.value = 0.018;
    texFilter.connect(texGain).connect(hullHighpass);

    const texOsc1 = ctx.createOscillator();
    texOsc1.type = 'sine';
    texOsc1.frequency.value = 138;
    const texOsc1Gain = ctx.createGain();
    texOsc1Gain.gain.value = 0.55;
    texOsc1.connect(texOsc1Gain).connect(texFilter);

    const texOsc2 = ctx.createOscillator();
    texOsc2.type = 'triangle';
    texOsc2.frequency.value = 214;
    const texOsc2Gain = ctx.createGain();
    texOsc2Gain.gain.value = 0.35;
    texOsc2.connect(texOsc2Gain).connect(texFilter);

    const texDriftLfo = ctx.createOscillator();
    texDriftLfo.type = 'sine';
    texDriftLfo.frequency.value = 0.041;
    const texDriftLfoGain = ctx.createGain();
    texDriftLfoGain.gain.value = 22;
    texDriftLfo.connect(texDriftLfoGain).connect(texFilter.frequency);

    res1.start();
    res2.start();
    res3.start();
    res4.start();
    modalCutoffLfo.start();
    modalPitchLfo.start();
    modalAmpLfo.start();
    texOsc1.start();
    texOsc2.start();
    texDriftLfo.start();

    const voices = new TransientVoicePool();
    let timerId: number | null = null;
    let running = false;
    let scheduleState: HullScheduleState | null = null;

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    const scheduleUnevenBend = (
      param: AudioParam,
      baseFreq: number,
      midDelta: number,
      lateDelta: number,
      endDelta: number,
      start: number,
      duration: number,
      ratio = 1,
    ) => {
      param.setValueAtTime(baseFreq * ratio, start);
      param.linearRampToValueAtTime((baseFreq + midDelta) * ratio, start + duration * 0.34);
      param.linearRampToValueAtTime((baseFreq + lateDelta) * ratio, start + duration * 0.68);
      param.linearRampToValueAtTime((baseFreq + endDelta) * ratio, start + duration);
    };

    /**
     * Layer B: Metallic Hull Creaks — heavy bulkhead & frame flexure (2–5 s, 15–35 s intervals)
     */
    const spawnHullCreak = (
      start: number,
      trajectory: SpatialTrajectory,
      params: HullCreakParams,
    ) => {
      const { durationSec: duration, baseFreq } = params;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(baseFreq * 1.38, start);
      bp.frequency.linearRampToValueAtTime(baseFreq * 1.56, start + duration * 0.44);
      bp.frequency.linearRampToValueAtTime(baseFreq * 1.28, start + duration);
      bp.Q.value = params.bandpassQ;

      const warmthLp = ctx.createBiquadFilter();
      warmthLp.type = 'lowpass';
      warmthLp.frequency.value = 560;
      warmthLp.Q.value = 0.8;

      const env = ctx.createGain();
      const attack = duration * params.attackRatio;
      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(params.peakGain, start + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      const spatialCfg = this.resolveChannelSpatial(
        'hull',
        trajectory.start,
        trajectory.end,
        1050,
      );
      const spatial = createSpatialBus(ctx, activityGain, {
        ...spatialCfg,
        startTime: start,
        durationSec: duration,
        panningModel: 'HRTF',
      });

      const osc1 = ctx.createOscillator();
      osc1.type = 'triangle';
      scheduleUnevenBend(
        osc1.frequency,
        baseFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        1.0,
      );

      // Layered inharmonic metallic bulkhead resonances (1.58x and 2.39x)
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      scheduleUnevenBend(
        osc2.frequency,
        baseFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        1.58,
      );

      const osc3 = ctx.createOscillator();
      osc3.type = 'sine';
      scheduleUnevenBend(
        osc3.frequency,
        baseFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        2.39,
      );

      // Subtle slow structural stick-slip grain FM (low rate & depth — cold steel, no squeal)
      const grainOsc = ctx.createOscillator();
      grainOsc.type = 'sine';
      grainOsc.frequency.value = params.grainRateHz;
      const grainGain = ctx.createGain();
      grainGain.gain.value = params.grainDepthHz;
      grainOsc.connect(grainGain).connect(osc1.frequency);

      const g2 = ctx.createGain();
      g2.gain.value = 0.62;
      const g3 = ctx.createGain();
      g3.gain.value = 0.34;

      osc1.connect(bp);
      osc2.connect(g2).connect(bp);
      osc3.connect(g3).connect(bp);
      bp.connect(warmthLp).connect(env).connect(spatial.input);

      let remaining = 4;
      const maybeDisconnectBus = () => {
        remaining -= 1;
        if (remaining <= 0) {
          bp.disconnect();
          warmthLp.disconnect();
          env.disconnect();
          spatial.disconnect();
        }
      };

      voices.track(osc1, () => {
        osc1.disconnect();
        maybeDisconnectBus();
      });
      voices.track(osc2, () => {
        osc2.disconnect();
        g2.disconnect();
        maybeDisconnectBus();
      });
      voices.track(osc3, () => {
        osc3.disconnect();
        g3.disconnect();
        maybeDisconnectBus();
      });
      voices.track(grainOsc, () => {
        grainOsc.disconnect();
        grainGain.disconnect();
        maybeDisconnectBus();
      });

      osc1.start(start);
      osc2.start(start);
      osc3.start(start);
      grainOsc.start(start);
      osc1.stop(start + duration + 0.04);
      osc2.stop(start + duration + 0.04);
      osc3.stop(start + duration + 0.04);
      grainOsc.stop(start + duration + 0.04);
    };

    /**
     * Layer C: Deeper Metallic Structural Groan (4–9 s, 45–90 s intervals)
     * with opposite-bulkhead sympathetic echo & optional faint secondary creak
     */
    const spawnStructuralStressGroan = (
      start: number,
      trajectory: SpatialTrajectory,
      params: HullGroanParams,
      secondaryCreakParams: HullCreakParams | null,
    ) => {
      const { durationSec: duration, rootFreq } = params;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(140, start);
      lp.frequency.linearRampToValueAtTime(285, start + duration * 0.42);
      lp.frequency.linearRampToValueAtTime(135, start + duration);
      lp.Q.value = 2.1;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(params.peakGain, start + duration * params.attackRatio);
      env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      const spatialCfg = this.resolveChannelSpatial(
        'hull',
        trajectory.start,
        trajectory.end,
        920,
      );
      const spatial = createSpatialBus(ctx, activityGain, {
        ...spatialCfg,
        startTime: start,
        durationSec: duration,
        panningModel: 'HRTF',
      });

      // Four heavy inharmonic steel modes (1.0, 1.59, 2.47, 3.18)
      const m1 = ctx.createOscillator();
      m1.type = 'sine';
      scheduleUnevenBend(
        m1.frequency,
        rootFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        1.0,
      );

      const m2 = ctx.createOscillator();
      m2.type = 'triangle';
      scheduleUnevenBend(
        m2.frequency,
        rootFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        1.59,
      );

      const m3 = ctx.createOscillator();
      m3.type = 'sine';
      scheduleUnevenBend(
        m3.frequency,
        rootFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        2.47,
      );

      const m4 = ctx.createOscillator();
      m4.type = 'sine';
      scheduleUnevenBend(
        m4.frequency,
        rootFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        3.18,
      );

      // Distant sympathetic bulkhead reflection across opposite side of vessel
      const echo = ctx.createOscillator();
      echo.type = 'sine';
      echo.frequency.setValueAtTime(rootFreq * 1.59, start + 0.55);
      echo.frequency.linearRampToValueAtTime(
        (rootFreq + params.bendEndDelta) * 1.59,
        start + duration + 0.5,
      );
      const echoEnv = ctx.createGain();
      echoEnv.gain.setValueAtTime(0.0001, start + 0.55);
      echoEnv.gain.linearRampToValueAtTime(
        params.peakGain * 0.34,
        start + 0.55 + duration * 0.36,
      );
      echoEnv.gain.exponentialRampToValueAtTime(0.0001, start + duration + 0.55);
      const echoPos: SpatialVec3 = {
        x: -trajectory.end.x * 0.85,
        y: trajectory.end.y * 0.7,
        z: -trajectory.end.z * 0.85,
      };
      const echoSpatialCfg = this.resolveChannelSpatial('hull', echoPos, undefined, 820);
      const echoSpatial = createSpatialBus(ctx, activityGain, {
        ...echoSpatialCfg,
        startTime: start + 0.55,
        panningModel: 'HRTF',
      });

      const g2 = ctx.createGain();
      g2.gain.value = 0.52;
      const g3 = ctx.createGain();
      g3.gain.value = 0.28;
      const g4 = ctx.createGain();
      g4.gain.value = 0.14;

      m1.connect(lp);
      m2.connect(g2).connect(lp);
      m3.connect(g3).connect(lp);
      m4.connect(g4).connect(lp);
      lp.connect(env).connect(spatial.input);
      echo.connect(echoEnv).connect(echoSpatial.input);

      let remaining = 5;
      const maybeDisconnectBus = () => {
        remaining -= 1;
        if (remaining <= 0) {
          lp.disconnect();
          env.disconnect();
          spatial.disconnect();
          echoEnv.disconnect();
          echoSpatial.disconnect();
        }
      };

      voices.track(m1, () => {
        m1.disconnect();
        maybeDisconnectBus();
      });
      voices.track(m2, () => {
        m2.disconnect();
        g2.disconnect();
        maybeDisconnectBus();
      });
      voices.track(m3, () => {
        m3.disconnect();
        g3.disconnect();
        maybeDisconnectBus();
      });
      voices.track(m4, () => {
        m4.disconnect();
        g4.disconnect();
        maybeDisconnectBus();
      });
      voices.track(echo, () => {
        echo.disconnect();
        maybeDisconnectBus();
      });

      m1.start(start);
      m2.start(start);
      m3.start(start);
      m4.start(start);
      echo.start(start + 0.55);
      m1.stop(start + duration + 0.04);
      m2.stop(start + duration + 0.04);
      m3.stop(start + duration + 0.04);
      m4.stop(start + duration + 0.04);
      echo.stop(start + duration + 0.58);

      // Occasionally pair a faint secondary creak from a separate hull section
      if (secondaryCreakParams) {
        spawnHullCreak(
          start + params.secondaryCreakDelaySec,
          sampleHullCreakTrajectory(Math.random() < 0.28),
          secondaryCreakParams,
        );
      }
    };

    /**
     * Layer E: Rare Heavy Hull Flex Event (7–12 s, ~3–6 min intervals)
     * Enormous low structural mass shifting slowly across bulkheads
     */
    const spawnHeavyHullFlex = (
      start: number,
      trajectory: SpatialTrajectory,
      params: HullHeavyFlexParams,
    ) => {
      const { durationSec: duration, rootFreq } = params;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(115, start);
      lp.frequency.linearRampToValueAtTime(255, start + duration * 0.44);
      lp.frequency.linearRampToValueAtTime(105, start + duration);
      lp.Q.value = 2.0;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(params.peakGain, start + duration * params.attackRatio);
      env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      const spatialCfg = this.resolveChannelSpatial(
        'hull',
        trajectory.start,
        trajectory.end,
        880,
      );
      const spatial = createSpatialBus(ctx, activityGain, {
        ...spatialCfg,
        startTime: start,
        durationSec: duration,
        panningModel: 'HRTF',
      });

      // Massive inharmonic structural plate modes + slow beating pair
      const f1 = ctx.createOscillator();
      f1.type = 'sine';
      scheduleUnevenBend(
        f1.frequency,
        rootFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        1.0,
      );

      const f1Pair = ctx.createOscillator();
      f1Pair.type = 'sine';
      scheduleUnevenBend(
        f1Pair.frequency,
        rootFreq + 0.32,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        1.0,
      );

      const f2 = ctx.createOscillator();
      f2.type = 'triangle';
      scheduleUnevenBend(
        f2.frequency,
        rootFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        1.53,
      );

      const f3 = ctx.createOscillator();
      f3.type = 'sine';
      scheduleUnevenBend(
        f3.frequency,
        rootFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        2.31,
      );

      const f4 = ctx.createOscillator();
      f4.type = 'sine';
      scheduleUnevenBend(
        f4.frequency,
        rootFreq,
        params.bendMidDelta,
        params.bendLateDelta,
        params.bendEndDelta,
        start,
        duration,
        3.07,
      );

      // Opposite-bulkhead sympathetic settling response
      const replyStart = start + 1.15;
      const replyDur = Math.max(4.5, duration - 1.15);
      const replyOsc = ctx.createOscillator();
      replyOsc.type = 'sine';
      scheduleUnevenBend(
        replyOsc.frequency,
        rootFreq * 1.53,
        params.bendMidDelta * 1.2,
        params.bendLateDelta * 1.2,
        params.bendEndDelta * 1.2,
        replyStart,
        replyDur,
        1.0,
      );

      const replyEnv = ctx.createGain();
      replyEnv.gain.setValueAtTime(0.0001, replyStart);
      replyEnv.gain.linearRampToValueAtTime(params.peakGain * 0.36, replyStart + replyDur * 0.35);
      replyEnv.gain.exponentialRampToValueAtTime(0.0001, replyStart + replyDur);

      const replyPos: SpatialVec3 = {
        x: -trajectory.end.x * 0.85,
        y: trajectory.end.y * 0.65,
        z: -trajectory.end.z * 0.85,
      };
      const replySpatialCfg = this.resolveChannelSpatial('hull', replyPos, undefined, 780);
      const replySpatial = createSpatialBus(ctx, activityGain, {
        ...replySpatialCfg,
        startTime: replyStart,
        panningModel: 'HRTF',
      });

      const gPair = ctx.createGain();
      gPair.gain.value = 0.45;
      const g2 = ctx.createGain();
      g2.gain.value = 0.54;
      const g3 = ctx.createGain();
      g3.gain.value = 0.28;
      const g4 = ctx.createGain();
      g4.gain.value = 0.16;

      f1.connect(lp);
      f1Pair.connect(gPair).connect(lp);
      f2.connect(g2).connect(lp);
      f3.connect(g3).connect(lp);
      f4.connect(g4).connect(lp);
      lp.connect(env).connect(spatial.input);
      replyOsc.connect(replyEnv).connect(replySpatial.input);

      let remaining = 6;
      const maybeDisconnectBus = () => {
        remaining -= 1;
        if (remaining <= 0) {
          lp.disconnect();
          env.disconnect();
          spatial.disconnect();
          replyEnv.disconnect();
          replySpatial.disconnect();
        }
      };

      voices.track(f1, () => {
        f1.disconnect();
        maybeDisconnectBus();
      });
      voices.track(f1Pair, () => {
        f1Pair.disconnect();
        gPair.disconnect();
        maybeDisconnectBus();
      });
      voices.track(f2, () => {
        f2.disconnect();
        g2.disconnect();
        maybeDisconnectBus();
      });
      voices.track(f3, () => {
        f3.disconnect();
        g3.disconnect();
        maybeDisconnectBus();
      });
      voices.track(f4, () => {
        f4.disconnect();
        g4.disconnect();
        maybeDisconnectBus();
      });
      voices.track(replyOsc, () => {
        replyOsc.disconnect();
        maybeDisconnectBus();
      });

      f1.start(start);
      f1Pair.start(start);
      f2.start(start);
      f3.start(start);
      f4.start(start);
      replyOsc.start(replyStart);

      f1.stop(start + duration + 0.04);
      f1Pair.stop(start + duration + 0.04);
      f2.stop(start + duration + 0.04);
      f3.stop(start + duration + 0.04);
      f4.stop(start + duration + 0.04);
      replyOsc.stop(replyStart + replyDur + 0.04);
    };

    const scheduleHullActivity = () => {
      if (!running || this.disposed || this.ctx !== ctx || !scheduleState) return;

      if (typeof document !== 'undefined' && document.hidden) {
        timerId = null;
        return;
      }

      const nowMs = Date.now();

      if (ctx.state === 'running') {
        const step = evaluateHullScheduleStep(scheduleState, nowMs);
        scheduleState = step.nextSchedule;
        const audioNow = ctx.currentTime;

        if (step.kind === 'heavy-flex') {
          spawnHeavyHullFlex(audioNow, sampleHullHeavyFlexTrajectory(), step.params);
        } else if (step.kind === 'groan') {
          spawnStructuralStressGroan(
            audioNow,
            sampleHullGroanTrajectory(Math.random() < 0.35),
            step.params,
            step.secondaryCreakParams,
          );
        } else if (step.kind === 'creak') {
          spawnHullCreak(
            audioNow,
            sampleHullCreakTrajectory(Math.random() < 0.3),
            step.params,
          );
        }
      }

      const delayMs = getNextHullWakeDelayMs(scheduleState, Date.now());
      timerId = window.setTimeout(scheduleHullActivity, delayMs);
    };

    const start = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (running && timerId !== null) return;
      running = true;
      smoothSetParam(activityGain.gain, 1, ctx.currentTime, 0.06);
      clearTimer();
      const nowMs = Date.now();
      scheduleState =
        scheduleState === null
          ? createInitialHullSchedule(nowMs)
          : reanchorHullScheduleAfterResume(scheduleState, nowMs);
      timerId = window.setTimeout(scheduleHullActivity, getNextHullWakeDelayMs(scheduleState, nowMs));
    };

    const pause = () => {
      if (!running && timerId === null) return;
      running = false;
      clearTimer();
      const now = ctx.currentTime;
      activityGain.gain.cancelScheduledValues(now);
      activityGain.gain.setValueAtTime(activityGain.gain.value, now);
      activityGain.gain.linearRampToValueAtTime(0, now + 0.03);
      voices.stopAll(now, ctx.state !== 'running');
    };

    const stop = () => {
      if (!running && timerId === null) return;
      running = false;
      scheduleState = null;
      clearTimer();
      const now = ctx.currentTime;
      activityGain.gain.cancelScheduledValues(now);
      activityGain.gain.setValueAtTime(activityGain.gain.value, now);
      activityGain.gain.linearRampToValueAtTime(0, now + 0.03);
      voices.stopAll(now, ctx.state !== 'running');
    };

    return {
      gain: outputGain,
      eventBus,
      analyser,
      applyProfile,
      start,
      pause,
      stop,
      cleanup: () => {
        running = false;
        scheduleState = null;
        clearTimer();
        voices.stopAll(ctx.currentTime, true);
        for (const src of [
          res1,
          res2,
          res3,
          res4,
          modalCutoffLfo,
          modalPitchLfo,
          modalAmpLfo,
          texOsc1,
          texOsc2,
          texDriftLfo,
        ]) {
          try {
            src.stop();
          } catch {
            // Ignore already stopped
          }
          src.disconnect();
        }
        res1Gain.disconnect();
        res2Gain.disconnect();
        res3Gain.disconnect();
        res4Gain.disconnect();
        modalCutoffLfoGain.disconnect();
        modalPitchLfoGain.disconnect();
        modalAmpLfoGain.disconnect();
        modalFilter.disconnect();
        modalGain.disconnect();
        texOsc1Gain.disconnect();
        texOsc2Gain.disconnect();
        texDriftLfoGain.disconnect();
        texFilter.disconnect();
        texGain.disconnect();
        activityGain.disconnect();
        activityHighpass.disconnect();
        activityLowpass.disconnect();
        hullHighpass.disconnect();
        hullLowpass.disconnect();
        disconnectBus();
      },
    };
  }

  public async syncState(state: MixerState): Promise<void> {
    if (this.disposed) return;
    this.latestState = state;

    if (!state.isActive && !this.ctx) {
      // Respect browser autoplay policy: store profile selection without allocating AudioContext
      this.activeAcousticProfileId = state.acousticProfileId;
      return;
    }

    const ctx = this.ensureInitialized();
    const now = ctx.currentTime;

    if (state.acousticProfileId !== this.activeAcousticProfileId) {
      this.applyAcousticProfile(state.acousticProfileId);
    }

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

      if (state.channels.hull.enabled) {
        this.channels.hull?.start?.();
      } else {
        this.channels.hull?.stop?.();
      }

      // Optional Ambient Event System synchronization
      if (!state.ambientEventsEnabled) {
        this.stopAmbientEvents(true);
      } else {
        if (this.activeEventTarget && !state.channels[this.activeEventTarget].enabled) {
          this.stopActiveEventVoice(true);
        }
        if (!this.schedulerRunning) {
          this.schedulerRunning = true;
          this.scheduleNextAmbientEvent(true);
        }
      }
    } else {
      // Stop All / last channel turned off: stop intermittent schedulers and ambient events immediately,
      // perform a fast 40ms click-free fade to exact 0, and suspend AudioContext.
      this.stopAmbientEvents(true);
      this.channels.systems?.stop?.();
      this.channels.communications?.stop?.();
      this.channels.hull?.stop?.();

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

  private clearEventScheduleTimer(): void {
    if (this.eventTimerId !== null) {
      window.clearTimeout(this.eventTimerId);
      this.eventTimerId = null;
    }
  }

  private clearActiveEventTimer(): void {
    if (this.activeEventTimerId !== null) {
      window.clearTimeout(this.activeEventTimerId);
      this.activeEventTimerId = null;
    }
  }

  private stopActiveEventVoice(immediate = false): void {
    this.clearActiveEventTimer();
    const target = this.activeEventTarget;
    this.activeEventTarget = null;

    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (target) {
      const bus = this.channels[target]?.eventBus;
      if (bus) {
        bus.gain.cancelScheduledValues(now);
        bus.gain.setValueAtTime(bus.gain.value, now);
        bus.gain.linearRampToValueAtTime(0, now + 0.015);
      }
    }
    this.eventVoices.stopAll(now, immediate || this.ctx.state !== 'running');
  }

  private stopAmbientEvents(immediate = false): void {
    this.schedulerRunning = false;
    this.eventGeneration += 1;
    this.clearEventScheduleTimer();
    this.stopActiveEventVoice(immediate);
  }

  private scheduleNextAmbientEvent(isInitial: boolean): void {
    if (this.disposed || !this.latestState?.ambientEventsEnabled || !this.latestState?.isActive) {
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      this.clearEventScheduleTimer();
      return;
    }

    this.clearEventScheduleTimer();
    const generation = this.eventGeneration;
    const delayMs = computeAmbientEventDelayMs({
      isInitial,
      overrideMs: this.overrideEventDelayMs,
    });

    this.eventTimerId = window.setTimeout(() => {
      this.eventTimerId = null;
      this.onAmbientEventTick(generation);
    }, delayMs);
  }

  private onAmbientEventTick(generation: number): void {
    if (this.disposed || generation !== this.eventGeneration) return;
    const state = this.latestState;
    if (!state || !state.ambientEventsEnabled || !state.isActive) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    // Never overlap events: wait for active event completion before scheduling another
    if (this.activeEventTarget !== null) {
      this.scheduleNextAmbientEvent(false);
      return;
    }

    const nowMs = Date.now();
    const eligible = getEligibleAmbientEvents(state, nowMs, this.lastEventTriggeredAt);
    const selection = selectAmbientEvent(eligible, state);

    if (selection && this.ctx && this.ctx.state === 'running') {
      const durationSec = this.playAmbientEvent(selection.event.type, selection.targetChannel);
      if (durationSec > 0) {
        this.lastEventTriggeredAt[selection.event.type] = nowMs;
        this.activeEventTarget = selection.targetChannel;
        this.onAmbientEvent?.(selection.event);

        const activeGen = this.eventGeneration;
        this.clearActiveEventTimer();
        this.activeEventTimerId = window.setTimeout(() => {
          this.activeEventTimerId = null;
          if (this.disposed || activeGen !== this.eventGeneration) return;
          this.activeEventTarget = null;
          this.scheduleNextAmbientEvent(false);
        }, Math.round(durationSec * 1000) + 120);
        return;
      }
    }

    // No eligible event (e.g. only Engines/Ventilation active) — recheck conservatively later
    this.scheduleNextAmbientEvent(false);
  }

  private getEventNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.eventNoiseBuf) {
      this.eventNoiseBuf = createSeamlessNoiseBuffer(ctx, 5.3, 'pink');
    }
    return this.eventNoiseBuf;
  }

  private playAmbientEvent(eventType: AmbientEventType, targetChannel: ChannelId): number {
    const ctx = this.ctx;
    const node = this.channels[targetChannel];
    if (!ctx || !node) return 0;

    const now = ctx.currentTime;
    // Restore channel eventBus smoothly before spawning the new event
    node.eventBus.gain.cancelScheduledValues(now);
    node.eventBus.gain.setValueAtTime(1, now);

    switch (eventType) {
      case 'reactor-fluctuation':
        return this.triggerReactorFluctuation(ctx, node.eventBus, now);
      case 'navigation-beacon':
        return this.triggerNavigationBeacon(ctx, node.eventBus, now);
      case 'communications-interference':
        return this.triggerCommsInterference(ctx, node.eventBus, now);
      case 'system-diagnostic':
        return this.triggerSystemDiagnostic(ctx, node.eventBus, now);
      case 'sensor-anomaly':
        return this.triggerSensorAnomaly(ctx, node.eventBus, now, targetChannel);
      case 'structural-resonance':
        return this.triggerStructuralResonance(ctx, node.eventBus, now);
      case 'hull-stress':
        return this.triggerHullStress(ctx, node.eventBus, now);
    }
  }

  /**
   * Event 1: Reactor Fluctuation — brief harmonic & low-frequency modulation swell
   */
  private triggerReactorFluctuation(ctx: AudioContext, dest: AudioNode, start: number): number {
    const duration = 3.2;
    const profile = CHANNEL_SPATIAL_PROFILES.reactor;
    const spatialCfg = this.resolveChannelSpatial('reactor', profile.position);
    const spatial = createSpatialBus(ctx, dest, {
      ...spatialCfg,
      startTime: start,
      panningModel: profile.panningModel,
    });

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(115, start);
    lp.frequency.linearRampToValueAtTime(195, start + 1.3);
    lp.frequency.linearRampToValueAtTime(115, start + duration);
    lp.Q.value = 1.6;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(0.14, start + 1.15);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    const oscA = ctx.createOscillator();
    oscA.type = 'sine';
    oscA.frequency.setValueAtTime(52.4, start);
    oscA.frequency.linearRampToValueAtTime(51.7, start + 1.6);
    oscA.frequency.linearRampToValueAtTime(52.1, start + duration);

    const oscB = ctx.createOscillator();
    oscB.type = 'triangle';
    oscB.frequency.setValueAtTime(104.2, start);
    oscB.frequency.linearRampToValueAtTime(103.5, start + 1.6);
    oscB.frequency.linearRampToValueAtTime(104.0, start + duration);

    const gB = ctx.createGain();
    gB.gain.value = 0.28;

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = 0.65;
    const modGain = ctx.createGain();
    modGain.gain.value = 26;
    mod.connect(modGain).connect(lp.frequency);

    oscA.connect(lp);
    oscB.connect(gB).connect(lp);
    lp.connect(env).connect(spatial.input);

    this.eventVoices.track(oscA, () => {
      oscA.disconnect();
      lp.disconnect();
      env.disconnect();
      spatial.disconnect();
    });
    this.eventVoices.track(oscB, () => {
      oscB.disconnect();
      gB.disconnect();
    });
    this.eventVoices.track(mod, () => {
      mod.disconnect();
      modGain.disconnect();
    });

    oscA.start(start);
    oscB.start(start);
    mod.start(start);
    oscA.stop(start + duration + 0.04);
    oscB.stop(start + duration + 0.04);
    mod.stop(start + duration + 0.04);

    return duration;
  }

  /**
   * Event 2: Navigation Beacon — distant, short three-pulse narrowband RF beacon
   */
  private triggerNavigationBeacon(ctx: AudioContext, dest: AudioNode, start: number): number {
    const carrierBase = 880 + Math.random() * 240;
    const trajectory = sampleCommunicationsTrajectory(false);
    const pulses = [
      { offset: 0, dur: 0.22, freq: carrierBase },
      { offset: 0.42, dur: 0.22, freq: carrierBase },
      { offset: 0.86, dur: 0.52, freq: carrierBase * 1.125 },
    ];

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = carrierBase * 1.04;
    bp.Q.value = 5.5;

    const spatialCfg = this.resolveChannelSpatial(
      'communications',
      trajectory.start,
      undefined,
      1950,
    );
    const spatial = createSpatialBus(ctx, dest, {
      ...spatialCfg,
      startTime: start,
      panningModel: 'HRTF',
    });
    bp.connect(spatial.input);

    let remaining = pulses.length;
    for (const p of pulses) {
      const t = start + p.offset;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(p.freq, t);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.045, t + 0.035);
      env.gain.exponentialRampToValueAtTime(0.0001, t + p.dur);

      osc.connect(env).connect(bp);
      this.eventVoices.track(osc, () => {
        osc.disconnect();
        env.disconnect();
        remaining -= 1;
        if (remaining <= 0) {
          bp.disconnect();
          spatial.disconnect();
        }
      });

      osc.start(t);
      osc.stop(t + p.dur + 0.03);
    }

    return 1.5;
  }

  /**
   * Event 3: Communications Interference — restrained narrowband RF disruption & flutter
   */
  private triggerCommsInterference(ctx: AudioContext, dest: AudioNode, start: number): number {
    const duration = 1.65;
    const centerFreq = 640 + Math.random() * 320;
    const trajectory = sampleCommunicationsTrajectory(Math.random() < 0.45);

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = this.getEventNoiseBuffer(ctx);
    noiseSrc.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(centerFreq, start);
    bp.frequency.linearRampToValueAtTime(centerFreq * 0.65, start + 0.75);
    bp.frequency.linearRampToValueAtTime(centerFreq * 1.15, start + duration);
    bp.Q.value = 8.0;

    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(0.0001, start);
    noiseEnv.gain.linearRampToValueAtTime(0.044, start + 0.14);
    noiseEnv.gain.linearRampToValueAtTime(0.018, start + 0.85);
    noiseEnv.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = centerFreq * 0.92;

    const flutter = ctx.createOscillator();
    flutter.type = 'sine';
    flutter.frequency.value = 14 + Math.random() * 7;
    const flutterGain = ctx.createGain();
    flutterGain.gain.value = 18;
    flutter.connect(flutterGain).connect(carrier.frequency);

    const carrierEnv = ctx.createGain();
    carrierEnv.gain.setValueAtTime(0.0001, start);
    carrierEnv.gain.linearRampToValueAtTime(0.022, start + 0.18);
    carrierEnv.gain.exponentialRampToValueAtTime(0.0001, start + duration * 0.85);

    const spatialCfg = this.resolveChannelSpatial(
      'communications',
      trajectory.start,
      trajectory.end,
      1850,
    );
    const spatial = createSpatialBus(ctx, dest, {
      ...spatialCfg,
      startTime: start,
      durationSec: duration,
      panningModel: 'HRTF',
    });

    noiseSrc.connect(bp).connect(noiseEnv).connect(spatial.input);
    carrier.connect(carrierEnv).connect(spatial.input);

    let remaining = 2;
    const maybeReleaseSpatial = () => {
      remaining -= 1;
      if (remaining <= 0) {
        spatial.disconnect();
      }
    };

    this.eventVoices.track(noiseSrc, () => {
      noiseSrc.disconnect();
      bp.disconnect();
      noiseEnv.disconnect();
      maybeReleaseSpatial();
    });
    this.eventVoices.track(carrier, () => {
      carrier.disconnect();
      carrierEnv.disconnect();
      maybeReleaseSpatial();
    });
    this.eventVoices.track(flutter, () => {
      flutter.disconnect();
      flutterGain.disconnect();
    });

    noiseSrc.start(start, Math.random() * 3.2);
    carrier.start(start);
    flutter.start(start);
    noiseSrc.stop(start + duration + 0.03);
    carrier.stop(start + duration + 0.03);
    flutter.stop(start + duration + 0.03);

    return duration;
  }

  /**
   * Event 4: System Diagnostic — short coherent sequence of related telemetry tones
   */
  private triggerSystemDiagnostic(ctx: AudioContext, dest: AudioNode, start: number): number {
    const notes = [392.0, 493.88, 587.33, 440.0];
    const stepSec = 0.165;
    const pos = sampleSystemsTransientPosition();

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1320;
    lp.Q.value = 0.7;

    const spatialCfg = this.resolveChannelSpatial('systems', pos);
    const spatial = createSpatialBus(ctx, dest, {
      ...spatialCfg,
      startTime: start,
      panningModel: 'HRTF',
    });
    lp.connect(spatial.input);

    let remaining = notes.length;
    notes.forEach((freq, idx) => {
      const t = start + idx * stepSec;
      const isLast = idx === notes.length - 1;
      const dur = isLast ? 0.34 : 0.16;
      const peak = isLast ? 0.056 : 0.044;

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.014);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(env).connect(lp);
      this.eventVoices.track(osc, () => {
        osc.disconnect();
        env.disconnect();
        remaining -= 1;
        if (remaining <= 0) {
          lp.disconnect();
          spatial.disconnect();
        }
      });

      osc.start(t);
      osc.stop(t + dur + 0.03);
    });

    return notes.length * stepSec + 0.4;
  }

  /**
   * Event 5: Sensor Anomaly — faint, unusual beating pulse & subtle echo on Systems or Comms
   */
  private triggerSensorAnomaly(
    ctx: AudioContext,
    dest: AudioNode,
    start: number,
    targetChannel: ChannelId,
  ): number {
    const duration = 2.6;
    const baseFreq = 685 + Math.random() * 140;
    const trajectory: SpatialTrajectory =
      targetChannel === 'communications'
        ? sampleCommunicationsTrajectory(Math.random() < 0.45)
        : (() => {
            const p = sampleSystemsTransientPosition();
            return { start: p, end: p };
          })();

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = baseFreq;
    bp.Q.value = 4.6;

    const spatialCfg = this.resolveChannelSpatial(
      targetChannel,
      trajectory.start,
      trajectory.end,
      targetChannel === 'communications' ? 1950 : null,
    );
    const spatial = createSpatialBus(ctx, dest, {
      ...spatialCfg,
      startTime: start,
      durationSec: duration,
      panningModel: 'HRTF',
    });
    bp.connect(spatial.input);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(baseFreq, start);
    osc1.frequency.linearRampToValueAtTime(baseFreq - 22, start + 1.5);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(baseFreq * 1.03, start);
    osc2.frequency.linearRampToValueAtTime(baseFreq * 1.015, start + 1.5);

    const env1 = ctx.createGain();
    env1.gain.setValueAtTime(0.0001, start);
    env1.gain.linearRampToValueAtTime(0.036, start + 0.25);
    env1.gain.exponentialRampToValueAtTime(0.0001, start + 1.65);

    const echo = ctx.createOscillator();
    echo.type = 'sine';
    echo.frequency.value = baseFreq * 1.495;
    const echoEnv = ctx.createGain();
    echoEnv.gain.setValueAtTime(0.0001, start + 1.05);
    echoEnv.gain.linearRampToValueAtTime(0.024, start + 1.25);
    echoEnv.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    let remaining = 3;
    const maybeCleanupBus = () => {
      remaining -= 1;
      if (remaining <= 0) {
        bp.disconnect();
        spatial.disconnect();
      }
    };

    osc1.connect(env1).connect(bp);
    osc2.connect(env1);
    echo.connect(echoEnv).connect(bp);

    this.eventVoices.track(osc1, () => {
      osc1.disconnect();
      env1.disconnect();
      maybeCleanupBus();
    });
    this.eventVoices.track(osc2, () => {
      osc2.disconnect();
      maybeCleanupBus();
    });
    this.eventVoices.track(echo, () => {
      echo.disconnect();
      echoEnv.disconnect();
      maybeCleanupBus();
    });

    osc1.start(start);
    osc2.start(start);
    echo.start(start + 1.05);
    osc1.stop(start + 1.7);
    osc2.stop(start + 1.7);
    echo.stop(start + duration + 0.03);

    return duration;
  }

  /**
   * Event 6: Structural Resonance — slow, deep metallic bulkhead resonance swell on Hull
   */
  private triggerStructuralResonance(ctx: AudioContext, dest: AudioNode, start: number): number {
    const duration = 4.4;
    const baseFreq = 62 + Math.random() * 14;
    const trajectory = sampleHullSurroundingTrajectory(false);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(baseFreq * 1.7, start);
    bp.frequency.linearRampToValueAtTime(baseFreq * 2.45, start + 1.7);
    bp.frequency.linearRampToValueAtTime(baseFreq * 1.65, start + duration);
    bp.Q.value = 2.6;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(0.075, start + 1.6);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    const spatialCfg = this.resolveChannelSpatial('hull', trajectory.start, undefined, 1050);
    const spatial = createSpatialBus(ctx, dest, {
      ...spatialCfg,
      startTime: start,
      panningModel: 'HRTF',
    });

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(baseFreq, start);
    osc1.frequency.linearRampToValueAtTime(baseFreq + 1.4, start + duration);

    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(baseFreq * 1.615, start);
    osc2.frequency.linearRampToValueAtTime(baseFreq * 1.615 + 1.8, start + duration);

    const g2 = ctx.createGain();
    g2.gain.value = 0.42;

    osc1.connect(bp);
    osc2.connect(g2).connect(bp);
    bp.connect(env).connect(spatial.input);

    let remaining = 2;
    const maybeCleanup = () => {
      remaining -= 1;
      if (remaining <= 0) {
        bp.disconnect();
        env.disconnect();
        spatial.disconnect();
      }
    };

    this.eventVoices.track(osc1, () => {
      osc1.disconnect();
      maybeCleanup();
    });
    this.eventVoices.track(osc2, () => {
      osc2.disconnect();
      g2.disconnect();
      maybeCleanup();
    });

    osc1.start(start);
    osc2.start(start);
    osc1.stop(start + duration + 0.04);
    osc2.stop(start + duration + 0.04);

    return duration;
  }

  /**
   * Event 7: Hull Stress — subtle, layered metallic groan with long decay on Hull
   */
  private triggerHullStress(ctx: AudioContext, dest: AudioNode, start: number): number {
    const duration = 5.0;
    const rootFreq = 49 + Math.random() * 14;
    const trajectory = sampleHullSurroundingTrajectory(Math.random() < 0.35);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(140, start);
    lp.frequency.linearRampToValueAtTime(240, start + 1.5);
    lp.frequency.linearRampToValueAtTime(125, start + duration);
    lp.Q.value = 2.0;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(0.085, start + 1.35);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    const spatialCfg = this.resolveChannelSpatial(
      'hull',
      trajectory.start,
      trajectory.end,
      960,
    );
    const spatial = createSpatialBus(ctx, dest, {
      ...spatialCfg,
      startTime: start,
      durationSec: duration,
      panningModel: 'HRTF',
    });

    const m1 = ctx.createOscillator();
    m1.type = 'sine';
    m1.frequency.setValueAtTime(rootFreq, start);
    m1.frequency.linearRampToValueAtTime(rootFreq - 2.1, start + duration);

    const m2 = ctx.createOscillator();
    m2.type = 'triangle';
    m2.frequency.setValueAtTime(rootFreq * 1.58, start);
    m2.frequency.linearRampToValueAtTime(rootFreq * 1.58 - 2.8, start + duration);

    const m3 = ctx.createOscillator();
    m3.type = 'sine';
    m3.frequency.setValueAtTime(rootFreq * 2.52, start);
    m3.frequency.linearRampToValueAtTime(rootFreq * 2.52 - 3.6, start + duration);

    const g2 = ctx.createGain();
    g2.gain.value = 0.45;
    const g3 = ctx.createGain();
    g3.gain.value = 0.25;

    m1.connect(lp);
    m2.connect(g2).connect(lp);
    m3.connect(g3).connect(lp);
    lp.connect(env).connect(spatial.input);

    let remaining = 3;
    const maybeCleanup = () => {
      remaining -= 1;
      if (remaining <= 0) {
        lp.disconnect();
        env.disconnect();
        spatial.disconnect();
      }
    };

    this.eventVoices.track(m1, () => {
      m1.disconnect();
      maybeCleanup();
    });
    this.eventVoices.track(m2, () => {
      m2.disconnect();
      g2.disconnect();
      maybeCleanup();
    });
    this.eventVoices.track(m3, () => {
      m3.disconnect();
      g3.disconnect();
      maybeCleanup();
    });

    m1.start(start);
    m2.start(start);
    m3.start(start);
    m1.stop(start + duration + 0.04);
    m2.stop(start + duration + 0.04);
    m3.stop(start + duration + 0.04);

    return duration;
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
      hull: 0,
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
    this.stopAmbientEvents(true);
    this.eventNoiseBuf = null;

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

    if (this.reflectionBus) {
      this.reflectionBus.disconnect();
      this.reflectionBus = null;
    }
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
