import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Detects touch devices + portrait orientation, and keeps gameplay safe by
 * auto-pausing whenever a portrait rotation happens mid-game. Also exposes
 * `requestLandscape()`, a best-effort call into the native Screen Orientation
 * API (only works in some browsers, typically inside fullscreen) — the
 * <RotateOverlay /> UI is the reliable, universal fallback.
 */
export function useOrientationLock(opts: {
  /** Called to pause gameplay when the device rotates to portrait mid-game. */
  onForcePause: () => void;
  /** Returns true while the game is actively being played (not menu/paused/over). */
  isPlaying: () => boolean;
}) {
  const { onForcePause, isPlaying } = opts;
  const [touch, setTouch] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  );
  const [isPortrait, setIsPortrait] = useState(false);
  const portraitRef = useRef(false);
  const cbRef = useRef({ onForcePause, isPlaying });
  cbRef.current = { onForcePause, isPlaying };

  useEffect(() => {
    const check = () => {
      const t = window.matchMedia('(pointer: coarse)').matches;
      setTouch(t);

      const portrait = t && window.innerHeight > window.innerWidth;
      if (portrait === portraitRef.current) return;
      portraitRef.current = portrait;
      setIsPortrait(portrait);

      if (portrait && cbRef.current.isPlaying()) {
        // Rotated to portrait mid-game: pause immediately so enemies don't
        // keep attacking a player who can no longer see/control the game.
        cbRef.current.onForcePause();
      }
      // Rotated back to landscape — stay paused; the player resumes manually.
    };

    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);

  /** Best-effort native landscape lock; safely no-ops where unsupported. */
  const requestLandscape = useCallback(() => {
    if (!touch) return;
    try {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      orientation?.lock?.('landscape').catch(() => { /* unsupported or not fullscreen — ignore */ });
    } catch { /* screen.orientation unavailable — ignore */ }
  }, [touch]);

  return { touch, isPortrait, requestLandscape };
}
