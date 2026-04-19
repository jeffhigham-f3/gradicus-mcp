#!/usr/bin/env node
// Drive the gradicus MCP server's `daily_report` tool over stdio.
// Single source of truth: the same code any LLM hits via MCP.
//
// Usage:
//   node scripts/run-daily-report.mjs                # sync + deploy
//   node scripts/run-daily-report.mjs --no-sync      # use cached data
//   node scripts/run-daily-report.mjs --no-deploy    # generate only
//   node scripts/run-daily-report.mjs --site <id>    # override site id
//
// Required env (when deploying):
//   NETLIFY_AUTH_TOKEN  Netlify personal access token
// Optional:
//   GRADICUS_EMAIL / GRADICUS_PASSWORD  needed when syncing
//   NETLIFY_SITE_ID                     overrides the default site

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SERVER_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');

const argv = process.argv.slice(2);
const noSync = argv.includes('--no-sync');
const noDeploy = argv.includes('--no-deploy');
const siteIdx = argv.indexOf('--site');
const siteOverride = siteIdx >= 0 ? argv[siteIdx + 1] : undefined;

const args = { sync: !noSync, deploy: !noDeploy };
if (siteOverride) args.site_id = siteOverride;

function callTool(toolName, toolArgs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
    });

    let buf = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error(`Timed out after 5 minutes calling ${toolName}`));
      }
    }, 5 * 60 * 1000);

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          settled = true;
          clearTimeout(timeout);
          proc.kill();
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });

    proc.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timeout); reject(err); }
    });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`MCP server exited with code ${code} before responding`));
      }
    });

    const send = (m) => proc.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'run-daily-report', version: '1.0' },
    }});
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: toolArgs } });
  });
}

async function main() {
  if (!noSync && (!process.env.GRADICUS_EMAIL || !process.env.GRADICUS_PASSWORD)) {
    console.warn('[warn] GRADICUS_EMAIL/GRADICUS_PASSWORD not set; sync will fail. Pass --no-sync to use cached data.');
  }
  if (!noDeploy && !process.env.NETLIFY_AUTH_TOKEN) {
    console.warn('[warn] NETLIFY_AUTH_TOKEN not set; deploy will be skipped by the tool.');
  }

  // Login first (only if we plan to sync). The daily_report tool requires
  // an authenticated session for sync=true.
  if (!noSync) {
    console.log('Logging in to Gradicus...');
    const loginResult = await callTool('login', {});
    const text = loginResult.content?.[0]?.text || '';
    process.stdout.write(text + '\n\n');
    if (loginResult.isError) process.exit(1);
  }

  console.log(`Calling daily_report (${JSON.stringify(args)})...`);
  // Login already synced; ask daily_report to skip the redundant sync.
  const reportArgs = { ...args, sync: false };
  const result = await callTool('daily_report', reportArgs);
  const text = result.content?.[0]?.text || '';
  process.stdout.write(text + '\n');
  if (result.isError) process.exit(1);
}

main().catch((err) => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
