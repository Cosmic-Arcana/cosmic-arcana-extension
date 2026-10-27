import { AuthError, askBff, authorizeUrl, exchangeCode, freshSession } from './auth.js';

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

const redirectUri = () => chrome.identity.getRedirectURL('callback');

const loadSession = async () => {
  const { cosmicSession } = await chrome.storage.local.get('cosmicSession');
  return cosmicSession ?? null;
};

const saveSession = (session) => chrome.storage.local.set({ cosmicSession: session });

const clearSession = () => chrome.storage.local.remove('cosmicSession');

const renderSession = async () => {
  const session = await loadSession();
  $('session').textContent = session?.sub
    ? `Signed in as ${session.sub} (${session.connection ?? 'auth0'})`
    : 'Not signed in.';
};

const login = async (connection) => {
  const config = globalThis.COSMIC_ARCANA ?? {};
  if (!config.auth0Domain || !config.auth0ClientId || !config.auth0Audience) {
    throw new Error(
      'copy config.example.js to config.js and set Auth0 domain, SPA client id and API audience',
    );
  }

  const verifier = randomString();
  const challenge = await sha256(verifier);
  const state = randomString();

  const redirected = await chrome.identity.launchWebAuthFlow({
    url: authorizeUrl({ config, redirectUri: redirectUri(), challenge, state, connection }),
    interactive: true,
  });
  const code = new URL(redirected).searchParams.get('code');
  if (!code) {
    throw new Error('no authorization code');
  }

  const session = await exchangeCode({
    config,
    code,
    verifier,
    redirectUri: redirectUri(),
    connection,
    fetchImpl: fetch,
    now: Date.now(),
  });
  await saveSession(session);
  await renderSession();
};

const ask = async (question) => {
  const config = globalThis.COSMIC_ARCANA ?? {};
  if (!config.apiBaseUrl) {
    throw new Error('apiBaseUrl is empty');
  }
  const stored = await loadSession();
  if (!stored) {
    throw new Error('Sign in to ask.');
  }
  const consent = $('consent').checked;
  if (!consent) {
    throw new Error('Tick the consent box to ask.');
  }

  try {
    const { session, refreshed } = await freshSession({
      config,
      session: stored,
      fetchImpl: fetch,
      now: Date.now(),
    });
    if (refreshed) {
      await saveSession(session);
    }
    return await askBff({ config, session, question, consent, fetchImpl: fetch });
  } catch (error) {
    if (error instanceof AuthError && ['invalid_grant', 'unauthorized'].includes(error.code)) {
      await clearSession();
      await renderSession();
      throw new Error('Signed out. Sign in again.');
    }
    throw error;
  }
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
    const body = await ask($('question').value);
    $('result').textContent = JSON.stringify(body, null, 2);
  } catch (error) {
    $('status').textContent = error.message;
  }
});

renderSession();
