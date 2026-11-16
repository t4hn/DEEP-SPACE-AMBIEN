import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { getAcousticProfile } from '../audio/acousticProfiles';
import {
  type CustomSoundscape,
  MAX_SOUNDSCAPE_DESCRIPTION_LENGTH,
  MAX_SOUNDSCAPE_NAME_LENGTH,
  type SaveSoundscapeInput,
  type ValidationResult,
} from '../audio/customSoundscapes';
import {
  type ActivePresetState,
  CHANNELS,
  ENVIRONMENT_PRESETS,
  type PresetId,
  formatPercent,
} from '../audio/mixerState';

interface PresetSelectorProps {
  activePresetId: ActivePresetState;
  activeCustomSoundscapeId: string | null;
  customSoundscapes: readonly CustomSoundscape[];
  onSelectPreset: (presetId: PresetId) => void;
  onLoadCustomSoundscape: (soundscape: CustomSoundscape) => void;
  onSaveCustomSoundscape: (input: SaveSoundscapeInput) => ValidationResult<CustomSoundscape>;
  onUpdateCustomSoundscape: (
    id: string,
    input: SaveSoundscapeInput,
  ) => ValidationResult<CustomSoundscape>;
  onDeleteCustomSoundscape: (id: string) => void;
}

function summarizeSoundscapeConfig(soundscape: CustomSoundscape): string {
  const activeCount = CHANNELS.reduce(
    (acc, ch) => (soundscape.config.channels[ch.id].enabled ? acc + 1 : acc),
    0,
  );
  const profileLabel = getAcousticProfile(soundscape.config.acousticProfileId).label;
  const masterLabel = formatPercent(soundscape.config.masterVolume);
  const eventsLabel = soundscape.config.ambientEventsEnabled ? 'Events ON' : 'Events OFF';
  return `${activeCount}/${CHANNELS.length} ch · Master ${masterLabel} · ${profileLabel} · ${eventsLabel}`;
}

export function PresetSelector({
  activePresetId,
  activeCustomSoundscapeId,
  customSoundscapes,
  onSelectPreset,
  onLoadCustomSoundscape,
  onSaveCustomSoundscape,
  onUpdateCustomSoundscape,
  onDeleteCustomSoundscape,
}: PresetSelectorProps) {
  const [isSaveOpen, setIsSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDescription, setSaveDescription] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const activeBuiltInPreset = ENVIRONMENT_PRESETS.find((p) => p.id === activePresetId);
  const activeCustomSoundscape = activeCustomSoundscapeId
    ? customSoundscapes.find((s) => s.id === activeCustomSoundscapeId) ?? null
    : null;

  let statusLabel = 'Default';
  let statusClass = 'text-zinc-500';
  if (activeCustomSoundscape) {
    statusLabel = `${activeCustomSoundscape.name} (Saved)`;
    statusClass = 'text-emerald-400';
  } else if (activePresetId === 'custom') {
    statusLabel = 'CUSTOM';
    statusClass = 'text-amber-300';
  } else if (activeBuiltInPreset) {
    statusLabel = activeBuiltInPreset.name;
    statusClass = 'text-emerald-400';
  }

  const handleOpenSaveForm = () => {
    setIsSaveOpen((open) => !open);
    setSaveError(null);
    setEditingId(null);
    setConfirmDeleteId(null);
  };

  const handleCancelSave = () => {
    setIsSaveOpen(false);
    setSaveName('');
    setSaveDescription('');
    setSaveError(null);
  };

  const handleSubmitSave = (e: FormEvent) => {
    e.preventDefault();
    const res = onSaveCustomSoundscape({
      name: saveName,
      description: saveDescription,
    });
    if (!res.ok) {
      setSaveError(res.error);
      return;
    }
    setIsSaveOpen(false);
    setSaveName('');
    setSaveDescription('');
    setSaveError(null);
  };

  const handleStartEdit = (soundscape: CustomSoundscape) => {
    setIsSaveOpen(false);
    setConfirmDeleteId(null);
    setEditingId(soundscape.id);
    setEditName(soundscape.name);
    setEditDescription(soundscape.description);
    setEditError(null);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditDescription('');
    setEditError(null);
  };

  const handleSubmitEdit = (e: FormEvent, id: string) => {
    e.preventDefault();
    const res = onUpdateCustomSoundscape(id, {
      name: editName,
      description: editDescription,
    });
    if (!res.ok) {
      setEditError(res.error);
      return;
    }
    handleCancelEdit();
  };

  const handleRequestDelete = (id: string) => {
    setIsSaveOpen(false);
    setEditingId(null);
    setConfirmDeleteId(id);
  };

  const handleConfirmDelete = (id: string) => {
    onDeleteCustomSoundscape(id);
    setConfirmDeleteId(null);
  };

  return (
    <section
      aria-label="Environment Presets"
      className="border border-zinc-800 bg-[#0d1115] px-5 py-3.5 sm:px-6"
    >
      {/* Built-In Presets Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4 mb-2.5">
        <div className="flex items-center gap-2.5">
          <h2 className="text-xs font-mono uppercase tracking-wider text-zinc-300 whitespace-nowrap shrink-0">
            Environment Presets
          </h2>
          <span className="text-[11px] font-mono text-zinc-500">Built-In</span>
        </div>
        <div
          data-testid="preset-status"
          data-preset={activeCustomSoundscape ? activeCustomSoundscape.id : (activePresetId ?? 'default')}
          className="flex items-center gap-2 text-xs font-mono whitespace-nowrap"
        >
          <span className="text-zinc-500">Profile:</span>
          <span className={`font-medium ${statusClass}`}>{statusLabel}</span>
        </div>
      </div>

      {/* Immutable Built-In Presets Grid */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {ENVIRONMENT_PRESETS.map((preset) => {
          const isSelected = activePresetId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelectPreset(preset.id)}
              aria-pressed={isSelected}
              data-testid={`preset-button-${preset.id}`}
              className={`flex flex-col items-start justify-start text-left min-h-[44px] px-3.5 py-2.5 border transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
                isSelected
                  ? 'bg-emerald-950/60 border-emerald-500/75 text-emerald-300'
                  : 'bg-[#0a0e12] border-zinc-800/90 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-900/60'
              }`}
            >
              <div className="flex items-center gap-2 w-full">
                <span
                  aria-hidden="true"
                  className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
                    isSelected ? 'bg-emerald-400' : 'bg-zinc-600'
                  }`}
                />
                <span className="text-xs font-mono font-medium tracking-wide truncate">
                  {preset.name}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-zinc-400">
                {preset.description}
              </p>
            </button>
          );
        })}
      </div>

      {/* Custom Soundscapes Divider & Management Section */}
      <div
        data-testid="custom-soundscapes-section"
        className="mt-3.5 pt-3 border-t border-zinc-800/80"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-2.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-300 whitespace-nowrap">
              Custom Soundscapes
            </h3>
            <span
              data-testid="custom-soundscapes-count"
              className="text-[11px] font-mono text-zinc-500 tabular-nums"
            >
              {customSoundscapes.length} saved
            </span>
          </div>

          <button
            type="button"
            onClick={handleOpenSaveForm}
            aria-expanded={isSaveOpen}
            data-testid="save-soundscape-open"
            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] sm:min-h-[36px] px-3.5 py-1.5 text-xs font-mono font-medium tracking-wider border border-emerald-700/70 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/50 hover:border-emerald-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            {isSaveOpen ? (
              <>
                <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Close Save</span>
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Save Current</span>
              </>
            )}
          </button>
        </div>

        {/* Inline Save Form */}
        {isSaveOpen && (
          <form
            onSubmit={handleSubmitSave}
            noValidate
            data-testid="save-soundscape-form"
            className="mb-3 border border-zinc-700/90 bg-[#0a0e12] p-3.5"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="custom-soundscape-name-input"
                  className="block text-[11px] font-mono text-zinc-300 mb-1"
                >
                  Soundscape Name <span className="text-emerald-400">*</span>
                </label>
                <input
                  id="custom-soundscape-name-input"
                  type="text"
                  value={saveName}
                  maxLength={MAX_SOUNDSCAPE_NAME_LENGTH}
                  onChange={(e) => {
                    setSaveName(e.target.value);
                    if (saveError) setSaveError(null);
                  }}
                  placeholder="e.g. Night Drift Lab"
                  data-testid="save-soundscape-name-input"
                  autoFocus
                  className="w-full min-h-[40px] border border-zinc-700 bg-[#07090b] px-3 py-1.5 text-xs font-sans text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="custom-soundscape-desc-input"
                  className="block text-[11px] font-mono text-zinc-300 mb-1"
                >
                  Description <span className="text-zinc-500">(optional)</span>
                </label>
                <input
                  id="custom-soundscape-desc-input"
                  type="text"
                  value={saveDescription}
                  maxLength={MAX_SOUNDSCAPE_DESCRIPTION_LENGTH}
                  onChange={(e) => setSaveDescription(e.target.value)}
                  placeholder="Short note about mix or deck atmosphere"
                  data-testid="save-soundscape-desc-input"
                  className="w-full min-h-[40px] border border-zinc-700 bg-[#07090b] px-3 py-1.5 text-xs font-sans text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>

            {saveError && (
              <p
                role="alert"
                data-testid="save-soundscape-error"
                className="mt-2 text-xs font-mono text-amber-300"
              >
                {saveError}
              </p>
            )}

            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[11px] font-mono text-zinc-500">
                Saves all 6 channels, master level, acoustic profile &amp; ambient events.
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleCancelSave}
                  data-testid="save-soundscape-cancel"
                  className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[36px] px-3.5 py-1.5 text-xs font-mono border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="save-soundscape-submit"
                  className="inline-flex items-center justify-center gap-1.5 min-h-[44px] sm:min-h-[36px] px-4 py-1.5 text-xs font-mono font-medium border border-emerald-500/80 bg-emerald-950/70 text-emerald-300 hover:bg-emerald-900/60 transition-colors cursor-pointer"
                >
                  <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>Save Soundscape</span>
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Saved Soundscapes List or Empty State */}
        {customSoundscapes.length === 0 ? (
          <p
            data-testid="custom-soundscapes-empty"
            className="text-xs text-zinc-500 border border-dashed border-zinc-800/90 bg-[#0a0e12]/60 px-3.5 py-2.5"
          >
            No custom soundscapes saved. Configure channels, master volume, or acoustic profile and select Save Current.
          </p>
        ) : (
          <div
            data-testid="custom-soundscapes-list"
            className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
          >
            {customSoundscapes.map((soundscape) => {
              const isSelected = activeCustomSoundscapeId === soundscape.id;
              const isEditing = editingId === soundscape.id;
              const isConfirmingDelete = confirmDeleteId === soundscape.id;

              if (isEditing) {
                return (
                  <form
                    key={soundscape.id}
                    onSubmit={(e) => handleSubmitEdit(e, soundscape.id)}
                    noValidate
                    data-testid={`custom-soundscape-edit-form-${soundscape.id}`}
                    className="border border-emerald-700/70 bg-[#0a0e12] p-3"
                  >
                    <div className="space-y-2">
                      <div>
                        <label
                          htmlFor={`edit-name-${soundscape.id}`}
                          className="block text-[11px] font-mono text-zinc-300 mb-1"
                        >
                          Name <span className="text-emerald-400">*</span>
                        </label>
                        <input
                          id={`edit-name-${soundscape.id}`}
                          type="text"
                          value={editName}
                          maxLength={MAX_SOUNDSCAPE_NAME_LENGTH}
                          onChange={(e) => {
                            setEditName(e.target.value);
                            if (editError) setEditError(null);
                          }}
                          data-testid={`custom-soundscape-edit-name-${soundscape.id}`}
                          autoFocus
                          className="w-full min-h-[38px] border border-zinc-700 bg-[#07090b] px-2.5 py-1 text-xs font-sans text-zinc-100 focus:border-emerald-500 focus:outline-none"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor={`edit-desc-${soundscape.id}`}
                          className="block text-[11px] font-mono text-zinc-300 mb-1"
                        >
                          Description
                        </label>
                        <input
                          id={`edit-desc-${soundscape.id}`}
                          type="text"
                          value={editDescription}
                          maxLength={MAX_SOUNDSCAPE_DESCRIPTION_LENGTH}
                          onChange={(e) => setEditDescription(e.target.value)}
                          data-testid={`custom-soundscape-edit-desc-${soundscape.id}`}
                          className="w-full min-h-[38px] border border-zinc-700 bg-[#07090b] px-2.5 py-1 text-xs font-sans text-zinc-100 focus:border-emerald-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    {editError && (
                      <p
                        role="alert"
                        className="mt-1.5 text-xs font-mono text-amber-300"
                      >
                        {editError}
                      </p>
                    )}

                    <div className="mt-2.5 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        data-testid={`custom-soundscape-edit-cancel-${soundscape.id}`}
                        className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[34px] px-3 py-1 text-xs font-mono border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        data-testid={`custom-soundscape-edit-save-${soundscape.id}`}
                        className="inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[34px] px-3 py-1 text-xs font-mono font-medium border border-emerald-500/80 bg-emerald-950/70 text-emerald-300 hover:bg-emerald-900/60 cursor-pointer"
                      >
                        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>Save</span>
                      </button>
                    </div>
                  </form>
                );
              }

              if (isConfirmingDelete) {
                return (
                  <div
                    key={soundscape.id}
                    data-testid={`custom-soundscape-delete-confirm-box-${soundscape.id}`}
                    className="flex flex-col justify-between gap-2.5 border border-amber-700/70 bg-[#120f0d] p-3"
                  >
                    <div>
                      <p className="text-xs font-mono text-amber-200">
                        Delete saved soundscape &ldquo;{soundscape.name}&rdquo;?
                      </p>
                      <p className="mt-0.5 text-[11px] text-zinc-400">
                        This action cannot be undone.
                      </p>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        data-testid={`custom-soundscape-delete-cancel-${soundscape.id}`}
                        className="inline-flex items-center justify-center min-h-[44px] sm:min-h-[34px] px-3 py-1 text-xs font-mono border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConfirmDelete(soundscape.id)}
                        data-testid={`custom-soundscape-delete-confirm-${soundscape.id}`}
                        className="inline-flex items-center justify-center gap-1 min-h-[44px] sm:min-h-[34px] px-3 py-1 text-xs font-mono font-medium border border-amber-600/80 bg-amber-950/60 text-amber-200 hover:bg-amber-900/60 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={soundscape.id}
                  data-testid={`custom-soundscape-card-${soundscape.id}`}
                  className={`flex items-stretch justify-between gap-2 border transition-colors ${
                    isSelected
                      ? 'bg-emerald-950/60 border-emerald-500/75'
                      : 'bg-[#0a0e12] border-zinc-800/90 hover:border-zinc-700'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onLoadCustomSoundscape(soundscape)}
                    aria-pressed={isSelected}
                    data-testid={`custom-soundscape-load-${soundscape.id}`}
                    className="flex-1 min-w-0 flex flex-col items-start justify-center text-left min-h-[44px] px-3.5 py-2.5 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-400"
                  >
                    <div className="flex items-center gap-2 w-full">
                      <span
                        aria-hidden="true"
                        className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
                          isSelected ? 'bg-emerald-400' : 'bg-zinc-600'
                        }`}
                      />
                      <span
                        className={`text-xs font-mono font-medium tracking-wide truncate ${
                          isSelected ? 'text-emerald-300' : 'text-zinc-200'
                        }`}
                      >
                        {soundscape.name}
                      </span>
                    </div>
                    {soundscape.description && (
                      <p className="mt-1 text-[11px] leading-snug text-zinc-400 line-clamp-2">
                        {soundscape.description}
                      </p>
                    )}
                    <p className="mt-1 text-[10px] font-mono text-zinc-500 truncate w-full">
                      {summarizeSoundscapeConfig(soundscape)}
                    </p>
                  </button>

                  <div className="flex items-center gap-1 pr-2 py-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleStartEdit(soundscape)}
                      aria-label={`Edit ${soundscape.name}`}
                      title={`Rename or edit ${soundscape.name}`}
                      data-testid={`custom-soundscape-edit-${soundscape.id}`}
                      className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-[34px] sm:min-h-[34px] border border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:border-zinc-600 hover:text-zinc-100 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleRequestDelete(soundscape.id)}
                      aria-label={`Delete ${soundscape.name}`}
                      title={`Delete ${soundscape.name}`}
                      data-testid={`custom-soundscape-delete-${soundscape.id}`}
                      className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-[34px] sm:min-h-[34px] border border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:border-amber-700/80 hover:text-amber-300 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
