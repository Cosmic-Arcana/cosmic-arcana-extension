const REFRESH_MARGIN_MS = 60_000;

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export const decodeJwtPayload = (token) => {
  const part = token.split('.')[1];
  if (!part) {
    return {};
  }
  return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
};

export const authorizeUrl = ({ config, redirectUri, challenge, state, connection }) => {
  const url = new URL(`https://${config.auth0Domain}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.auth0ClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    audience: config.auth0Audience,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    connection,
  }).toString();
  return url.toString();
};

const postJson = (fetchImpl, url, body) =>
  fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const readTokens = async (response) => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AuthError(body.error_description || 'token request failed', body.error);
  }
  return body;
};

export const sessionFromTokens = ({ tokens, connection, now, previous }) => {
  if (!tokens.access_token) {
    throw new AuthError('no access token', 'no_access_token');
  }
  return {
    sub: tokens.id_token ? decodeJwtPayload(tokens.id_token).sub : previous?.sub,
    connection: connection ?? previous?.connection,
    accessToken: tokens.access_token,
    // Refresh token rotation hands out a new one each time; without it the old one stays the only one.
    refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: now + tokens.expires_in * 1000,
  };
};

export const exchangeCode = async ({ config, code, verifier, redirectUri, connection, fetchImpl, now }) => {
  const response = await postJson(fetchImpl, `https://${config.auth0Domain}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: config.auth0ClientId,
    code_verifier: verifier,
    code,
    redirect_uri: redirectUri,
  });
  return sessionFromTokens({ tokens: await readTokens(response), connection, now });
};

export const freshSession = async ({ config, session, fetchImpl, now }) => {
  if (session.expiresAt - now > REFRESH_MARGIN_MS) {
    return { session, refreshed: false };
  }
  if (!session.refreshToken) {
    throw new AuthError('session expired', 'invalid_grant');
  }
  const response = await postJson(fetchImpl, `https://${config.auth0Domain}/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: config.auth0ClientId,
    refresh_token: session.refreshToken,
  });
  const tokens = await readTokens(response);
  return { session: sessionFromTokens({ tokens, now, previous: session }), refreshed: true };
};

export const revokeRefreshToken = async ({ config, session, fetchImpl }) => {
  if (!session?.refreshToken) {
    return;
  }
  await postJson(fetchImpl, `https://${config.auth0Domain}/oauth/revoke`, {
    client_id: config.auth0ClientId,
    token: session.refreshToken,
  });
};

export const askBff = async ({ config, session, question, consent, fetchImpl }) => {
  const response = await fetchImpl(`${config.apiBaseUrl.replace(/\/$/, '')}/api/spreads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({ question: question.trim(), consent }),
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    throw new AuthError(body?.error ?? 'sign in required', 'unauthorized');
  }
  if (!response.ok) {
    throw new Error(body?.error ?? `request failed (${response.status})`);
  }
  return body;
};
