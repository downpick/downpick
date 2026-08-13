import type { ReactElement, SVGProps } from 'react';

/**
 * Downpick icon set — Tabler outline, 24x24, stroke 2, currentColor.
 * Size defaults to 16 (header controls) — the explorer tree uses 13.
 *
 * Colour comes from the surrounding `text-*` class, never from the icon: these are
 * stroke-only outlines drawn in `currentColor`. `circle-filled` is the one exception and
 * fills itself.
 *
 * Transcribed from the Tabler outline set to match the design system handoff. `@tabler/
 * icons-react` gives the identical shapes if this ever wants to come from a package.
 */
export type IconName =
  | 'server'
  | 'database'
  | 'table'
  | 'schema-folder'
  | 'column'
  | 'key'
  | 'plug-connected'
  | 'plug-connected-x'
  | 'chevron-right'
  | 'chevron-down'
  | 'plus'
  | 'search'
  | 'dots-vertical'
  | 'refresh'
  | 'circle-filled'
  | 'brand-mongodb';

const PATHS: Record<IconName, ReactElement> = {
  'server': (
    <><path d="M3 4m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z" /><path d="M3 12m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z" /><path d="M7 8l0 .01" /><path d="M7 16l0 .01" /></>
  ),
  'database': (
    <><path d="M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0" /><path d="M4 6v6a8 3 0 0 0 16 0v-6" /><path d="M4 12v6a8 3 0 0 0 16 0v-6" /></>
  ),
  'table': (
    <><path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z" /><path d="M3 10h18" /><path d="M10 3v18" /></>
  ),
  'schema-folder': (
    <><path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" /></>
  ),
  'column': (
    <><path d="M4 6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z" /><path d="M14 6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z" /></>
  ),
  'key': (
    <><path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z" /><path d="M15 9h.01" /></>
  ),
  'plug-connected': (
    <><path d="M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5z" /><path d="M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5z" /><path d="M3 21l2.5 -2.5" /><path d="M18.5 5.5l2.5 -2.5" /><path d="M10 11l-2 2" /><path d="M13 14l-2 2" /></>
  ),
  'plug-connected-x': (
    <><path d="M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5z" /><path d="M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5z" /><path d="M3 21l2.5 -2.5" /><path d="M18.5 5.5l2.5 -2.5" /><path d="M22 22l-5 -5" /><path d="M17 22l5 -5" /></>
  ),
  'chevron-right': (
    <><path d="M9 6l6 6l-6 6" /></>
  ),
  'chevron-down': (
    <><path d="M6 9l6 6l6 -6" /></>
  ),
  'plus': (
    <><path d="M12 5l0 14" /><path d="M5 12l14 0" /></>
  ),
  'search': (
    <><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M21 21l-6 -6" /></>
  ),
  'dots-vertical': (
    <><path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M12 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M12 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /></>
  ),
  'refresh': (
    <><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" /></>
  ),
  'circle-filled': (
    <><path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" fill="currentColor" stroke="none" /></>
  ),
  'brand-mongodb': (
    <><path d="M12 3v19" /><path d="M18 11.5c0 4.5 -3 6.5 -6 8.5c-3 -2 -6 -4 -6 -8.5c0 -6.5 4 -7.5 6 -8.5c2 1 6 2 6 8.5z" /></>
  ),
};

export function Icon({
  name,
  size = 16,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

export default Icon;
