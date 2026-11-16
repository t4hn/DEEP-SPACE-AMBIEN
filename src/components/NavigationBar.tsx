import { Activity, Layers, SlidersHorizontal } from 'lucide-react';
import { APP_SECTIONS, type AppSectionId } from '../audio/navigation';

interface NavigationBarProps {
  activeSection: AppSectionId;
  onSelectSection: (sectionId: AppSectionId) => void;
}

function SectionIcon({
  sectionId,
  className,
}: {
  sectionId: AppSectionId;
  className?: string;
}) {
  if (sectionId === 'console') {
    return <SlidersHorizontal className={className} aria-hidden="true" />;
  }
  if (sectionId === 'environments') {
    return <Layers className={className} aria-hidden="true" />;
  }
  return <Activity className={className} aria-hidden="true" />;
}

export function DesktopNavigation({
  activeSection,
  onSelectSection,
}: NavigationBarProps) {
  return (
    <nav
      aria-label="Primary sections"
      data-testid="desktop-navigation"
      className="hidden md:grid md:grid-cols-3 border border-zinc-800 bg-[#0a0e12]"
    >
      {APP_SECTIONS.map((section, idx) => {
        const isSelected = activeSection === section.id;
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelectSection(section.id)}
            aria-current={isSelected ? 'page' : undefined}
            data-testid={`desktop-nav-${section.id}`}
            className={`relative flex items-center justify-center gap-2.5 min-h-[42px] px-4 py-2 text-xs font-mono tracking-wider transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-400 ${
              idx > 0 ? 'border-l border-zinc-800/90' : ''
            } ${
              isSelected
                ? 'bg-emerald-950/55 text-emerald-300 font-medium'
                : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
            }`}
          >
            <SectionIcon
              sectionId={section.id}
              className={`h-3.5 w-3.5 shrink-0 ${
                isSelected ? 'text-emerald-400' : 'text-zinc-500'
              }`}
            />
            <span>{section.label}</span>
            {isSelected && (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 h-0.5 bg-emerald-400"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}

export function MobileBottomNavigation({
  activeSection,
  onSelectSection,
}: NavigationBarProps) {
  return (
    <nav
      aria-label="Mobile sections"
      data-testid="mobile-navigation"
      className="grid grid-cols-3 border-t border-zinc-800 bg-[#080b0e] pb-[env(safe-area-inset-bottom)]"
    >
      {APP_SECTIONS.map((section, idx) => {
        const isSelected = activeSection === section.id;
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelectSection(section.id)}
            aria-current={isSelected ? 'page' : undefined}
            data-testid={`mobile-nav-${section.id}`}
            className={`relative flex flex-col items-center justify-center gap-1 min-h-[50px] px-2 py-1.5 transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-400 ${
              idx > 0 ? 'border-l border-zinc-800/70' : ''
            } ${
              isSelected
                ? 'bg-emerald-950/45 text-emerald-300 font-medium'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {isSelected && (
              <span
                aria-hidden="true"
                className="absolute inset-x-4 top-0 h-0.5 bg-emerald-400"
              />
            )}
            <SectionIcon
              sectionId={section.id}
              className={`h-4 w-4 shrink-0 ${
                isSelected ? 'text-emerald-400' : 'text-zinc-500'
              }`}
            />
            <span className="text-[10px] font-mono tracking-wider leading-none">
              {section.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
