export type AppSectionId = 'console' | 'environments' | 'ship-status';

export interface AppSectionMeta {
  id: AppSectionId;
  label: string;
  shortLabel: string;
  description: string;
}

export const DEFAULT_SECTION_ID: AppSectionId = 'console';

export const APP_SECTIONS: readonly AppSectionMeta[] = [
  {
    id: 'console',
    label: 'CONSOLE',
    shortLabel: 'Console',
    description: 'Master output, playback transitions, ambient events, and six-channel mixer',
  },
  {
    id: 'environments',
    label: 'ENVIRONMENTS',
    shortLabel: 'Environments',
    description: 'Built-in presets, custom soundscapes, and acoustic spaces',
  },
  {
    id: 'ship-status',
    label: 'SHIP STATUS',
    shortLabel: 'Ship Status',
    description: 'DSV-01 diagnostics and live system telemetry',
  },
] as const;

export function isAppSectionId(value: unknown): value is AppSectionId {
  return value === 'console' || value === 'environments' || value === 'ship-status';
}

export function getAppSectionMeta(sectionId: AppSectionId): AppSectionMeta {
  return APP_SECTIONS.find((section) => section.id === sectionId) ?? APP_SECTIONS[0];
}
