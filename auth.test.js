import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AuthError,
  askBff,
  authorizeUrl,
  exchangeCode,
  freshSession,
  revokeRefreshToken,
  sessionFromTokens,
} from './auth.js';

const config = {
  apiBaseUrl: 'https://app.example/',
  auth0Domain: 'tenant.eu.auth0.com',
  auth0ClientId: 'client-1',
  auth0Audience: 'https://api.example',
};

const jwt = (claims) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const recorder = (...replies) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return replies.shift();
  };
  return { calls, fetchImpl };
};

const session = {
  sub: 'github|1',
  connection: 'github',
  accessToken: 'access-old',
  refreshToken: 'refresh-old',
  expiresAt: 1_000_000,
};

describe('authorizeUrl', () => {
  it('asks for the API audience and a refresh token', () => {
    const url = new URL(
      authorizeUrl({
        config,
        redirectUri: 'https://ext.chromiumapp.org/callback',
        challenge: 'c',
        state: 's',
        connection: 'github',
      }),
    );
    assert.equal(url.origin, 'https://tenant.eu.auth0.com');
    assert.equal(url.searchParams.get('audience'), 'https://api.example');
    assert.deepEqual(url.searchParams.get('scope').split(' '), [
      'openid',
      'profile',
      'email',
      'offline_access',
    ]);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('connection'), 'github');
  });
});

describe('sessionFromTokens', () => {
  it('keeps the access token, the refresh token and the expiry in milliseconds', () => {
    const result = sessionFromTokens({
      tokens: {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        id_token: jwt({ sub: 'google-oauth2|9' }),
      },
      connection: 'google-oauth2',
      now: 1_000,
    });
    assert.deepEqual(result, {
      sub: 'google-oauth2|9',
      connection: 'google-oauth2',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 3_601_000,
    });
  });

  it('keeps the old refresh token when none is rotated in', () => {
    const result = sessionFromTokens({
      tokens: { access_token: 'a', expires_in: 60 },
      now: 0,
      previous: session,
    });
    assert.equal(result.refreshToken, 'refresh-old');
    assert.equal(result.sub, 'github|1');
    assert.equal(result.connection, 'github');
  });

  it('refuses a response without an access token', () => {
    assert.throws(
      () => sessionFromTokens({ tokens: { id_token: jwt({ sub: 'x' }) }, now: 0 }),
      { code: 'no_access_token' },
    );
  });
});

describe('exchangeCode', () => {
  it('trades the code and verifier for a session', async () => {
    const { calls, fetchImpl } = recorder(
      reply(200, { access_token: 'a', refresh_token: 'r', expires_in: 60, id_token: jwt({ sub: 's' }) }),
    );
    const result = await exchangeCode({
      config,
      code: 'code-1',
      verifier: 'v',
      redirectUri: 'https://ext/cb',
      connection: 'github',
      fetchImpl,
      now: 0,
    });
    assert.equal(result.accessToken, 'a');
    assert.equal(calls[0].url, 'https://tenant.eu.auth0.com/oauth/token');
    assert.deepEqual(calls[0].body, {
      grant_type: 'authorization_code',
      client_id: 'client-1',
      code_verifier: 'v',
      code: 'code-1',
      redirect_uri: 'https://ext/cb',
    });
  });

  it('reports why Auth0 refused', async () => {
    const { fetchImpl } = recorder(reply(403, { error: 'access_denied', error_description: 'not allowed' }));
    await assert.rejects(
      exchangeCode({ config, code: 'c', verifier: 'v', redirectUri: 'u', connection: 'github', fetchImpl, now: 0 }),
      { message: 'not allowed', code: 'access_denied' },
    );
  });
});

describe('freshSession', () => {
  it('uses the session as is while it has more than a minute left', async () => {
    const { calls, fetchImpl } = recorder();
    const result = await freshSession({ config, session, fetchImpl, now: 900_000 });
    assert.deepEqual(result, { session, refreshed: false });
    assert.equal(calls.length, 0);
  });

  it('refreshes inside the last minute and stores the rotated refresh token', async () => {
    const { calls, fetchImpl } = recorder(
      reply(200, { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }),
    );
    const result = await freshSession({ config, session, fetchImpl, now: 950_000 });
    assert.equal(result.refreshed, true);
    assert.equal(result.session.accessToken, 'access-new');
    assert.equal(result.session.refreshToken, 'refresh-new');
    assert.equal(result.session.sub, 'github|1');
    assert.equal(result.session.expiresAt, 950_000 + 3_600_000);
    assert.deepEqual(calls[0].body, {
      grant_type: 'refresh_token',
      client_id: 'client-1',
      refresh_token: 'refresh-old',
    });
  });

  it('says the session is gone when Auth0 rejects the refresh token', async () => {
    const { fetchImpl } = recorder(reply(403, { error: 'invalid_grant', error_description: 'revoked' }));
    await assert.rejects(freshSession({ config, session, fetchImpl, now: 2_000_000 }), (error) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.code, 'invalid_grant');
      return true;
    });
  });

  it('says the session is gone when it expired and has no refresh token', async () => {
    const { calls, fetchImpl } = recorder();
    await assert.rejects(
      freshSession({ config, session: { ...session, refreshToken: null }, fetchImpl, now: 2_000_000 }),
      { code: 'invalid_grant' },
    );
    assert.equal(calls.length, 0);
  });
});

describe('revokeRefreshToken', () => {
  it('revokes this client refresh token at Auth0', async () => {
    const { calls, fetchImpl } = recorder(reply(200, {}));
    await revokeRefreshToken({ config, session, fetchImpl });
    assert.equal(calls[0].url, 'https://tenant.eu.auth0.com/oauth/revoke');
    assert.deepEqual(calls[0].body, { client_id: 'client-1', token: 'refresh-old' });
  });

  it('does nothing without a refresh token', async () => {
    const { calls, fetchImpl } = recorder();
    await revokeRefreshToken({ config, session: { ...session, refreshToken: null }, fetchImpl });
    await revokeRefreshToken({ config, session: null, fetchImpl });
    assert.equal(calls.length, 0);
  });
});

describe('askBff', () => {
  it('posts the question with the bearer token and no user id', async () => {
    const { calls, fetchImpl } = recorder(reply(200, { id: 'spread-1' }));
    const body = await askBff({ config, session, question: '  Will it rain?  ', consent: true, fetchImpl });
    assert.deepEqual(body, { id: 'spread-1' });
    assert.equal(calls[0].url, 'https://app.example/api/spreads');
    assert.equal(calls[0].init.headers.authorization, 'Bearer access-old');
    assert.deepEqual(calls[0].body, { question: 'Will it rain?', consent: true });
  });

  it('treats a 401 as a lost sign-in', async () => {
    const { fetchImpl } = recorder(reply(401, { error: 'Sign in to ask.' }));
    await assert.rejects(askBff({ config, session, question: 'q', consent: true, fetchImpl }), {
      name: 'AuthError',
      code: 'unauthorized',
      message: 'Sign in to ask.',
    });
  });

  it('passes on the message the BFF wrote for the user', async () => {
    const { fetchImpl } = recorder(reply(400, { error: 'consent required' }));
    await assert.rejects(askBff({ config, session, question: 'q', consent: false, fetchImpl }), {
      message: 'consent required',
    });
  });

  it('falls back to the status when the body is not JSON', async () => {
    const { fetchImpl } = recorder({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    });
    await assert.rejects(askBff({ config, session, question: 'q', consent: true, fetchImpl }), {
      message: 'request failed (502)',
    });
  });
});
