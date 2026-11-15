import {
  ACOUSTIC_PROFILES,
  type AcousticProfileId,
  getAcousticProfile,
} from '../audio/acousticProfiles';

interface AcousticProfileSelectorProps {
  activeProfileId: AcousticProfileId;
  onSelectProfile: (profileId: AcousticProfileId) => void;
}

export function AcousticProfileSelector({
  activeProfileId,
  onSelectProfile,
}: AcousticProfileSelectorProps) {
  const activeProfile = getAcousticProfile(activeProfileId);

  return (
    <section
      aria-label="Acoustic Environment"
      className="border border-zinc-800 bg-[#0d1115] px-5 py-3.5 sm:px-6"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4 mb-2.5">
        <h2 className="text-xs font-mono uppercase tracking-wider text-zinc-300 whitespace-nowrap shrink-0">
          ACOUSTIC ENVIRONMENT
        </h2>
        <div
          data-testid="acoustic-profile-status"
          data-profile={activeProfile.id}
          className="flex items-center gap-2 text-xs font-mono whitespace-nowrap"
        >
          <span className="text-zinc-500">Environment:</span>
          <span className="font-medium text-emerald-400">{activeProfile.label}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {ACOUSTIC_PROFILES.map((profile) => {
          const isSelected = activeProfileId === profile.id;
          return (
            <button
              key={profile.id}
              type="button"
              onClick={() => onSelectProfile(profile.id)}
              aria-pressed={isSelected}
              data-testid={`acoustic-profile-button-${profile.id}`}
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
                  {profile.label}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-zinc-400">
                {profile.description}
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
