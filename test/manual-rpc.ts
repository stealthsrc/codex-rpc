import 'dotenv/config';
import { RpcClient } from '../src/rpc/client';
import { buildPresence } from '../src/rpc/presence-builder';
import { initLogger } from '../src/utils/logger';
import type { DetectionResult, PresenceState } from '../src/detector/state';

const CYCLE: PresenceState[] = ['idle', 'cli', 'app', 'both'];
const CYCLE_INTERVAL_MS = 15_000;

function forced(state: PresenceState): DetectionResult {
  return {
    state,
    startedAt: state === 'idle' ? null : new Date(),
    processCounts: {
      cli: state === 'cli' || state === 'both' ? 1 : 0,
      app: state === 'app' || state === 'both' ? 1 : 0,
      unknown: 0,
    },
    codex: null,
    session: null,
    usage: null,
  };
}

async function main(): Promise<void> {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) throw new Error('DISCORD_CLIENT_ID is required');
  initLogger({ level: process.env.LOG_LEVEL ?? 'debug', logFile: null });

  const rpc = new RpcClient({ clientId });
  await rpc.connect();

  let i = 0;
  const tick = (): void => {
    const state = CYCLE[i++ % CYCLE.length];
    const payload = buildPresence(forced(state));
    if (payload) rpc.setActivity(payload);
    else rpc.clearActivity();
    // eslint-disable-next-line no-console
    console.log(`[manual-rpc] cycled to state=${state}`);
  };
  tick();
  const interval = setInterval(tick, CYCLE_INTERVAL_MS);

  const shutdown = async (): Promise<void> => {
    clearInterval(interval);
    await rpc.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
