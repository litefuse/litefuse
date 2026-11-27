# Enterprise SSO logout

Each enterprise can configure its own browser logout endpoint in
`SsoConfig.authConfig.logout`. The configuration uses a URL and query parameter
mapping. There are no provider-specific logout handlers. An omitted `logout`
keeps sign-out local to Litefuse. Logout configuration does not change the
enterprise's sign-in flow.

The instance-wide `custom` login button accepts the same logout object in the
Web environment variable `AUTH_CUSTOM_LOGOUT_CONFIG`. Supply the JSON object
directly, with `url` and optional `params` at the top level. The external
Compose example includes a GLO mapping. It uses `AUTH_CUSTOM_CLIENT_ID` and
returns to the deployment's sign-in page. An empty setting keeps logout local.

For sessions established after the upgrade, the acceptance criterion is: after a
user explicitly clicks **Sign out**, their next **Enterprise SSO** login must
require fresh authentication at the configured IdP.
Reaching the logout endpoint alone is not sufficient evidence. This flow does
not force reauthentication on login, page refresh, or session expiry. Pre-upgrade
sessions migrate naturally through the two logout cycles described below.

## Standard OIDC

Include the following in `authConfig` when creating the enterprise configuration
with `POST /api/auth/add-sso-config`:

```json
{
  "logout": {
    "url": "https://identity.example.com/oidc/logout"
  }
}
```

Obtain the correct browser logout URL from the IdP administrator or its discovery
metadata. Do not use a token revocation endpoint. Without `params`, Litefuse sends
the standard [OIDC RP-Initiated Logout](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
parameters `client_id`, `post_logout_redirect_uri`, and `id_token_hint` (when the
current login supplied an ID token). Providers may request confirmation when an
ID token hint is absent. If the endpoint requires a hint, set
`"requireIdToken": true`. The default is `false`: a missing or oversized hint is
omitted, and Litefuse still attempts IdP logout with the other parameters. With
`requireIdToken: true`, preparation instead fails visibly when a usable hint is
unavailable; local logout still completes. Custom maps with this setting must
include an `idToken` source.

## Custom parameter names

An explicit `params` map replaces the default OIDC parameters. Strings are literal
values; `{ "source": "..." }` reads a value from the current login or deployment:

| Source                  | Value                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `clientId`              | This enterprise's configured application ID                                         |
| `postLogoutRedirectUri` | Litefuse's configured public origin plus its base path and `/auth/sign-in`          |
| `idToken`               | The ID token received by this browser's current SSO login; omitted when unavailable |

For example, an IdP requiring `clientId`, `redirectToLogin=true`, and `redirectToUrl`
can use this configuration:

```json
{
  "logout": {
    "url": "https://identity.example.com/idp/authCenter/GLO",
    "params": {
      "clientId": { "source": "clientId" },
      "redirectToLogin": "true",
      "redirectToUrl": { "source": "postLogoutRedirectUri" }
    }
  }
}
```

Values are URL-encoded once; do not pre-encode the return address. Use an empty
`params` object if the endpoint needs no dynamic parameters. Endpoint query
parameters are preserved unless overridden by the map. Only the three sources
above are supported; client secrets and access/refresh tokens are not available
as parameter sources. URLs must use HTTPS, except HTTP on loopback hosts for local
testing, and cannot contain credentials or fragments.

## Update an existing enterprise

Send `PATCH /api/auth/sso-logout-config` with
`Authorization: Bearer <ADMIN_API_KEY>` and a JSON body:

```json
{
  "domain": "example.com",
  "logout": {
    "url": "https://identity.example.com/idp/authCenter/GLO",
    "params": {
      "clientId": { "source": "clientId" },
      "redirectToLogin": "true",
      "redirectToUrl": { "source": "postLogoutRedirectUri" }
    }
  }
}
```

Set `logout` to `null` to disable IdP logout. This endpoint preserves existing
login settings and the encrypted client secret. A concurrent configuration edit
returns HTTP 409; reload/retry rather than overwriting it. The logout flow reads
the latest configuration on each request, including across web replicas.

Register the resulting return URL with the IdP if its policy requires an allowlist.
It is derived from `NEXTAUTH_URL` and `NEXT_PUBLIC_BASE_PATH`, never a request's
Host header or a user-supplied redirect URL. For a deployment at
`https://litefuse.example.com/observability`, register
`https://litefuse.example.com/observability/auth/sign-in`.

## Session behavior and rollout

The encrypted session JWT records the actual login provider without another
provider-cache lookup. It stores the current login's ID token only when the
logout parameter mapping uses `idToken` (including the standard OIDC defaults).
Mappings such as the GLO example above do not store an ID token. A token hint is
bound to the provider, client ID, and issuer/tenant settings from the login;
changed settings prevent forwarding that hint to a different IdP or client.

When adding a hint would make the JWT payload exceed 2,500 UTF-8 bytes, Litefuse
omits it to leave space for encryption overhead in a single session cookie.
The default logout attempt continues without the hint. This bound limits the
extra session-cookie cost, not the total size of every Cookie header: existing
session claims, other cookies, and the proxy's header limits still matter.
Endpoints configured with `requireIdToken: true` report a preparation failure
when the hint is unavailable. For deployments that require larger hints,
server-side token storage is a separate extension.

When a required hint is unavailable, the server log records a fixed reason:
`id_token_too_large` when it was omitted for size, `id_token_missing` when the
current login has no retained hint, or `id_token_binding_mismatch` when the
session's IdP/client binding does not match the current configuration. These
diagnostics do not include token contents or binding values.

The public Session response does not expose the hint, but the logout preparation
endpoint can return it in a URL to same-origin JavaScript. This is not protection
against XSS. Linked accounts' stored tokens are not used, since they may belong
to a different browser session.

The upgrade does not invalidate existing browser sessions, rotate the auth
secret, or force an IdP authentication. Password sessions also remain valid.
Pre-upgrade sessions lack the new `ssoProviderId` field, so their first logout
clears only the local session. Session refreshes and client-triggered updates do
not infer or fill in SSO identity; only a successful new login records it.

After all web replicas have the new code and the enterprise logout configuration
is ready, users with old sessions can migrate in the same browser tab:

1. Click **Sign out**. This first logout clears the old Litefuse session only.
2. Click **Enterprise SSO** and complete login. The IdP may silently reuse its
   existing session; this still executes the OAuth callback and creates a new
   Litefuse JWT containing the actual provider and IdP/client binding. The ID
   token is stored only when the configured mapping needs it and it fits.
3. Click **Sign out** again. This logout uses the new JWT to visit the configured
   IdP logout endpoint. Complete any IdP confirmation.
4. Click **Enterprise SSO** again and verify that the IdP requires fresh
   authentication before returning to Litefuse.

These are two logout cycles with a successful login in between, not two clicks
on the logout control. The accepted rollout limitation is that the first
post-upgrade logout/login cycle for an old session may remain silent. Users who
already logged in after the upgrade need only one logout cycle. An ordinary
session expiry followed by login also records the new fields, without forcing
IdP logout.

An enterprise configuration without custom credentials (falling back to global
social login) retains local-only logout. Logout settings are read fresh, while
login provider snapshots
use the existing cache (up to one hour); enabling hints for a newly configured
provider requires a fresh login using the updated snapshot.

The Sign out menu first requests the IdP URL while the local session is available,
then completes NextAuth's CSRF-protected local logout, then navigates the browser
to the IdP. While this runs, session retries pause and the authentication guard
cannot navigate away from the pending logout. A rejected local logout (including
CSRF rejection) shows an error and allows the user to retry the whole flow. If preparation fails, Litefuse
still signs out locally and displays a
message that the IdP session may remain active. The browser must reach the IdP and
complete any required confirmation; Litefuse cannot verify that remote logout
completed. Automatic session cleanup and account deletion remain local operations.
Invalid stored logout settings do not remove the enterprise's login provider or
block sign-in; they fail logout preparation. Create/update APIs validate logout
settings.

For each customer's IdP and supported browser, verify: log in, explicitly click
Sign out, complete any IdP confirmation, then click Enterprise SSO and confirm
that fresh authentication is required instead of silent login. Also verify that
session expiry without an explicit logout does not start IdP logout. Seed a
pre-upgrade Litefuse session and an active IdP session, and verify the four-step
migration above: the old session stays valid, the first new login records SSO
identity, and login after the second logout requires fresh authentication. Also
verify that existing password sessions remain valid and password logout stays
local. Test a slow
IdP response and preparation failures so the return page and error survive local
session updates. A global IdP logout can also sign the user out of other connected
applications, depending on that IdP's behavior.

This implements application-initiated browser logout. Receiving IdP-initiated
front-channel/back-channel logout notifications, invalidating sessions on other
devices, and revoking API tokens are separate capabilities.
