import { useEffect, useRef, useState, type RefObject } from 'react';
import { vibrate } from '../game/haptics';

export type StickState = { x: number; y: number; active: boolean };

type StickMode = 'analog' | '8-way';

export function Stick({ side, state, label, onDouble, floating = true, mode = 'analog', curve = 1 }: {
  side: 'left' | 'right';
  state: RefObject<StickState>;
  label: string;
  onDouble?: () => void;
  floating?: boolean;
  mode?: StickMode;
  /** Non-linear sensitivity exponent (1 = linear). >1 gives finer center control. */
  curve?: number;
}) {
  // ---- config (easy to tune) ----
  const JOYSTICK_RADIUS = 52;
  const DEAD_ZONE = 0.12;
  const KNOB_SIZE = 44;
  const BASE_SIZE = 104;

  // ---- refs (game state, not React state) ----
  const idRef = useRef<number | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const lastTap = useRef(0);
  const lastTapPos = useRef({ x: 0, y: 0 });
  const knobRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const releaseRef = useRef<number | null>(null);
  const atBoundaryRef = useRef(false);

  // ---- visual state only ----
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [on, setOn] = useState(false);
  const [basePos, setBasePos] = useState<{ x: number; y: number } | null>(null);
  const [rippleKey, setRippleKey] = useState(0);

  const accent = side === 'left' ? '#22d3ee' : '#e879f9';

  // RAF-synced visual update (one React render per frame max)
  const scheduleVisual = () => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      setKnob({ x: knobRef.current.x, y: knobRef.current.y });
      rafRef.current = null;
    });
  };

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (releaseRef.current !== null) cancelAnimationFrame(releaseRef.current);
    };
  }, []);

  // spring snap-back: ease the knob home over ~140ms (visual only —
  // game state is already zeroed so input stops instantly)
  const animateRelease = () => {
    if (releaseRef.current !== null) cancelAnimationFrame(releaseRef.current);
    const sx = knobRef.current.x, sy = knobRef.current.y;
    if (Math.hypot(sx, sy) < 1) return;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 140);
      const k = 1 - Math.pow(1 - t, 3); // ease-out cubic
      knobRef.current = { x: sx * (1 - k), y: sy * (1 - k) };
      scheduleVisual();
      if (t < 1) releaseRef.current = requestAnimationFrame(step);
      else releaseRef.current = null;
    };
    releaseRef.current = requestAnimationFrame(step);
  };

  const set = (cx: number, cy: number) => {
    let dx = cx - originRef.current.x;
    let dy = cy - originRef.current.y;
    let d = Math.hypot(dx, dy);

    // 8-way snapping
    if (mode === '8-way' && d > JOYSTICK_RADIUS * DEAD_ZONE) {
      const angle = Math.atan2(dy, dx);
      const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      const clamped = Math.min(d, JOYSTICK_RADIUS);
      dx = Math.cos(snapped) * clamped;
      dy = Math.sin(snapped) * clamped;
      d = clamped;
    }

    // clamp to outer radius (+ edge haptic on first contact)
    if (d > JOYSTICK_RADIUS) {
      dx = (dx / d) * JOYSTICK_RADIUS;
      dy = (dy / d) * JOYSTICK_RADIUS;
      if (!atBoundaryRef.current) {
        atBoundaryRef.current = true;
        vibrate(14);
      }
    } else if (d < JOYSTICK_RADIUS * 0.92) {
      atBoundaryRef.current = false;
    }

    // update ref immediately for game loop (no React render)
    knobRef.current = { x: dx, y: dy };
    scheduleVisual();

    const m = Math.hypot(dx, dy) / JOYSTICK_RADIUS;
    // normalize after dead zone so usable range stays 0..1, then shape it
    const normalized = Math.max(0, (m - DEAD_ZONE) / (1 - DEAD_ZONE));
    const shaped = curve === 1 ? normalized : Math.pow(normalized, curve);
    const n = Math.hypot(dx, dy) || 1;
    state.current.x = (dx / n) * shaped;
    state.current.y = (dy / n) * shaped;
    state.current.active = shaped > 0;
  };

  const reset = () => {
    idRef.current = null;
    setOn(false);
    atBoundaryRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    animateRelease();
    setKnob({ x: knobRef.current.x, y: knobRef.current.y });
    if (floating) setBasePos(null);
    state.current.active = false;
    state.current.x = 0;
    state.current.y = 0;
  };

  const mag = Math.min(1, Math.hypot(knob.x, knob.y) / JOYSTICK_RADIUS);
  const ang = Math.atan2(knob.y, knob.x);

  return (
    <div
      role="application"
      aria-label={label}
      className={`absolute bottom-0 ${side === 'left' ? 'left-0' : 'right-0'} h-[42%] sm:h-[55%] w-[45%] touch-none z-10`}
      style={{ touchAction: 'none' }}
      onPointerDown={(e) => {
        if (idRef.current !== null) return;
        idRef.current = e.pointerId;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        if (releaseRef.current !== null) {
          cancelAnimationFrame(releaseRef.current);
          releaseRef.current = null;
        }

        if (floating) {
          const rect = e.currentTarget.getBoundingClientRect();
          setBasePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
          originRef.current = { x: e.clientX, y: e.clientY };
        } else {
          // fixed: origin is base center (bottom 24 + 52 radius, centered)
          const rect = e.currentTarget.getBoundingClientRect();
          originRef.current = {
            x: rect.left + rect.width / 2,
            y: rect.bottom - 24 - BASE_SIZE / 2,
          };
          // keep base visually fixed
          setBasePos(null);
        }

        setOn(true);
        knobRef.current = { x: 0, y: 0 };
        setKnob({ x: 0, y: 0 });
        setRippleKey((k) => k + 1);
        state.current.active = false;
        state.current.x = 0;
        state.current.y = 0;

        const now = Date.now();
        const dist = Math.hypot(e.clientX - lastTapPos.current.x, e.clientY - lastTapPos.current.y);
        if (onDouble && now - lastTap.current < 280 && dist < 40) onDouble();
        lastTap.current = now;
        lastTapPos.current = { x: e.clientX, y: e.clientY };
        vibrate(6);
      }}
      onPointerMove={(e) => { if (idRef.current === e.pointerId) set(e.clientX, e.clientY); }}
      onPointerUp={(e) => { if (idRef.current === e.pointerId) reset(); }}
      onPointerCancel={(e) => { if (idRef.current === e.pointerId) reset(); }}
    >
      <div
        className="absolute pointer-events-none"
        style={basePos
          ? { left: basePos.x, top: basePos.y, transform: 'translate(-50%, -50%)', opacity: on ? 1 : 0.6, transition: 'opacity 150ms ease' }
          : { bottom: '24px', left: '50%', transform: 'translateX(-50%)', opacity: on ? 1 : 0.6, transition: 'opacity 150ms ease' }}
      >
        {/* press ripple */}
        {rippleKey > 0 && (
          <div
            key={rippleKey}
            className="stick-ripple absolute left-1/2 top-1/2 h-[104px] w-[104px] rounded-full"
            style={{ border: `2px solid ${accent}`, transform: 'translate(-50%, -50%)' }}
            aria-hidden
          />
        )}

        {/* soft outer glow that intensifies with drag magnitude */}
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: 150,
            height: 150,
            background: `radial-gradient(circle, ${accent}${on ? '55' : '22'} 0%, transparent 65%)`,
            filter: `blur(${4 + mag * 6}px)`,
            opacity: 0.35 + mag * 0.6,
          }}
          aria-hidden
        />

        {/* base ring */}
        <div
          className="relative rounded-full border-2"
          style={{
            width: BASE_SIZE,
            height: BASE_SIZE,
            borderColor: on ? accent : `${accent}88`,
            background: on
              ? `radial-gradient(circle, ${accent}22 0%, transparent 70%)`
              : 'transparent',
            boxShadow: on
              ? `0 0 ${18 + mag * 22}px ${accent}aa, inset 0 0 14px ${accent}55`
              : `0 0 8px ${accent}33`,
            transition: 'box-shadow 120ms linear, background 120ms linear',
          }}
        >
          {/* dashed inner ring */}
          <div className="absolute inset-3 rounded-full opacity-40" style={{ border: `1px dashed ${accent}` }} aria-hidden />

          {/* magnitude arc — grows clockwise from top as you push the stick */}
          {on && mag > 0.05 && (
            <svg
              className="absolute inset-0 pointer-events-none"
              viewBox="-52 -52 104 104"
              style={{ transform: 'rotate(-90deg)' }}
              aria-hidden
            >
              <circle
                cx="0" cy="0" r="46"
                fill="none"
                stroke={accent}
                strokeWidth={3}
                strokeLinecap="round"
                strokeDasharray={`${mag * 289} 289`}
                style={{ filter: `drop-shadow(0 0 6px ${accent})` }}
              />
            </svg>
          )}

          {/* direction guide — faint arrow pointing toward drag dir */}
          {on && mag > 0.15 && (
            <div
              className="absolute left-1/2 top-1/2 pointer-events-none"
              style={{
                transform: `translate(-50%, -50%) rotate(${ang}rad)`,
                width: 92,
                height: 92,
              }}
              aria-hidden
            >
              <div
                className="absolute"
                style={{
                  left: '100%', top: '50%',
                  transform: 'translate(-50%, -50%)',
                  color: accent,
                  fontSize: 11,
                  lineHeight: 1,
                  textShadow: `0 0 10px ${accent}`,
                  opacity: 0.4 + mag * 0.6,
                }}
              >▶</div>
            </div>
          )}

          {/* center label */}
          <div className="absolute inset-0 flex items-center justify-center text-[9px] tracking-[0.3em] text-white/45 pointer-events-none" aria-hidden>
            {label}
          </div>

          {/* knob — scales & glows with magnitude */}
          <div
            className="absolute left-1/2 top-1/2 rounded-full"
            style={{
              width: KNOB_SIZE,
              height: KNOB_SIZE,
              transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px)) scale(${1 + mag * 0.18})`,
              background: `radial-gradient(circle at 35% 30%, #ffffffdd 0%, ${accent} 45%, ${accent}88 100%)`,
              boxShadow: on
                ? `0 0 ${14 + mag * 22}px ${accent}, 0 0 ${34 + mag * 30}px ${accent}88, inset 0 2px 6px #ffffff77`
                : `0 0 10px ${accent}66, inset 0 2px 6px #ffffff44`,
              transition: 'box-shadow 80ms linear, transform 60ms linear',
            }}
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
}
