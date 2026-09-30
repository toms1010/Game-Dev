import { motion } from 'framer-motion';

/**
 * Slow-drifting blurred glow blobs behind the game frame. Purely decorative,
 * so it's only rendered on non-touch (desktop) layouts to save mobile battery
 * and avoid competing with the fullscreen landscape game frame.
 */
export function AmbientBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden -z-10">
      <motion.div
        className="absolute h-[38vw] w-[38vw] rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(34,211,238,0.18) 0%, transparent 70%)', top: '-10%', left: '-8%' }}
        animate={{ x: [0, 40, 0], y: [0, 30, 0] }}
        transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute h-[32vw] w-[32vw] rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(232,121,249,0.16) 0%, transparent 70%)', bottom: '-12%', right: '-6%' }}
        animate={{ x: [0, -35, 0], y: [0, -25, 0] }}
        transition={{ duration: 17, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute h-[22vw] w-[22vw] rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(74,222,128,0.10) 0%, transparent 70%)', top: '30%', right: '18%' }}
        animate={{ x: [0, 20, 0], y: [0, -20, 0] }}
        transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  );
}
