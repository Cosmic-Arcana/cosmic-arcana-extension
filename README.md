# Cosmic Arcana browser extension

Manifest V3 popup. Readings are **fiction**. GitHub and Google sign-in go through **Auth0 PKCE** (no client secret in the extension). Spreads still use the demo `userId` until authority-service-api maps `sub` → UUID (gaps Q14).

## Load unpacked

1. `cp config.example.js config.js` and set `tarotBaseUrl`, `auth0Domain`, `auth0ClientId` (Auth0 **SPA** app).
2. Auth0: enable GitHub and Google social connections. Create those OAuth apps in GitHub/Google with callback `https://<tenant>.auth0.com/login/callback`. Add the extension callback `https://<extension-id>.chromiumapp.org/callback` to the Auth0 SPA allowed callback URLs after you load the extension once and copy its id.
3. Chrome → Extensions → Developer mode → Load unpacked → this folder.

The agent cannot create GitHub, Google, or Auth0 client secrets.

Ask still posts `POST /spreads` stub fields only. No invented card meanings.
