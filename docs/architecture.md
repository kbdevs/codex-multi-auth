# codex-multi-auth Architecture

Public overview of how the `codex-multi-auth` multi-account OAuth manager fits around the official Codex CLI, optional forwarding wrapper, local storage, runtime Responses rotation proxy, app bind, and plugin-host path.

---

## The Short Version

`codex-multi-auth` is a Codex CLI multi-account OAuth manager plus an optional forwarding wrapper for the official `@openai/codex` CLI.

- `codex-multi-auth ...` commands are handled locally by the account manager.
- `codex-multi-auth-codex ...` is the optional wrapper entrypoint for forwarding official Codex CLI commands.
- The package does not publish a global `codex` binary; that name stays owned by the official Codex install path.
- Account, settings, quota, backup, and diagnostic state lives under `~/.codex/multi-auth`.
- Wrapper-launched request sessions use native selected-account Codex homes by default.
- When runtime rotation is explicitly enabled, forwarded Codex CLI/app sessions can send Responses traffic through a localhost-only proxy that selects managed accounts per request.
- The plugin-host entrypoint remains available for advanced host integrations, but it is not required for normal CLI use.

---

## Main Components

### 1. Installed CLI surfaces

`package.json` publishes these bins:

- `codex-multi-auth` -> `scripts/codex-multi-auth.js`
- `codex-multi-auth-codex` -> `scripts/codex.js`
- `codex-multi-auth-app-launcher` -> `scripts/codex-app-launcher.js`

The standalone entrypoint normalizes bare account-manager commands, so both `codex-multi-auth status` and `codex-multi-auth auth status` reach the same local manager. The forwarding wrapper handles `auth ...` locally, forwards every other command to the official Codex CLI, and adds runtime-rotation provider settings before forwarding when rotation is enabled.

The wrapper also keeps forwarded official Codex sessions on file-backed auth state unless the caller explicitly opts out.

### 2. Local account manager

`lib/codex-manager.ts` and `lib/codex-manager/commands/` provide the account dashboard and commands:

- `login`
- `list`
- `status`
- `switch`
- `check`
- `forecast`
- `best`
- `report`
- `fix`
- `doctor`
- `rotation`

### 3. Local storage and sync

Account and settings data live under `~/.codex/multi-auth`, with optional project-scoped pools under `projects/<project-key>/`.

The account manager can sync the selected account into official Codex CLI auth-file shapes. Wrapper-launched commands use persistent per-account native homes under `~/.codex/multi-auth/native-homes/` by default, so they keep Codex on its normal ChatGPT auth path without rewriting the global `~/.codex` state for every launch.

### 4. Native wrapper auth homes

For request-bearing wrapper launches, `codex-multi-auth-codex` prepares a selected-account native `CODEX_HOME` containing `auth.json`, `accounts.json`, and a sanitized `config.toml`. Stale `codex-multi-auth-runtime-proxy` provider config is stripped from that native home. The official Codex CLI then runs with normal ChatGPT auth semantics.

### 5. Runtime rotation proxy

When `codexRuntimeRotationProxy` is explicitly enabled, the wrapper starts a loopback Responses-compatible proxy and writes a temporary shadow `CODEX_HOME/config.toml` that selects the local provider:

`codex-multi-auth-runtime-proxy`

The proxy:

- accepts only local authenticated client requests
- forwards Responses API and model discovery requests
- replaces upstream auth headers with the selected managed account
- rotates accounts on rate limits, auth refresh failures, network errors, and server errors before response bytes are streamed
- strips hop-by-hop and stale decoded response headers before returning data to the local Codex client
- records runtime status for `codex-multi-auth status`, `codex-multi-auth report`, and `codex-multi-auth rotation status`

### 6. Codex desktop app support

`codex-multi-auth rotation enable` can bind a packaged Codex desktop app to the same local runtime-rotation path.

This is reversible:

- the real Codex `config.toml` is backed up before modification
- a localhost router is started for the app
- a user login startup entry keeps the router available
- `codex-multi-auth rotation disable` or `codex-multi-auth rotation unbind-app` restores the backup and removes the startup entry
- official app binaries are not patched

`scripts/codex-app-launcher.js` also supports user-level shortcut routing for environments where shortcuts can be retargeted safely.

### 6. Optional plugin-host runtime

The package root still exports the plugin-host entrypoint for integrations that load `index.ts`.

That path reuses the same account pool for:

- request transformation
- token refresh
- retry and failover
- session affinity
- live account sync
- quota-aware selection

Normal `codex-multi-auth ...` usage and wrapper forwarding do not require this host mode.

---

## Request Flow

Default CLI path:

```text
Terminal user
  |
  | codex-multi-auth ...
  v
scripts/codex-multi-auth.js
  |
  v
local account manager
```

Forwarded official Codex path:

```text
Terminal user
  |
  | codex-multi-auth-codex exec/review/resume/app/...
  v
scripts/codex.js
  |
  | forwards non-auth command
  v
Official Codex CLI
```

Default wrapper path:

```text
Terminal user
  |
  v
codex-multi-auth-codex wrapper
  |
  | selected account native CODEX_HOME
  v
Official Codex CLI ChatGPT auth
```

Opt-in runtime rotation path:

```text
Terminal user or Codex app
  |
  v
codex-multi-auth-codex wrapper/app bind
  |
  | local provider: codex-multi-auth-runtime-proxy
  v
localhost Responses proxy
  |
  | selected managed account token
  v
Official Codex backend
```

Optional plugin-host path:

```text
Plugin host
  |
  v
codex-multi-auth plugin runtime
  |
  v
Codex or ChatGPT-backed request flow with refresh, retry, and failover
```

---

## Design Constraints

- The official OAuth flow remains the source of authentication.
- The canonical command family is `codex-multi-auth ...`.
- The OAuth callback port remains `1455`.
- Runtime rotation is opt-in and localhost-only.
- The desktop app bind is reversible and does not patch official app files.
- Local storage and repair tooling are designed for personal operator workflows, not hosted multi-user services.

---

## Related

- [getting-started.md](getting-started.md)
- [features.md](features.md)
- [configuration.md](configuration.md)
- [reference/commands.md](reference/commands.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
