# Cosmic Arcana browser extension

Manifest V3 popup. Readings are **fiction**. GitHub and Google sign-in go through **Auth0 PKCE** (no client secret in the extension). The popup holds an Auth0 **access token** for the Cosmic Arcana API and sends asks to the **BFF** (`POST {apiBaseUrl}/api/spreads` with `Authorization: Bearer`). It never calls `tarot-service-api` directly, and the BFF decides who the user is from the verified token.

Tokens live in `chrome.storage.local`. The access token is refreshed with the refresh token when it has under a minute left. Sign-out revokes this client's refresh token at Auth0 and clears the session; it does not end other clients' sessions.

## Load unpacked

1. `cp config.example.js config.js` and set `apiBaseUrl` (the storefront), `auth0Domain`, `auth0ClientId` (Auth0 **SPA** app) and `auth0Audience` (the identifier of the Auth0 API, same value as the storefront's `AUTH0_AUDIENCE`).
2. Auth0, the SPA app: enable **Refresh Token Rotation**. Add the extension callback `https://<extension-id>.chromiumapp.org/callback` to the allowed callback URLs after you load the extension once and copy its id. Enable the GitHub and Google social connections for it.
3. Auth0, the API: turn on **Allow Offline Access**, and let this app request it (user access policy).
4. Chrome → Extensions → Developer mode → Load unpacked → this folder.

A non-local `apiBaseUrl` must also be added to `host_permissions` in `manifest.json`; only `localhost` and `127.0.0.1` are listed.

The agent cannot create GitHub, Google, or Auth0 client secrets.

## Tests

`npm test` runs the session logic in `auth.js` (authorize URL, token exchange, refresh, revoke, ask) with a fake `fetch`. The popup itself is not tested.

No invented card meanings.
