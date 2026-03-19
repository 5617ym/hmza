# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Wasla Al-Maliya (وصلة المالية) — a Financial Statement Extraction Engine for Arabic-language financial documents (Saudi Arabian companies). See `PROJECT_STATE.md` for current engineering focus.

Architecture: **Azure Static Web Apps** with vanilla HTML/CSS/JS frontend (root `/`) and **Azure Functions v2** Node.js API backend (`/api`).

### Running the application locally

The app has a **DEV_MODE** flag (`assets/js/main.js`, line 3: `const DEV_MODE = true`) that bypasses Azure Blob Storage uploads and Azure Document Intelligence calls, using local test JSON files (`api/almarai-layout.json`, `api/jadwa-reit-layout.json`, `api/rajhi-bank-layout.json`) instead.

**Required global tools** (pre-installed via VM snapshot):
- `azure-functions-core-tools` (v4) — `func` command
- `@azure/static-web-apps-cli` — `swa` command

**Critical:** `api/local.settings.json` must exist for `func start` to work without an interactive prompt. It is **not** checked into the repo (it is in `.gitignore` or simply absent). Create it if missing:
```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": ""
  }
}
```

**Start the app:**
```bash
cd /workspace
swa start . --api-location api --port 4280
```
This serves the frontend on `http://localhost:4280` and proxies `/api/*` to the Azure Functions host.

### Lint / Test / Build

- **No linter, test framework, or build step** is configured. The frontend is vanilla HTML/CSS/JS (`skip_app_build: true` in CI).
- Syntax-check all backend JS: `cd api && node -c extract-financial/index.js && node -c analyze/index.js && node -c ingest/index.js && node -c upload-url/index.js`
- Smoke-test the extraction API: `curl -s http://localhost:4280/api/extract-financial -X POST -H "Content-Type: application/json" -d '{"useLocalTest":true,"localTestFile":"almarai-layout.json","period":"annual","compare":"none"}'`

### Azure secrets (optional in DEV_MODE)

These env vars are only needed for production / full end-to-end testing (not DEV_MODE):
- `STORAGE_ACCOUNT_NAME`, `STORAGE_ACCOUNT_KEY`, `BLOB_CONTAINER` — Azure Blob Storage
- `DI_ENDPOINT` / `DOCUMENT_INTELLIGENCE_ENDPOINT`, `DI_KEY` / `DOCUMENT_INTELLIGENCE_KEY` — Azure Document Intelligence
