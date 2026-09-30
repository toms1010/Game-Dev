import { AnimatePresence, motion } from 'framer-motion';

/**
 * Full-screen blocking overlay shown whenever a touch device is held in
 * portrait orientation. Sits above everything (HUD, canvas, menus) so the
 * player can't interact with the game until they rotate.
 */
export function RotateOverlay({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-[#05060f]/97 backdrop-blur-sm px-6 text-center"
        >
          <motion.div
            animate={{ rotate: [0, 0, -90, -90, 0, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut', times: [0, 0.15, 0.5, 0.65, 0.9, 1] }}
            className="text-6xl"
          >
            📱
          </motion.div>
          <h2 className="text-xl font-black tracking-wide bg-linear-to-r from-cyan-200 to-fuchsia-300 bg-clip-text text-transparent">
            ROTATE YOUR DEVICE
          </h2>
          <p className="text-slate-400 text-xs max-w-xs">
            Neon Vanguard is played in landscape. Turn your phone sideways to continue.
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
