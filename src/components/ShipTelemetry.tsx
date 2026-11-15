import type { RefObject } from 'react';
import type { AmbientEventDescriptor } from '../audio/ambientEvents';
import type { ChannelId, MixerState } from '../audio/mixerState';
import {
  VESSEL_IDENTIFICATION,
  deriveAmbientMonitoring,
  deriveOperationalStatus,
  deriveShipSystems,
} from '../audio/shipTelemetry';

interface ShipTelemetryProps {
  state: MixerState;
  lastAmbientEvent: AmbientEventDescriptor | null;
  telemetryMeterRefs: Record<ChannelId, RefObject<HTMLDivElement | null>>;
}

export function ShipTelemetry({
  state,
  lastAmbientEvent,
  telemetryMeterRefs,
}: ShipTelemetryProps) {
  const operationalStatus = deriveOperationalStatus(state);
  const systems = deriveShipSystems(state);
  const ambientMonitoring = deriveAmbientMonitoring(
    state.ambientEventsEnabled,
    lastAmbientEvent,
  );

  const isFullSystems = operationalStatus === 'FULL SYSTEMS';
  const isOperational = operationalStatus === 'OPERATIONAL';

  let statusColorClass = 'text-amber-300';
  let statusGlyph = '◌';
  if (isFullSystems || isOperational) {
    statusColorClass = 'text-emerald-400';
    statusGlyph = '●';
  }

  return (
    <section
      aria-label="Ship Telemetry"
      data-testid="ship-telemetry"
      className="border border-zinc-800 bg-[#0d1115] px-4 py-3 sm:px-6"
    >
      {/* Row 1: Vessel Identification & Operational Status */}
      <div className="flex flex-col gap-1.5 pb-2.5 mb-2.5 border-b border-zinc-800/80 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div
          data-testid="telemetry-vessel-id"
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-mono"
        >
          <span className="text-emerald-400/90 font-medium tabular-nums">
            {VESSEL_IDENTIFICATION.designation}
          </span>
          <span className="text-zinc-600" aria-hidden="true">
            ·
          </span>
          <span className="text-zinc-100 font-semibold tracking-wide">
            {VESSEL_IDENTIFICATION.name}
          </span>
          <span className="text-zinc-600" aria-hidden="true">
            ·
          </span>
          <span className="font-sans text-zinc-400">
            {VESSEL_IDENTIFICATION.classification}
          </span>
        </div>

        <div
          data-testid="telemetry-operational-status"
          data-status={operationalStatus}
          className="flex items-center gap-2 text-xs font-mono whitespace-nowrap shrink-0"
        >
          <span className="text-zinc-500">Vessel Status:</span>
          <span aria-hidden="true" className={statusColorClass}>
            {statusGlyph}
          </span>
          <span className={`font-medium tracking-wider ${statusColorClass}`}>
            {operationalStatus}
          </span>
        </div>
      </div>

      {/* Row 2: Six Linked Ship Systems */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {systems.map((sys) => (
          <div
            key={sys.channelId}
            data-testid={`telemetry-system-${sys.channelId}`}
            data-active={sys.active ? 'true' : 'false'}
            className={`border px-2 sm:px-2.5 py-2 transition-colors ${
              sys.active
                ? 'bg-[#0e1519] border-emerald-800/60'
                : 'bg-[#0a0e12] border-zinc-800/90'
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[10px] font-mono font-medium tracking-normal text-zinc-200 truncate">
                {sys.systemName}
              </span>
              <span className="text-[10px] font-mono tabular-nums text-zinc-500 shrink-0">
                {sys.code}
              </span>
            </div>

            <div className="mt-1 flex items-center gap-1.5 text-[11px] font-mono">
              <span
                aria-hidden="true"
                className={sys.active ? 'text-emerald-400' : 'text-zinc-600'}
              >
                {sys.active ? '●' : '◌'}
              </span>
              <span
                className={
                  sys.active ? 'text-emerald-400 font-medium' : 'text-zinc-500'
                }
              >
                {sys.statusLabel}
              </span>
            </div>

            {/* Compact signal activity bar driven by existing channel analyser loop */}
            <div
              className="mt-1.5 h-1 w-full bg-zinc-800/90 overflow-hidden"
              aria-hidden="true"
            >
              <div
                ref={telemetryMeterRefs[sys.channelId]}
                data-testid={`telemetry-meter-${sys.channelId}`}
                className={`h-full w-full origin-left transition-opacity duration-150 ${
                  sys.active ? 'bg-emerald-400/80 opacity-100' : 'bg-zinc-600 opacity-0'
                }`}
                style={{ transform: 'scaleX(0)' }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Row 3: Ambient Event Monitoring Readout */}
      <div
        data-testid="telemetry-ambient-monitoring"
        data-enabled={ambientMonitoring.enabled ? 'true' : 'false'}
        className="mt-2.5 pt-2 border-t border-zinc-800/80 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4 text-[11px] font-mono"
      >
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-zinc-500">Ambient Events:</span>
          <span
            className={
              ambientMonitoring.enabled
                ? 'text-emerald-400 font-medium'
                : 'text-zinc-500'
            }
          >
            {ambientMonitoring.toggleLabel}
          </span>
        </div>

        <div className="flex items-center gap-2 min-w-0">
          <span className="text-zinc-500 shrink-0">Telemetry Feed:</span>
          <span
            data-testid="telemetry-ambient-readout"
            className={`truncate ${
              ambientMonitoring.hasEvent
                ? 'text-emerald-300/90'
                : ambientMonitoring.enabled
                  ? 'text-zinc-300'
                  : 'text-zinc-500'
            }`}
          >
            {ambientMonitoring.readout}
          </span>
        </div>
      </div>
    </section>
  );
}
