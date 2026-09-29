const DEMO_USER_ID = globalThis.COSMIC_ARCANA?.demoUserId ?? '00000000-0000-4000-8000-000000000001';

const $ = (id) => document.getElementById(id);

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const sha256 = async (plain) => {
  const data = new TextEncoder().encode(plain);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return b64url(new Uint8Array(digest));
};

const randomString = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64url(bytes);
};

const idempotencyKey = () =>
  `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const redirectUri = () => chrome.identity.getRedirectURL('callback');

const loadSession = async () => {
  const { cosmicSession } = await chrome.storage.local.get('cosmicSession');
  return cosmicSession ?? null;
};

const renderSession = async () => {
  const session = await loadSession();
  $('session').textContent = session?.sub
    ? `Signed in as ${session.sub} (${session.connection ?? 'auth0'})`
    : 'Not signed in (demo user for spreads).';
};

const decodeJwtPayload = (token) => {
  const part = token.split('.')[1];
  if (!part) {
    return {};
  }
  const padded = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(padded));
};

const login = async (connection) => {
  const { auth0Domain, auth0ClientId } = globalThis.COSMIC_ARCANA ?? {};
  if (!auth0Domain || !auth0ClientId) {
    throw new Error('copy config.example.js to config.js and set Auth0 domain + SPA client id');
  }

  const verifier = randomString();
  const challenge = await sha256(verifier);
  const state = randomString();
  const url = new URL(`https://${auth0Domain}/authorize`);
  url.searchParams.set('client_id', auth0ClientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('connection', connection);

  const redirected = await chrome.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive: true,
  });
  const redirectedUrl = new URL(redirected);
  const code = redirectedUrl.searchParams.get('code');
  if (!code) {
    throw new Error('no authorization code');
  }

  const tokenResponse = await fetch(`https://${auth0Domain}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: auth0ClientId,
      code_verifier: verifier,
      code,
      redirect_uri: redirectUri(),
    }),
  });
  const tokens = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error(tokens.error_description || 'token exchange failed');
  }

  const claims = decodeJwtPayload(tokens.id_token);
  await chrome.storage.local.set({
    cosmicSession: {
      sub: claims.sub,
      connection,
      idToken: tokens.id_token,
    },
  });
  await renderSession();
};

const createSpread = async (question) => {
  const base = (globalThis.COSMIC_ARCANA?.tarotBaseUrl ?? '').replace(/\/$/, '');
  if (!base) {
    throw new Error('tarotBaseUrl is empty');
  }
  const session = await loadSession();
  const userId = DEMO_USER_ID;
  const response = await fetch(`${base}/spreads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey(),
    },
    body: JSON.stringify({ userId, question: question.trim() }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`tarot ${response.status}`);
  }
  return { body, sessionSub: session?.sub ?? null };
};

$('github').addEventListener('click', async () => {
  $('status').textContent = '';
  try {
    await login('github');
  } catch (error) {
    $('status').textContent = error.message;
  }
});

$('google').addEventListener('click', async () => {
  $('status').textContent = '';
  try {
    await login('google-oauth2');
  } catch (error) {
    $('status').textContent = error.message;
  }
});

$('logout').addEventListener('click', async () => {
  await chrome.storage.local.remove('cosmicSession');
  await renderSession();
});

$('ask').addEventListener('click', async () => {
  $('status').textContent = '';
  $('result').textContent = '';
  try {
    const { body } = await createSpread($('question').value);
    $('result').textContent = JSON.stringify(body, null, 2);
  } catch (error) {
    $('status').textContent = error.message;
  }
});

renderSession();
