# Stonelion Kung Fu — Martial Arts Training Platform

A small Deno backend plus single-page web UI for training tracking and ESP32 sensor input.

## What works now

- Local Deno backend: `server.ts`
- Web frontend: `index.html`
- Data storage via Deno KV (Deploy-compatible)
- ESP32 endpoints for hits and polling:
  - `POST /hit`
  - `GET /api/state?token=...`
  - `POST /reset`
  - `POST /target`
  - `POST /api/device/token`

## Files

- `server.ts` — Deno backend and API router
- `index.html` — frontend UI
- `logo.png` — relative logo asset used by the page (copy your PNG from `C:\Users\sarag\OneDrive\StrikesensLogo.png` into the repo root as `logo.png`)
- `.vscode/settings.json` — Deno editor support
- `deno.json` — Deno config with import map
- `import_map.json` — remote std imports mapped to bare specifiers
- `.gitignore` — ignores local data and editor files

## Local setup

1. Install Deno if needed:
   ```powershell
   iwr https://deno.land/install.ps1 -useb | iex
   ```

2. Run the backend from the project root:
   ```powershell
   deno run --allow-net --allow-read --allow-write --unstable-kv --import-map=import_map.json server.ts
   ```

3. Open the app in your browser:
   - `http://localhost:8080`

### VS Code quick start

Use the built-in task to launch the server faster:

1. Open Command Palette: `Ctrl+Shift+P`
2. Run: `Tasks: Run Build Task`
3. Choose: `Start Stonelion Kung Fu server`

This launches Deno and starts the app at `http://localhost:8080`.

### One-click launch

A VS Code launch configuration is also available:

1. Open the Run view: `Ctrl+Shift+D`
2. Select `Launch Stonelion Kung Fu server`
3. Click the green Start button

If `8080` is already in use, stop the old server first by closing the terminal or task that is running the previous Deno process.

4. To test from another device on your Wi-Fi network:
   - find your local PC IP with `ipconfig`
   - use `http://<YOUR_IP>:8080`

## GitHub push

From `c:\Users\sarag\Documents\SaraGNG15032`:

```powershell
git init
git add .
git commit -m "Initial IRON FIST app"
git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPO>.git
git push -u origin main
```

If the repository already exists, just commit and run:

```powershell
git push
```

## Deno / VS Code support

- The workspace has `.vscode/settings.json` enabled for Deno.
- Use the official Deno extension in VS Code.
- Run `deno cache server.ts` to prefetch remote dependencies.
- Run `deno lint` to validate the project.

## ESP32 integration

The ESP32 should connect to the app backend using HTTP over Wi-Fi.

### Example request to create a device token

1. Sign up and log in through the web app.
2. Call `POST /api/device/token` with the bearer auth token.
3. The server returns a `deviceToken`.

### Example hit payload

```json
{
  "deviceToken": "YOUR_DEVICE_TOKEN",
  "sensors": { "up": 100, "down": 20, "left": 10, "right": 5 },
  "threshold": 500,
  "timestamp": 1680000000000
}
```

### Example ESP32 URL

```http
http://<YOUR_PC_IP>:8080/hit
```

## Deno Deploy note

This project now uses Deno KV for storage, which is compatible with Deno Deploy.

- Local Deno still works with `--allow-read --allow-write`.
- On Deno Deploy, the same code uses the built-in KV database.

If you later want a more robust production database, you can migrate to:

- D1
- Supabase / PostgreSQL
- REST-backed storage service

## Deploying to Deno Deploy

1. Create a project at https://dash.deno.com/deploy or use an existing Deno Deploy project.
2. Create a Deno Deploy token in the dashboard.
3. Add GitHub secrets to your repository:
   - `DENO_DEPLOY_PROJECT` — your Deno Deploy project name
   - `DENO_DEPLOY_TOKEN` — the deploy token
4. Push your repo to GitHub and let the workflow deploy automatically.

### Deploy from your machine

If you want to upload the latest code directly from your PC, use the Deno Deploy CLI.

1. Install or update Deno:
   ```powershell
   deno upgrade
   ```

2. Run deploy from the project root:
   ```powershell
   deno deploy --app stonelion --token <YOUR_DENO_DEPLOY_TOKEN> .
   ```

This command uploads your current project files as the latest version to Deno Deploy.

> You do not need `--import-map` here because the deploy app uses `deno.json`.

### Using GitHub Actions

A workflow is included at `.github/workflows/deno-deploy.yml`.
It lints the code and deploys on every push to `main` if the secrets are configured.

## Quick commands

```powershell
deno upgrade
deno run --allow-net --allow-read --allow-write --unstable-kv --import-map=import_map.json server.ts
deno cache server.ts
deno lint
deno deploy --app stonelion --token <YOUR_DENO_DEPLOY_TOKEN> .
```

## Notes

- Keep `data/` out of Git because it contains runtime data.
- The backend is ready to run locally and the frontend is loaded from `index.html`.
- For Deno Deploy, change the data layer before deploying.
