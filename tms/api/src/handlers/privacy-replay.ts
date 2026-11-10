/**
 * Not a route: restore.sh runs this in a one-off app container, before the app starts on the
 * restored data, with the erasures listed on stdin (lib/privacy.ts, parseErasureList).
 *
 *   node --import tsx src/handlers/privacy-replay.ts < erasures.txt
 */
import { parseErasureList, replayErasures } from '../lib/privacy';

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const list = parseErasureList(Buffer.concat(chunks).toString('utf8'));
  const replayed = await replayErasures(list);
  console.log(`Erasures listed: ${list.length}. Done again on the restored data: ${replayed}.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('Replaying erasures failed:', error);
    process.exit(1);
  },
);
