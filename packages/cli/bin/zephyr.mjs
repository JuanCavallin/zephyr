#!/usr/bin/env node
// The CLI is TypeScript and @htn/shared ships as source, so load both through tsx.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/main.ts');
process.exitCode = await main(process.argv.slice(2));
