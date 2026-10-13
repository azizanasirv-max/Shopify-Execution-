# LiveKit Cloud deployment workflow (staged)

This directory holds the prepared GitHub Actions workflow that deploys the agent
in `agent/` to LiveKit Cloud with the official
[`livekit/deploy-action`](https://github.com/livekit/deploy-action).

## Why it is staged here instead of `.github/workflows/`

The automation account that prepared this branch is a GitHub App installation
without the **Workflows** repository permission, so GitHub rejects *any* write to
`.github/workflows/**` (both `git push` and the Contents API), with:

```
refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml`
without `workflows` permission
```

Nothing else about the preparation is blocked: the Dockerfile, `.dockerignore`,
`livekit.toml.example`, `package.json`/lockfile changes and the documentation are
already committed to the branch.

## Install it (one of two ways)

1. **GitHub web UI (no extra permissions needed):**
   create `.github/workflows/deploy-agent.yml` and paste the contents of
   [`deploy-agent.yml`](./deploy-agent.yml).
2. **Locally:**
   ```bash
   git mv agent/deploy/deploy-agent.yml .github/workflows/deploy-agent.yml
   git commit -m "Add LiveKit agent deploy workflow"
   ```

After installing, delete this `agent/deploy/` directory.

## Companion CI change (optional)

`.github/workflows/ci.yml` gained an `agent-typecheck` job that runs
`npm ci && npm run typecheck` inside `agent/`. It could not be committed for the
same reason. Add this job to the `jobs:` map of `.github/workflows/ci.yml`:

```yaml
  agent-typecheck:
    name: LiveKit agent typecheck (agent/)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: agent
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install agent dependencies
        run: npm ci --no-audit --no-fund

      - name: Agent TypeScript check
        run: npm run typecheck
```

## What the workflow does

| Step | Detail |
|---|---|
| Operation resolution | `auto` → `deploy` when `agent/livekit.toml` exists, `create` when it does not (manual runs only). Pushes to `main` without a registered agent are skipped, never failed. |
| Credential check | Fails fast when `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` or `ASSEMBLYAI_API_KEY` is missing. |
| Image guard | Fails if `agent/Dockerfile` defines any credential variable. |
| `create` | Registers the agent, deploys it, opens a PR with the generated `agent/livekit.toml`. |
| `deploy` | Rolling deploy with `WORKING_DIRECTORY: agent`. |
| `status-retry` | Waits until the agent reports `Running` (5 min). |

Runtime secrets: `ASSEMBLYAI_API_KEY` is passed through `SECRET_LIST`, stored by
LiveKit Cloud secrets management and injected into the container as a plain
environment variable. `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` are
injected automatically by LiveKit Cloud and are never baked into the image.
