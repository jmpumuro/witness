#!/usr/bin/env node
// Starts the three demo apps (TEST_MODE on) for trying Witness by hand. Ctrl+C to stop.
import { startApps, APPS } from './lib.mjs';

const stop = await startApps();
for (const [name, a] of Object.entries(APPS)) console.log(`${name.padEnd(8)} http://localhost:${a.port}`);
console.log('\nDemo logins are in examples/<app>/e2e/.env.example. Ctrl+C to stop.');
process.on('SIGINT', () => { stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
