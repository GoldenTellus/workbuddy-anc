import type { DatabaseSync } from 'node:sqlite';
import { tick, type TickOptions, type TickResult } from './tick.ts';

export interface RunOptions extends TickOptions {
  intervalMs?: number;
  onTick?: (r: TickResult) => void;
}

/** 常驻循环：立即跑一次，之后按间隔跑；同一时刻只允许一个 tick 在跑。 */
export async function run(db: DatabaseSync, opts: RunOptions = {}): Promise<never> {
  const interval = Math.max(1000, opts.intervalMs ?? 60_000);
  let busy = false;
  const once = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await tick(db, opts);
      (opts.onTick ?? ((x: TickResult) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...x }))))(r);
    } catch (e) {
      console.error('tick failed: ' + (e as Error).message);
    } finally {
      busy = false;
    }
  };
  await once();
  setInterval(once, interval);
  return new Promise<never>(() => {});
}
