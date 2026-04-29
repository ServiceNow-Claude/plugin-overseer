# Plugin Overseer

A local web app for managing ServiceNow plugin updates. It connects to your instance via REST API, lists all installed plugins, compares installed vs available versions, and lets you trigger updates individually, in bulk, or all at once — without needing to navigate the App Manager UI.

![Python](https://img.shields.io/badge/python-3.10%2B-blue) ![Flask](https://img.shields.io/badge/flask-3.x-lightgrey) ![ServiceNow](https://img.shields.io/badge/ServiceNow-compatible-green)

---

## Features

- **Full plugin inventory** — lists every installed plugin from `sys_store_app`, including name, scope, vendor, installed version, and latest available version
- **Update detection** — compares semantic versions and flags plugins where a newer version is available
- **Filter tabs** — quickly switch between *Updates Available*, *Up to Date*, and *All* views
- **Live search** — filters the table in real time by plugin name, scope, or vendor
- **Expandable rows** — click any row to see description, metadata, and release notes (links to App Manager when notes are not cached locally)
- **Individual updates** — update a single plugin with one click; progress is polled live
- **Batch updates** — select any combination of plugins and update them together
- **Update All** — trigger updates for every plugin with an available version in one action
- **Live status polling** — the UI polls `sys_progress_worker` and updates each row's status in real time without a page reload
- **Auto-move on completion** — when an update finishes, the row fades out of the Updates tab and the summary counts update automatically
- **Script fallback** — if the REST update endpoint is unavailable, a ready-to-run background script is generated and displayed for manual execution in *System > Scripts > Background*

---

## Requirements

- Python 3.10 or later
- A ServiceNow instance with admin access (or a role that can read `sys_store_app` and execute `sn_appclient.AppUpgrader`)
- A local service account on the instance using **basic authentication** (username + password, no SSO/MFA)

---

## Installation

```bash
git clone https://github.com/ServiceNow-Claude/plugin-overseer.git
cd plugin-overseer
python -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows
.venv\Scripts\activate

pip install -r requirements.txt
```

---

## Configuration

Copy `.env.example` to `.env` and fill in your instance details:

```bash
cp .env.example .env
```

`.env`:

```env
SN_INSTANCE=dev12345
SN_USERNAME=claudecode
SN_PASSWORD=yourpassword
```

| Variable | Description |
|---|---|
| `SN_INSTANCE` | The subdomain of your instance — just `dev12345`, not the full URL |
| `SN_USERNAME` | A local ServiceNow account with admin role (must use basic auth, not SSO) |
| `SN_PASSWORD` | Password for that account |

> **Note:** The `.env` file is gitignored. Never commit credentials.

---

## ServiceNow Setup — Scripted REST API

Plugin Overseer requires a custom Scripted REST API on your instance. This is necessary because the `sys_store_app` table (which holds installed plugin data including `latest_version`) is ACL-protected and cannot be queried directly via the Table API, even with admin access. The Scripted REST API runs server-side with full access.

### 1. Create the Scripted REST API

1. In ServiceNow, navigate to **System Web Services > Scripted REST APIs**
2. Click **New**
3. Fill in:
   - **Name:** `Plugin Overseer`
   - **API ID:** `plugin_overseer`
4. Save the record. The base API path will be `/api/snc/plugin_overseer`.

### 2. Add the GET `/plugins` resource

This resource returns all installed plugins with version data.

In the **Resources** related list on the Scripted REST API record, click **New**:

- **Name:** `Get Plugins`
- **HTTP Method:** `GET`
- **Relative Path:** `/plugins`
- **Requires Authentication:** ✅

**Script:**

```javascript
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var records = [];
    var gr = new GlideRecord('sys_store_app');
    gr.addQuery('install_date', 'ISNOTEMPTY');
    gr.orderBy('name');
    gr.query();

    while (gr.next()) {
        records.push({
            sys_id:            gr.getUniqueValue(),
            name:              gr.getValue('name'),
            scope:             gr.getValue('scope'),
            version:           gr.getValue('version'),
            latest_version:    gr.getValue('latest_version'),
            vendor:            gr.getValue('vendor'),
            install_date:      gr.getValue('install_date'),
            short_description: gr.getValue('short_description'),
            release_notes:     gr.getValue('release_notes')
        });
    }

    response.setBody({ result: records });
})(request, response);
```

### 3. Add the POST `/update` resource

This resource triggers a batch update using the `sn_appclient.AppUpgrader` Script Include.

In the **Resources** related list, click **New** again:

- **Name:** `Trigger Update`
- **HTTP Method:** `POST`
- **Relative Path:** `/update`
- **Requires Authentication:** ✅

**Script:**

```javascript
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var body = request.body.data;
    var plugins = body.plugins || [];

    if (!plugins.length) {
        response.setStatus(400);
        response.setBody({ error: 'No plugins provided' });
        return;
    }

    var packages = [];
    for (var i = 0; i < plugins.length; i++) {
        var p = plugins[i];
        packages.push({
            displayName:       p.name,
            id:                p.sys_id,
            load_demo_data:    false,
            type:              'application',
            requested_version: p.latest_version
        });
    }

    var payload = JSON.stringify({ name: 'Plugin Overseer Update', packages: packages });
    var result  = new sn_appclient.AppUpgrader().installBatch(payload);

    if (!result) {
        response.setStatus(500);
        response.setBody({ error: 'installBatch returned null — check that sn_appclient is available on this instance' });
        return;
    }

    var parsed = JSON.parse(result);
    response.setBody({
        result: {
            batch_id:   parsed.batch_installation_id,
            tracker_id: parsed.execution_tracker_id,
            message:    'Update triggered for ' + plugins.length + ' plugin(s)'
        }
    });
})(request, response);
```

### 4. Service account permissions

The account specified in `.env` needs:

- **admin** role (required to read `sys_store_app` and invoke `sn_appclient.AppUpgrader`)
- Basic authentication enabled (local account, not federated/SSO)

---

## Running the App

```bash
python app.py
```

Then open [http://localhost:5000](http://localhost:5000) in your browser.

The app fetches all plugin data from your instance on each page load. Hit **↺ Refresh** in the header (or reload) to re-query the instance.

---

## Script Fallback

If the POST `/update` endpoint is unavailable on your instance (e.g. `sn_appclient` is restricted), Plugin Overseer will automatically generate a background script for the affected plugins. A modal will appear with the script pre-filled — copy it and paste it into **System > Scripts > Background** (application scope: Global) on your instance.

---

## GenAI Disclosure

**This tool does not use any generative AI at runtime.** It makes no calls to AI APIs, LLMs, or any third-party AI services. All logic — version comparison, REST calls, status polling, UI rendering — is deterministic code.

This project was **developed with the assistance of [Claude Code](https://claude.ai/code)** (Anthropic's AI coding assistant), which was used as a development tool to write and iterate on the code. The deployed application itself is entirely AI-free.

---

## Project Structure

```
plugin-overseer/
├── app.py                  # Flask app, routes
├── servicenow/
│   ├── client.py           # HTTP client (auth, request handling)
│   ├── plugins.py          # Fetches plugin list from Scripted REST API
│   └── updater.py          # Triggers updates; generates fallback script
├── templates/
│   ├── report.html         # Main plugin table UI
│   └── error.html          # Error page
├── static/
│   ├── css/styles.css
│   └── js/app.js           # Filtering, search, update flow, status polling
├── .env.example
└── requirements.txt
```

---

## License

MIT
