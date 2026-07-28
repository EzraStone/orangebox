#!/usr/bin/env node
// orangebox — flight recorder for AI agents.
// This file exists only to be the bin shim; all logic lives in src/cli.mjs (§05).
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).catch((err) => {
  console.error(`orangebox: ${err?.message ?? err}`);
  process.exit(1);
});
