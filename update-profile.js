#!/usr/bin/env node

// Update or create an Anthropic OAuth auth profile in OpenClaw's main store.
// The main store (~/.openclaw/agents/main/agent/auth-profiles.json) is merged
// into all agents at runtime — no need to update each agent individually.
//
// Usage:
//   # OAuth credential (with auto-refresh):
//   node update-openclaw-auth-profile.js --profile-id anthropic:claude \
//     --access "sk-ant-oat01-..." --refresh "sk-ant-ort01-..." \
//     --expires-in 365d --email "user@example.com"
//
//   # From JSON blob (e.g. piped from setup-token-with-refresh.js):
//   node update-openclaw-auth-profile.js --profile-id anthropic:claude \
//     --from-json '{"type":"oauth","access":"...","refresh":"...","expires":...}'
//
//   # Plain token (no refresh):
//   node update-openclaw-auth-profile.js --profile-id anthropic:claude \
//     --token "sk-ant-oat01-..." --expires-in 365d
//
// Options:
//   --profile-id    Auth profile ID (e.g. anthropic:claude, anthropic:manual)
//   --access        OAuth access token
//   --refresh       OAuth refresh token
//   --expires-in    Token lifetime (seconds, or duration: 365d, 8h, 30m)
//   --email         Account email (optional)
//   --account-id    Account UUID (optional)
//   --token         Plain token (creates type: "token" instead of "oauth")
//   --from-json     JSON string with credential fields
//   --dry-run       Show what would change without writing
//   --add-to-order  Add profile to anthropic fallback order if missing
//   --set-last-good Set this profile as lastGood for anthropic
//   --priority      Position in order: "first" (default) or "last"

const fs = require('node:fs');
const path = require('node:path');

const MAIN_AUTH_PATH = path.join(
  process.env.HOME, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json'
);

function parseDuration(s) {
  if (!s) return undefined;
  const n = parseFloat(s);
  if (!isNaN(n) && String(n) === s.trim()) return n * 1000; // bare number = seconds → ms
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!match) { console.error(`Invalid duration: ${s}`); process.exit(1); }
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return val * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg === '--add-to-order') { args.addToOrder = true; continue; }
    if (arg === '--set-last-good') { args.setLastGood = true; continue; }
    if (arg.startsWith('--') && i + 1 < argv.length) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[++i];
    }
  }
  return args;
}

function buildCredential(args) {
  if (args.fromJson) {
    const parsed = JSON.parse(args.fromJson);
    if (parsed.type) return parsed;
    if (parsed.refresh) {
      return {
        type: 'oauth', provider: 'anthropic',
        access: parsed.access, refresh: parsed.refresh,
        expires: parsed.expires ?? parsed.expiresAt ?? (Date.now() + 28800000),
        ...(parsed.email ? { email: parsed.email } : {}),
        ...(parsed.accountId ? { accountId: parsed.accountId } : {}),
      };
    }
    return { type: 'token', provider: 'anthropic', token: parsed.access || parsed.token };
  }

  if (args.token) {
    const cred = { type: 'token', provider: 'anthropic', token: args.token };
    if (args.expiresIn) cred.expires = Date.now() + parseDuration(args.expiresIn);
    return cred;
  }

  if (!args.access) { console.error('Need --access, --token, or --from-json'); process.exit(1); }
  const cred = {
    type: 'oauth', provider: 'anthropic',
    access: args.access,
    refresh: args.refresh ?? null,
    expires: args.expiresIn ? Date.now() + parseDuration(args.expiresIn) : Date.now() + 28800000,
  };
  if (args.email) cred.email = args.email;
  if (args.accountId) cred.accountId = args.accountId;
  return cred;
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.profileId) {
    console.error('Usage: node update-openclaw-auth-profile.js --profile-id <id> [options]');
    console.error('');
    console.error('OAuth:  --access <token> --refresh <token> [--expires-in 365d] [--email <email>]');
    console.error('Token:  --token <token> [--expires-in 365d]');
    console.error('JSON:   --from-json \'{"type":"oauth","access":"...","refresh":"...","expires":...}\'');
    console.error('');
    console.error('Flags:  --dry-run  --add-to-order  --set-last-good  --priority first|last');
    process.exit(1);
  }

  const credential = buildCredential(args);
  const profileId = args.profileId;
  const priority = args.priority ?? 'first';

  // Display
  console.log(`\nProfile:    ${profileId}`);
  console.log(`Type:       ${credential.type}`);
  if (credential.type === 'oauth') {
    console.log(`Access:     ${credential.access?.slice(0, 30)}...`);
    console.log(`Refresh:    ${credential.refresh ? credential.refresh.slice(0, 30) + '...' : 'none'}`);
    console.log(`Expires:    ${new Date(credential.expires).toISOString()} (~${Math.round((credential.expires - Date.now()) / 86400000)}d)`);
  } else {
    console.log(`Token:      ${credential.token?.slice(0, 30)}...`);
    if (credential.expires) console.log(`Expires:    ${new Date(credential.expires).toISOString()}`);
  }
  if (credential.email) console.log(`Email:      ${credential.email}`);
  console.log(`Store:      ${MAIN_AUTH_PATH}`);
  console.log('');

  // Load main store
  let data;
  try {
    data = JSON.parse(fs.readFileSync(MAIN_AUTH_PATH, 'utf8'));
  } catch (err) {
    console.error(`Cannot read ${MAIN_AUTH_PATH}: ${err.message}`);
    process.exit(1);
  }

  const isNew = !data.profiles[profileId];
  data.profiles[profileId] = credential;

  // Add to order
  if (args.addToOrder) {
    if (!data.order) data.order = {};
    if (!data.order.anthropic) data.order.anthropic = [];
    if (!data.order.anthropic.includes(profileId)) {
      if (priority === 'first') data.order.anthropic.unshift(profileId);
      else data.order.anthropic.push(profileId);
    }
  }

  // Set lastGood
  if (args.setLastGood) {
    if (!data.lastGood) data.lastGood = {};
    data.lastGood.anthropic = profileId;
  }

  // Clear usage errors
  if (data.usageStats?.[profileId]) {
    data.usageStats[profileId] = { lastUsed: Date.now(), errorCount: 0 };
  }

  if (args.dryRun) {
    console.log('DRY RUN — would write:\n');
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Atomic write
  const tmpFile = MAIN_AUTH_PATH + '.tmp.' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpFile, MAIN_AUTH_PATH);
  console.log(`${isNew ? 'Created' : 'Updated'} profile "${profileId}" in main auth store.`);
  console.log('This propagates to all agents at runtime via store merge.\n');

  // Sync to secrets.json and .env
  const envVarMap = {
    'anthropic:claude': 'ANTHROPIC_CLAUDE_TOKEN',
    'anthropic:manual': 'ANTHROPIC_MANUAL_TOKEN',
  };
  const envVar = envVarMap[profileId];
  const tokenValue = credential.type === 'oauth' ? credential.access : credential.token;

  if (envVar && tokenValue) {
    const secretsPath = path.join(process.env.HOME, '.openclaw', 'secrets.json');
    try {
      const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      secrets[envVar] = tokenValue;
      const tmp = secretsPath + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, secretsPath);
      console.log(`Synced ${envVar} → secrets.json`);
    } catch (err) {
      console.error(`Failed to update secrets.json: ${err.message}`);
    }

    const envPath = path.join(process.env.HOME, '.openclaw', '.env');
    try {
      let content = fs.readFileSync(envPath, 'utf8');
      const re = new RegExp(`^${envVar}=.*$`, 'm');
      content = re.test(content)
        ? content.replace(re, `${envVar}=${tokenValue}`)
        : content.trimEnd() + `\n${envVar}=${tokenValue}\n`;
      fs.writeFileSync(envPath, content, { mode: 0o600 });
      console.log(`Synced ${envVar} → .env`);
    } catch (err) {
      console.error(`Failed to update .env: ${err.message}`);
    }
  }

  // Also update oauth-tokens.json if we have a refresh token
  if (credential.type === 'oauth' && credential.refresh && envVar) {
    const oauthPath = path.join(process.env.HOME, '.openclaw', 'oauth-tokens.json');
    try {
      let oauthData = {};
      try { oauthData = JSON.parse(fs.readFileSync(oauthPath, 'utf8')); } catch {}
      if (!oauthData.tokens) oauthData.tokens = {};
      oauthData.tokens[envVar] = {
        refreshToken: credential.refresh,
        accessToken: credential.access,
        expiresAt: credential.expires,
        label: credential.email ?? profileId,
      };
      const tmp = oauthPath + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(oauthData, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, oauthPath);
      console.log(`Synced refresh token → oauth-tokens.json`);
    } catch (err) {
      console.error(`Failed to update oauth-tokens.json: ${err.message}`);
    }
  }
}

main();
