import type { CSSProperties } from 'react';
import type { IconName } from '../../shared/types';

// Duotone icon set: `f` = soft fill, `s` = outline, `d` = solid detail, `a` = accent.
// Styling comes from app.css (`symbol .f` …) through custom properties, so it reaches <use> clones.
const SPRITE = `
<linearGradient id="g-brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b4cff"/><stop offset="0.55" stop-color="#8a5cff"/><stop offset="1" stop-color="#ff5d8f"/></linearGradient>
<symbol id="i-scan" viewBox="0 0 24 24"><circle class="f" cx="12" cy="12" r="9"/><circle class="s" cx="12" cy="12" r="9"/><path class="s" d="M12 12L18.4 5.6"/><path class="s" d="M12 7a5 5 0 1 0 5 5"/><circle class="a" cx="16.2" cy="14.8" r="1.6"/></symbol>
<symbol id="i-broom" viewBox="0 0 24 24"><path class="f" d="M6.5 13.5l4 4-2.6 3.2c-.4.5-1.1.6-1.6.2L3.1 18.1c-.5-.4-.5-1.1-.1-1.6z"/><path class="s" d="M14 10l6.5-6.5"/><path class="s" d="M6.5 13.5l4 4"/><path class="s" d="M8.5 11.5l4 4 1.5-1.5c.8-.8.8-2 0-2.8l-1.2-1.2c-.8-.8-2-.8-2.8 0z"/><path class="s" d="M6.5 13.5L3 17.2c-.4.5-.4 1.2.1 1.6l3.2 2.1c.5.3 1.2.2 1.6-.2l2.6-3.2"/><path class="s" d="M5.5 18.5l1.8-1.8"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path class="f" d="M12 3l7.5 2.8v5.9c0 4.6-3.2 8-7.5 9.3-4.3-1.3-7.5-4.7-7.5-9.3V5.8z"/><path class="s" d="M12 3l7.5 2.8v5.9c0 4.6-3.2 8-7.5 9.3-4.3-1.3-7.5-4.7-7.5-9.3V5.8z"/><path class="s" d="M8.8 12.2l2.2 2.2 4.4-4.6"/></symbol>
<symbol id="i-gauge" viewBox="0 0 24 24"><path class="f" d="M3.5 16a8.5 8.5 0 0 1 17 0z"/><path class="s" d="M3.5 16a8.5 8.5 0 0 1 17 0"/><path class="s" d="M12 16l4.2-5"/><path class="s" d="M6.2 11.2l1 .8 M12 7.5V9 M17.8 11.2l-1 .8"/><circle class="d" cx="12" cy="16" r="1.8"/><path class="s" d="M3.5 19.5h17"/></symbol>
<symbol id="i-apps" viewBox="0 0 24 24"><rect class="f" x="3.5" y="13" width="7.5" height="7.5" rx="2.2"/><rect class="s" x="3.5" y="3.5" width="7.5" height="7.5" rx="2.2"/><rect class="s" x="3.5" y="13" width="7.5" height="7.5" rx="2.2"/><rect class="s" x="13" y="13" width="7.5" height="7.5" rx="2.2"/><circle class="a" cx="16.75" cy="7.25" r="3.4"/></symbol>
<symbol id="i-bubbles" viewBox="0 0 24 24"><circle class="f" cx="9" cy="10" r="6"/><circle class="s" cx="9" cy="10" r="6"/><circle class="s" cx="17.5" cy="15.5" r="3.5"/><circle class="s" cx="10.5" cy="19.5" r="1.8"/><path class="s" d="M6.5 8a3 3 0 0 1 2.5-1.5"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24"><path class="f" d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path class="s" d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path class="s" d="M14 3v5h5"/><path class="s" d="M8.5 13h7 M8.5 16.5h4.5"/></symbol>
<symbol id="i-dupes" viewBox="0 0 24 24"><rect class="f" x="9" y="9" width="11.5" height="11.5" rx="2.5"/><rect class="s" x="9" y="9" width="11.5" height="11.5" rx="2.5"/><path class="s" d="M15 9V6a2.5 2.5 0 0 0-2.5-2.5h-6A2.5 2.5 0 0 0 4 6v6.5A2.5 2.5 0 0 0 6.5 15H9"/><path class="s" d="M12.5 14.8h4.5 M14.75 12.5v4.5"/></symbol>
<symbol id="i-history" viewBox="0 0 24 24"><circle class="f" cx="12.5" cy="12" r="8"/><path class="s" d="M4.6 10.5A8 8 0 1 1 6.8 17.6"/><path class="s" d="M3.5 6.5v4h4"/><path class="s" d="M12.5 8v4.2l2.8 1.8"/></symbol>
<symbol id="i-assist" viewBox="0 0 24 24"><path class="f" d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z"/><path class="s" d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z"/><path class="d" d="M12 6.8l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/></symbol>
<symbol id="i-user" viewBox="0 0 24 24"><circle class="f" cx="12" cy="8" r="4"/><circle class="s" cx="12" cy="8" r="4"/><path class="s" d="M4.5 20.5c.8-3.8 3.8-5.8 7.5-5.8s6.7 2 7.5 5.8"/></symbol>
<symbol id="i-game" viewBox="0 0 24 24"><path class="f" d="M7 8h10a4.5 4.5 0 0 1 4.4 5.4l-.7 3.3a2.4 2.4 0 0 1-4.2 1L15 16H9l-1.5 1.7a2.4 2.4 0 0 1-4.2-1l-.7-3.3A4.5 4.5 0 0 1 7 8z"/><path class="s" d="M7 8h10a4.5 4.5 0 0 1 4.4 5.4l-.7 3.3a2.4 2.4 0 0 1-4.2 1L15 16H9l-1.5 1.7a2.4 2.4 0 0 1-4.2-1l-.7-3.3A4.5 4.5 0 0 1 7 8z"/><path class="s" d="M8 10.8v3 M6.5 12.3h3"/><circle class="d" cx="15.8" cy="11.4" r="1"/><circle class="d" cx="17.6" cy="13.4" r="1"/></symbol>
<symbol id="i-down" viewBox="0 0 24 24"><path class="f" d="M3.5 14h5l1.5 2.5h4l1.5-2.5h5v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path class="s" d="M3.5 14h5l1.5 2.5h4l1.5-2.5h5v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path class="s" d="M12 3.5v9 M8.5 9l3.5 3.5L15.5 9"/></symbol>
<symbol id="i-chip" viewBox="0 0 24 24"><rect class="f" x="6.5" y="6.5" width="11" height="11" rx="2.5"/><rect class="s" x="6.5" y="6.5" width="11" height="11" rx="2.5"/><path class="s" d="M10 3.5v3 M14 3.5v3 M10 17.5v3 M14 17.5v3 M3.5 10h3 M3.5 14h3 M17.5 10h3 M17.5 14h3"/><rect class="d" x="10" y="10" width="4" height="4" rx="1"/></symbol>
<symbol id="i-more" viewBox="0 0 24 24"><circle class="d" cx="6" cy="12" r="1.8"/><circle class="d" cx="12" cy="12" r="1.8"/><circle class="d" cx="18" cy="12" r="1.8"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path class="s" d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24"><path class="s" d="M5 12h13 M13 6.5l5.5 5.5-5.5 5.5"/></symbol>
<symbol id="i-heart" viewBox="0 0 24 24"><path class="f" d="M12 20s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.2a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z"/><path class="s" d="M12 20s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.2a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z"/><circle class="a" cx="16.2" cy="9.6" r="1.4"/></symbol>
<symbol id="i-chat" viewBox="0 0 24 24"><path class="f" d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z"/><path class="s" d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z"/><path class="s" d="M8.5 9h7 M8.5 12.5h4.5"/></symbol>
<symbol id="i-gear" viewBox="0 0 24 24"><path class="s" d="M4 7h9 M19 7h1 M4 17h3 M13 17h7"/><circle class="f" cx="16" cy="7" r="2.6"/><circle class="s" cx="16" cy="7" r="2.6"/><circle class="f" cx="10" cy="17" r="2.6"/><circle class="s" cx="10" cy="17" r="2.6"/></symbol>
<symbol id="i-trash" viewBox="0 0 24 24"><path class="f" d="M6 7.5h12l-1 12.5H7z"/><path class="s" d="M4 7.5h16 M9 7.5V4.5h6v3 M6 7.5l1 12.5h10l1-12.5"/><path class="s" d="M10 11v5.5 M14 11v5.5"/></symbol>
<symbol id="i-folder" viewBox="0 0 24 24"><path class="f" d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path class="s" d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></symbol>
<symbol id="i-photo" viewBox="0 0 24 24"><rect class="f" x="3.5" y="5" width="17" height="14" rx="2.5"/><rect class="s" x="3.5" y="5" width="17" height="14" rx="2.5"/><path class="s" d="M3.5 16l5-5 4 4 2.5-2.5 5.5 5"/><circle class="a" cx="15.5" cy="9.5" r="1.6"/></symbol>
<symbol id="i-video" viewBox="0 0 24 24"><rect class="f" x="3" y="6" width="13" height="12" rx="2.5"/><rect class="s" x="3" y="6" width="13" height="12" rx="2.5"/><path class="s" d="M16 10.5l5-3v9l-5-3"/></symbol>
<symbol id="i-music" viewBox="0 0 24 24"><circle class="f" cx="7" cy="17.5" r="2.8"/><path class="s" d="M9.8 17.5V5.5l10-2v12"/><circle class="s" cx="7" cy="17.5" r="2.8"/><circle class="s" cx="17" cy="15.5" r="2.8"/><path class="s" d="M9.8 9l10-2"/></symbol>
<symbol id="i-doc" viewBox="0 0 24 24"><path class="f" d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path class="s" d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path class="s" d="M14 3v5h5 M8.5 12h7 M8.5 15.5h7 M8.5 19h4"/></symbol>
<symbol id="i-code" viewBox="0 0 24 24"><rect class="f" x="3" y="4.5" width="18" height="15" rx="3"/><path class="s" d="M9 9l-3.2 3L9 15 M15 9l3.2 3L15 15 M13 7.5l-2 9"/></symbol>
<symbol id="i-cloud" viewBox="0 0 24 24"><path class="f" d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 18.5z"/><path class="s" d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 18.5z"/></symbol>
<symbol id="i-mail" viewBox="0 0 24 24"><rect class="f" x="3" y="5.5" width="18" height="13" rx="2.5"/><rect class="s" x="3" y="5.5" width="18" height="13" rx="2.5"/><path class="s" d="M3.5 7l8.5 6.5L20.5 7"/></symbol>
<symbol id="i-globe" viewBox="0 0 24 24"><circle class="f" cx="12" cy="12" r="9"/><circle class="s" cx="12" cy="12" r="9"/><path class="s" d="M3 12h18 M12 3c2.6 2.6 3.8 5.6 3.8 9S14.6 18.4 12 21 M12 3C9.4 5.6 8.2 8.6 8.2 12S9.4 18.4 12 21"/></symbol>
<symbol id="i-layers" viewBox="0 0 24 24"><path class="f" d="M12 3.5l8.5 4.5L12 12.5 3.5 8z"/><path class="s" d="M12 3.5l8.5 4.5L12 12.5 3.5 8z"/><path class="s" d="M3.5 12.2L12 16.7l8.5-4.5 M3.5 16.2L12 20.7l8.5-4.5"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect class="f" x="5" y="10.5" width="14" height="10" rx="2.5"/><rect class="s" x="5" y="10.5" width="14" height="10" rx="2.5"/><path class="s" d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle class="d" cx="12" cy="15.5" r="1.5"/></symbol>
<symbol id="i-power" viewBox="0 0 24 24"><circle class="f" cx="12" cy="13" r="8"/><path class="s" d="M12 3.5v8 M7 6.5a8 8 0 1 0 10 0"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle class="f" cx="10.5" cy="10.5" r="6.5"/><circle class="s" cx="10.5" cy="10.5" r="6.5"/><path class="s" d="M15.5 15.5l5 5"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24"><path class="s" d="M6 6l12 12 M18 6L6 18"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path class="s" d="M12 5v14 M5 12h14"/></symbol>
<symbol id="i-reveal" viewBox="0 0 24 24"><path class="f" d="M4 8a2 2 0 0 1 2-2h4v14H6a2 2 0 0 1-2-2z"/><path class="s" d="M14 4h6v6 M20 4l-9 9 M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></symbol>
<symbol id="i-spark" viewBox="0 0 24 24"><path class="d" d="M12 2.5c.9 5.2 4.3 8.6 9.5 9.5-5.2.9-8.6 4.3-9.5 9.5-.9-5.2-4.3-8.6-9.5-9.5 5.2-.9 8.6-4.3 9.5-9.5z"/></symbol>
<symbol id="i-warning" viewBox="0 0 24 24"><path class="f" d="M10.3 4.5a2 2 0 0 1 3.4 0l7.2 12.6a2 2 0 0 1-1.7 3H4.8a2 2 0 0 1-1.7-3z"/><path class="s" d="M10.3 4.5a2 2 0 0 1 3.4 0l7.2 12.6a2 2 0 0 1-1.7 3H4.8a2 2 0 0 1-1.7-3z"/><path class="s" d="M12 9.5v4"/><circle class="d" cx="12" cy="16.6" r="1.1"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle class="f" cx="12" cy="12" r="8.5"/><circle class="s" cx="12" cy="12" r="8.5"/><path class="s" d="M12 7.5V12l3 2"/></symbol>
`;

/** Mount once at the app root; every <Icon> references these symbols. */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs dangerouslySetInnerHTML={{ __html: SPRITE }} />
    </svg>
  );
}

export function Icon({ name, size, style, className }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  const s: CSSProperties = size ? { width: size, height: size, ...style } : { ...style };
  return (
    <svg className={className ? `ic ${className}` : 'ic'} style={s} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}

/** The four-point "glint" brand mark. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2c1.2 7.4 6.6 12.8 14 14-7.4 1.2-12.8 6.6-14 14-1.2-7.4-6.6-12.8-14-14C9.4 14.8 14.8 9.4 16 2z" fill="url(#g-brand)" />
      <circle cx="25" cy="7" r="2.4" fill="#ffb547" />
    </svg>
  );
}
