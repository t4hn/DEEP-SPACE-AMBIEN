import { Play, RotateCcw, Square, Volume2 } from 'lucide-react';
import type { AmbientEventDescriptor } from '../audio/ambientEvents';
import { formatPercent } from '../audio/mixerState';

interface MasterControlsProps {
  isActive: boolean;
  masterVolume: number;
  activeChannelCount: number;
  totalChannels: number;
  ambientEventsEnabled: boolean;
  lastAmbientEvent: AmbientEventDescriptor | null;
  onPlayAll: () => void;
  onStopAll: () => void;
  onReset: () => void;
  onMasterVolumeChange: (volume: number) => void;
  onToggleAmbientEvents: () => void;
}

export function MasterControls({
  isActive,
  masterVolume,
  activeChannelCount,
  totalChannels,
  ambientEventsEnabled,
  lastAmbientEvent,
  onPlayAll,
  onStopAll,
  onReset,
  onMasterVolumeChange,
  onToggleAmbientEvents,
}: MasterControlsProps) {
  const volumePercent = Math.round(masterVolume * 100);

  let ambientStatusText = 'Off';
  let ambientStatusClass = 'text-zinc-500';
  if (ambientEventsEnabled) {
    if (!isActive) {
      ambientStatusText = 'Standby';
      ambientStatusClass = 'text-zinc-400';
    } else if (lastAmbientEvent) {
      ambientStatusText = lastAmbientEvent.statusText;
      ambientStatusClass = 'text-emerald-300/90';
    } else {
      ambientStatusText = 'Monitoring';
      ambientStatusClass = 'text-zinc-400';
    }
  }

  return (
    <section
      aria-label="Master Controls"
      className="border border-zinc-800 bg-[#0d1115] px-5 py-3.5 sm:px-6"
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
        {/* Master Volume Slider */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-4 mb-2">
            <label
              htmlFor="master-volume-slider"
              className="flex items-center gap-2 text-xs font-mono tracking-wider text-zinc-300"
            >
              <Volume2 className="h-4 w-4 text-emerald-400/80 shrink-0" aria-hidden="true" />
              <span>Master Output Level</span>
            </label>
            <div className="flex items-center gap-3 text-xs font-mono tabular-nums">
              <span className="text-zinc-500">
                {activeChannelCount}/{totalChannels} active
              </span>
              <span
                data-testid="master-volume-readout"
                className={isActive ? 'text-emerald-400 font-medium' : 'text-zinc-300 font-medium'}
              >
                {formatPercent(masterVolume)}
              </span>
            </div>
          </div>

          <div className="relative flex items-center h-9">
            <div className="absolute inset-x-0 h-1.5 rounded-xs bg-zinc-800 overflow-hidden pointer-events-none">
              <div
                className={`h-full transition-[width] duration-100 ${
                  isActive ? 'bg-emerald-500/75' : 'bg-zinc-500/60'
                }`}
                style={{ width: `${volumePercent}%` }}
              />
            </div>
            <input
              id="master-volume-slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={volumePercent}
              data-active={isActive ? 'true' : 'false'}
              aria-label="Master volume"
              onChange={(e) => onMasterVolumeChange(Number(e.target.value) / 100)}
              className="console-slider relative z-10 w-full"
            />
          </div>
        </div>

        {/* Transport & Reset Buttons */}
        <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center sm:gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onPlayAll}
            className={`inline-flex items-center justify-center gap-1.5 sm:gap-2 min-h-[44px] px-2.5 sm:px-4 py-2 text-xs font-mono font-medium tracking-wider border transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
              isActive && activeChannelCount === totalChannels
                ? 'bg-emerald-950/70 border-emerald-500/80 text-emerald-300'
                : 'bg-emerald-950/40 border-emerald-700/70 text-emerald-300 hover:bg-emerald-900/50 hover:border-emerald-500'
            }`}
          >
            <Play className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Play All</span>
          </button>

          <button
            type="button"
            onClick={onStopAll}
            className={`inline-flex items-center justify-center gap-1.5 sm:gap-2 min-h-[44px] px-2.5 sm:px-4 py-2 text-xs font-mono font-medium tracking-wider border transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
              !isActive
                ? 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                : 'bg-amber-950/35 border-amber-700/60 text-amber-300 hover:bg-amber-950/60 hover:border-amber-500'
            }`}
          >
            <Square className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Stop All</span>
          </button>

          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center justify-center gap-1.5 sm:gap-2 min-h-[44px] px-2.5 sm:px-4 py-2 text-xs font-mono font-medium tracking-wider border border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {/* Optional Ambient Events Control & Unobtrusive Status */}
      <div className="mt-3 pt-2.5 border-t border-zinc-800/80 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex items-center justify-between sm:justify-start gap-3">
          <button
            type="button"
            onClick={onToggleAmbientEvents}
            aria-pressed={ambientEventsEnabled}
            data-testid="ambient-events-toggle"
            aria-label={`Ambient Events ${ambientEventsEnabled ? 'on' : 'off'}`}
            className={`inline-flex items-center justify-center gap-2 min-w-[78px] min-h-[44px] sm:min-h-[34px] px-3 py-1.5 text-xs font-mono font-medium tracking-wider border transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
              ambientEventsEnabled
                ? 'bg-emerald-950/60 border-emerald-500/75 text-emerald-300 hover:bg-emerald-950/80'
                : 'bg-zinc-900 border-zinc-700/80 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${
                ambientEventsEnabled ? 'bg-emerald-400' : 'bg-zinc-600'
              }`}
            />
            <span>{ambientEventsEnabled ? 'ON' : 'OFF'}</span>
          </button>

          <div className="min-w-0">
            <div className="text-xs font-mono tracking-wider text-zinc-300">
              Ambient Events
            </div>
            <p className="text-[11px] text-zinc-500 leading-snug">
              Optional procedural shipboard events
            </p>
          </div>
        </div>

        <div
          data-testid="ambient-event-status"
          data-enabled={ambientEventsEnabled ? 'true' : 'false'}
          data-event-type={lastAmbientEvent?.type ?? 'none'}
          className="flex items-center gap-2 text-xs font-mono sm:text-right min-w-0"
        >
          <span className="text-zinc-500 shrink-0">Event Status:</span>
          <span className={`truncate ${ambientStatusClass}`}>{ambientStatusText}</span>
        </div>
      </div>
    </section>
  );
}
