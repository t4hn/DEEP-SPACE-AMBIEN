import type { RefObject } from 'react';
import { type ChannelMeta, type ChannelState, formatPercent } from '../audio/mixerState';

interface ChannelStripProps {
  meta: ChannelMeta;
  state: ChannelState;
  environmentActive: boolean;
  meterRef: RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onVolumeChange: (volume: number) => void;
}

export function ChannelStrip({
  meta,
  state,
  environmentActive,
  meterRef,
  onToggle,
  onVolumeChange,
}: ChannelStripProps) {
  const isChannelActive = environmentActive && state.enabled;
  const volumePercent = Math.round(state.volume * 100);
  const sliderId = `channel-volume-${meta.id}`;

  return (
    <div
      data-testid={`channel-strip-${meta.id}`}
      data-enabled={state.enabled ? 'true' : 'false'}
      className={`border px-5 py-3.5 sm:px-6 transition-colors ${
        isChannelActive
          ? 'bg-[#0e1418] border-emerald-800/60'
          : 'bg-[#0c1014] border-zinc-800/90'
      }`}
    >
      <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 md:grid-cols-[minmax(210px,1.15fr)_auto_minmax(240px,1.5fr)] md:items-center md:gap-6">
        {/* Channel Identity + Signal Meter */}
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono tabular-nums text-zinc-500 shrink-0">
              {meta.code}
            </span>
            <h2 className="text-base font-semibold tracking-tight text-zinc-100 truncate">
              {meta.name}
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-zinc-400 leading-relaxed">
            {meta.description}
          </p>

          {/* Simple live audio signal indicator bar */}
          <div className="mt-2.5 flex items-center gap-2.5" aria-hidden="true">
            <div className="h-1 flex-1 max-w-[160px] bg-zinc-800/90 overflow-hidden">
              <div
                ref={meterRef}
                data-testid={`level-meter-${meta.id}`}
                className={`h-full w-full origin-left transition-opacity duration-150 ${
                  isChannelActive ? 'bg-emerald-400/80 opacity-100' : 'bg-zinc-600 opacity-0'
                }`}
                style={{ transform: 'scaleX(0)' }}
              />
            </div>
            <span
              className={`text-[11px] font-mono ${
                isChannelActive ? 'text-emerald-400/90' : 'text-zinc-600'
              }`}
            >
              {isChannelActive ? 'Signal' : 'Idle'}
            </span>
          </div>
        </div>

        {/* Individual ON/OFF Toggle */}
        <div className="flex items-start md:items-center justify-end md:justify-center">
          <button
            type="button"
            onClick={onToggle}
            aria-pressed={state.enabled}
            aria-label={`${meta.name} channel ${state.enabled ? 'on' : 'off'}`}
            className={`inline-flex items-center justify-center gap-2 min-w-[80px] sm:min-w-[84px] min-h-[44px] px-3.5 sm:px-4 py-2 text-xs font-mono font-medium tracking-wider border transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
              state.enabled
                ? 'bg-emerald-950/60 border-emerald-500/75 text-emerald-300 hover:bg-emerald-950/80'
                : 'bg-zinc-900 border-zinc-700/80 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${
                state.enabled ? 'bg-emerald-400' : 'bg-zinc-600'
              }`}
            />
            <span>{state.enabled ? 'ON' : 'OFF'}</span>
          </button>
        </div>

        {/* Individual Volume Slider */}
        <div className="col-span-2 md:col-span-1 min-w-0">
          <div className="flex items-center justify-between gap-3 mb-1">
            <label
              htmlFor={sliderId}
              className="text-xs font-mono text-zinc-400"
            >
              Gain
            </label>
            <span
              data-testid={`channel-volume-readout-${meta.id}`}
              className={`text-xs font-mono tabular-nums ${
                isChannelActive ? 'text-emerald-400' : 'text-zinc-400'
              }`}
            >
              {formatPercent(state.volume)}
            </span>
          </div>

          <div className="relative flex items-center h-9">
            <div className="absolute inset-x-0 h-1.5 rounded-xs bg-zinc-800 overflow-hidden pointer-events-none">
              <div
                className={`h-full transition-[width] duration-100 ${
                  isChannelActive ? 'bg-emerald-500/70' : 'bg-zinc-600/50'
                }`}
                style={{ width: `${volumePercent}%` }}
              />
            </div>
            <input
              id={sliderId}
              type="range"
              min={0}
              max={100}
              step={1}
              value={volumePercent}
              data-active={isChannelActive ? 'true' : 'false'}
              aria-label={`${meta.name} volume`}
              onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
              className="console-slider relative z-10 w-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
