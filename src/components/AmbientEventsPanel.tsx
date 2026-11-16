import type { AmbientEventDescriptor } from '../audio/ambientEvents';

interface AmbientEventsPanelProps {
  isActive: boolean;
  ambientEventsEnabled: boolean;
  lastAmbientEvent: AmbientEventDescriptor | null;
  onToggleAmbientEvents: () => void;
}

export function AmbientEventsPanel({
  isActive,
  ambientEventsEnabled,
  lastAmbientEvent,
  onToggleAmbientEvents,
}: AmbientEventsPanelProps) {
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
      aria-label="Ambient Events"
      data-testid="ambient-events-panel"
      className="border border-zinc-800 bg-[#0d1115] px-5 py-3 sm:px-6"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
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
            <h2 className="text-xs font-mono uppercase tracking-wider text-zinc-300">
              Ambient Events
            </h2>
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
