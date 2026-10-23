#!/usr/bin/env node
import { main } from '../src/cli.mjs';

// Si quien lee la salida la corta (`claude-guard doctor | head`), se sale sin ruido.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  throw error;
});

process.exitCode = await main(process.argv.slice(2));
