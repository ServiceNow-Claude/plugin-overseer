import json
from .client import ServiceNowClient


def _batch_payload(plugins: list) -> dict:
    return {
        "name": "Plugin Overseer Update",
        "packages": [
            {
                "displayName": p["name"],
                "id": p["sys_id"],
                "load_demo_data": False,
                "type": "application",
                "requested_version": p["latest_version"],
            }
            for p in plugins
        ],
    }


def _background_script(plugins: list, update_all: bool = False) -> str:
    """
    Generates a background script to run in System > Scripts > Background (scope: Global).
    When update_all=True it queries sys_store_app for everything needing an update.
    When update_all=False it filters sys_store_app to the named plugins only.
    """
    target_names = json.dumps([p["name"] for p in plugins])
    name_filter = (
        "install_dateISNOTEMPTY^hide_on_ui=false^vendor=ServiceNow^ORvendorISEMPTY"
        if update_all
        else f"install_dateISNOTEMPTY^nameIN{','.join(p['name'] for p in plugins)}"
    )
    scope_comment = "all plugins needing updates" if update_all else f"{len(plugins)} selected plugin(s)"

    return f"""\
// Plugin Overseer — Batch Update Script
// Run in: System > Scripts > Background (scope: Global)
// Targets: {scope_comment}

var nameFilter = "{name_filter}";
var prevName;
var appsArray = [];

var grSSA = new GlideRecord("sys_store_app");
grSSA.addEncodedQuery(nameFilter);
grSSA.orderBy("name");
grSSA.orderBy("version");
grSSA.query();

while (grSSA.next()) {{
    var curName = grSSA.getValue("name");
    if (curName == prevName) continue;
    var latestVersion = grSSA.getValue("latest_version");
    if (latestVersion && updateAvailable(grSSA)) {{
        prevName = curName;
        appsArray.push({{
            displayName: curName,
            id: grSSA.getUniqueValue(),
            load_demo_data: false,
            type: "application",
            requested_version: latestVersion
        }});
    }}
}}

function updateAvailable(gr) {{
    var inst = gr.getValue("version").split(".");
    var late = gr.getValue("latest_version").split(".");
    var len = Math.max(inst.length, late.length);
    for (var i = 0; i < len; i++) {{
        var a = inst[i] ? parseInt(inst[i]) : 0;
        var b = late[i] ? parseInt(late[i]) : 0;
        if (a < b) return true;
        if (a > b) return false;
    }}
    return false;
}}

if (appsArray.length > 0) {{
    var appsPackages = {{ packages: appsArray, name: "Update Apps" }};
    var data = new global.JSON().encode(appsPackages);
    var baseUrl = gs.getProperty("glide.servlet.uri");
    var update = new sn_appclient.AppUpgrader().installBatch(data);
    var updateObj = JSON.parse(update);

    gs.info(
        "\\n\\nBatch install:\\n" + baseUrl +
        "nav_to.do?uri=sys_batch_install_plan.do?sys_id=" + updateObj.batch_installation_id +
        "\\n\\nExecution tracker:\\n" + baseUrl +
        "nav_to.do?uri=sys_progress_worker.do?sys_id=" + updateObj.execution_tracker_id + "\\n"
    );

    var grSBIP = new GlideRecord("sys_batch_install_plan");
    if (grSBIP.get(updateObj.batch_installation_id)) {{
        grSBIP.setValue("notes",
            "Batch update triggered by Plugin Overseer ({scope_comment}).\\n\\n" +
            "Apps will populate in the related list — refresh as needed.\\n" +
            "State changes to In progress once queued, then Installed when complete."
        );
        grSBIP.update();
    }}
}} else {{
    gs.info("\\n\\nNo updates found for the targeted plugins.\\n");
}}
"""


PLUGIN_UPDATE_PATH   = "/api/snc/plugin_overseer/update"
APP_MANAGER_PATH     = "/api/sn_appclient/v1/appmanager/product/install"


def _parse_tracker(result: dict) -> tuple[str, str]:
    """Extract (tracker_id, batch_id) from any recognised response shape."""
    inner = result.get("result", result)
    if isinstance(inner, dict):
        tracker = (inner.get("tracker_id") or inner.get("execution_tracker_id") or
                   inner.get("executionTrackerId") or "")
        batch   = (inner.get("batch_id") or inner.get("batch_installation_id") or
                   inner.get("batchInstallationId") or "")
        return tracker, batch
    return "", ""


def update_batch(client: ServiceNowClient, plugins: list, update_all: bool = False) -> dict:
    if not plugins:
        return {"success": False, "error": "No plugins provided"}

    packages = [
        {
            "displayName": p["name"],
            "id": p["sys_id"],
            "load_demo_data": False,
            "type": "application",
            "requested_version": p["latest_version"],
        }
        for p in plugins
    ]
    payload = {"name": "Plugin Overseer Update", "packages": packages}

    # 1. Try the native App Manager endpoint (same API the UI uses)
    try:
        result    = client.post(APP_MANAGER_PATH, body=payload)
        tracker, batch = _parse_tracker(result)
        return {
            "success": True,
            "method": "app_manager",
            "tracker_id": tracker,
            "batch_id": batch,
            "message": f"Update triggered for {len(plugins)} plugin(s)",
        }
    except Exception as exc_am:
        pass  # fall through to custom endpoint

    # 2. Try the custom plugin_overseer Scripted REST endpoint
    try:
        result    = client.post(PLUGIN_UPDATE_PATH, body={"plugins": plugins})
        inner     = result.get("result", {})
        tracker   = inner.get("tracker_id") or inner.get("execution_tracker_id") or ""
        batch     = inner.get("batch_id") or inner.get("batch_installation_id") or ""
        return {
            "success": True,
            "method": "plugin_overseer_api",
            "tracker_id": tracker,
            "batch_id": batch,
            "message": f"Update triggered for {len(plugins)} plugin(s)",
        }
    except Exception as exc_po:
        return {
            "success": False,
            "method": "script_fallback",
            "script": _background_script(plugins, update_all=update_all),
            "error": str(exc_po),
            "message": "API endpoints unavailable — use the generated background script instead.",
        }


def update_single(client: ServiceNowClient, plugin: dict) -> dict:
    return update_batch(client, [plugin])


def get_update_status(client: ServiceNowClient, tracker_id: str) -> dict:
    try:
        result = client.get(
            f"/api/now/table/sys_progress_worker/{tracker_id}",
            params={"sysparm_fields": "state,percent_complete,message,sys_id"},
        )
        r = result.get("result", {})
        return {
            "success": True,
            "state": r.get("state", ""),
            "percent": r.get("percent_complete", 0),
            "message": r.get("message", ""),
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}
