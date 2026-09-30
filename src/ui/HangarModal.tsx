import { motion } from 'framer-motion';
import { SaveManager, UPGRADE_CONFIG, type HangarUpgrades } from '../game/saveSystem';
import { sound } from '../game/sound';
import { vibrate } from '../game/haptics';

const DESCRIPTIONS: Record<keyof HangarUpgrades, string> = {
  healthLevel: '+10 max Hull per level',
  speedLevel: '+5% ship speed per level',
  bombLevel: '+1 starting Bomb per level',
  creditMultiplier: '+10% credits per level',
};

export function HangarModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const save = SaveManager.get();

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="absolute inset-0 z-40 flex items-center justify-center bg-[#05060f]/75 p-3 backdrop-blur-md sm:p-5 overflow-y-auto"
    >
      <motion.div
        initial={{ scale: 0.92, y: 14 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 8 }}
        transition={{ type: 'spring', stiffness: 300, damping: 24 }}
        className="w-full max-w-3xl rounded-2xl border border-amber-300/30 bg-slate-900/70 p-4 text-center shadow-[0_0_35px_rgba(255,209,102,0.15)] sm:p-6 m-auto"
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-black tracking-[0.2em] text-amber-300 sm:text-xl">
            🛸 HANGAR
          </h2>
          <div className="rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1 text-[11px] font-extrabold tracking-wider text-amber-200">
            💰 {save.credits.toLocaleString()}
          </div>
        </div>
        <p className="mb-3 text-[10px] tracking-wider text-slate-400 sm:text-xs">
          Permanent upgrades — survive longer, earn faster. Applies on next run.
        </p>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3">
          {(Object.keys(UPGRADE_CONFIG) as (keyof HangarUpgrades)[]).map((key) => {
            const cfg = UPGRADE_CONFIG[key];
            const lvl = save.upgrades[key];
            const isMax = lvl >= cfg.max;
            const cost = SaveManager.getUpgradeCost(key);
            const afford = save.credits >= cost;
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-800/60 px-4 py-3"
              >
                <div className="text-left">
                  <div className="text-xs font-extrabold tracking-wider text-slate-100 sm:text-sm">
                    {cfg.name}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {DESCRIPTIONS[key]} · LVL {lvl}/{cfg.max}
                  </div>
                </div>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  disabled={isMax || !afford}
                  onClick={() => {
                    if (SaveManager.buyUpgrade(key)) {
                      sound.play('uiClick');
                      vibrate(25);
                      onChanged();
                    } else {
                      sound.play('uiHover');
                    }
                  }}
                  className="shrink-0 rounded-md bg-amber-300 px-3 py-1.5 text-[10px] font-extrabold tracking-wider text-[#05060f] disabled:opacity-30"
                >
                  {isMax ? 'MAXED' : `${cost} 💰`}
                </motion.button>
              </div>
            );
          })}
        </div>
        <motion.button
          type="button"
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.96 }}
          onClick={() => { sound.play('uiClick'); onClose(); }}
          className="mt-4 rounded-xl border border-white/15 bg-white/10 px-6 py-2 text-xs font-bold tracking-widest text-slate-200 hover:bg-white/20"
        >
          BACK TO ARENA
        </motion.button>
      </motion.div>
    </motion.div>
  );
}
