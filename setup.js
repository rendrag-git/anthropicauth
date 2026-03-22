#!/usr/bin/env node

// Generate a 1-year Anthropic OAuth setup token WITH a refresh token.
// Same PKCE flow as `claude setup-token`, but returns the refresh token
// so OpenClaw can auto-refresh via type: "oauth" credentials.
//
// Usage: node setup-token-with-refresh.js

const crypto = require('node:crypto');
const https = require('node:https');
const readline = require('node:readline');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const EXPIRES_IN = 31536000; // 1 year in seconds

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

function exchangeCodeForToken(authCode, codeVerifier, state) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'authorization_code',
      code: authCode,
      code_verifier: codeVerifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state,
      expires_in: EXPIRES_IN,
    });

    const url = new URL(TOKEN_URL);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.access_token) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error_description || parsed.error || `Token exchange failed (${res.statusCode}): ${data.slice(0, 400)}`));
          }
        } catch {
          reject(new Error(`Invalid token response (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('Timed out')); }, 30000);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('\n=== Anthropic Setup Token (1-year + refresh) ===\n');

  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(32).toString('base64url');

  const url = `${AUTHORIZE_URL}?code=true`
    + `&client_id=${CLIENT_ID}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&scope=${encodeURIComponent('user:inference')}`
    + `&code_challenge=${codeChallenge}`
    + `&code_challenge_method=S256`
    + `&state=${state}`;

  console.log('1. Open this URL in your browser:\n');
  console.log(url);
  console.log('\n2. Authorize the app, then copy the CODE#STATE from the callback page.\n');

  const codeState = await ask('Paste CODE#STATE here: ');
  const trimmed = codeState.trim();

  const hashIndex = trimmed.indexOf('#');
  if (hashIndex === -1) {
    console.error('Invalid format — expected CODE#STATE (with a # separator)');
    process.exit(1);
  }

  const authCode = trimmed.substring(0, hashIndex);
  const returnedState = trimmed.substring(hashIndex + 1);

  if (returnedState !== state) {
    console.error(`State mismatch!\n  Expected: ${state}\n  Got:      ${returnedState}`);
    process.exit(1);
  }

  console.log('\nExchanging code for 1-year token...');

  try {
    const r = await exchangeCodeForToken(authCode, codeVerifier, returnedState);
    const expiresAt = Date.now() + r.expires_in * 1000;

    console.log('\nSuccess!\n');
    console.log('Access Token: ', r.access_token);
    console.log('Refresh Token:', r.refresh_token);
    console.log('Expires In:   ', r.expires_in, `seconds (~${Math.round(r.expires_in / 86400)} days)`);
    console.log('Account:      ', r.account?.email_address ?? 'unknown');
    console.log('Organization: ', r.organization?.name ?? 'unknown');

    console.log('\n--- OpenClaw auth-profiles.json credential ---\n');
    console.log(JSON.stringify({
      type: 'oauth',
      provider: 'anthropic',
      access: r.access_token,
      refresh: r.refresh_token,
      expires: expiresAt,
      email: r.account?.email_address,
      accountId: r.account?.uuid,
    }, null, 2));

    console.log('\n--- For oauth-tokens.json ---\n');
    console.log(JSON.stringify({
      refreshToken: r.refresh_token,
      accessToken: r.access_token,
      expiresAt,
      label: r.account?.email_address ?? 'max-account',
    }, null, 2));

  } catch (err) {
    console.error('\nToken exchange failed:', err.message);
    process.exit(1);
  }

  rl.close();
}

main();
