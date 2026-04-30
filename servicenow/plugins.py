from .client import ServiceNowClient

PLUGIN_API_PATH = "/api/snc/plugin_overseer/plugins"


def _has_update(installed: str, latest: str) -> bool:
    if not installed or not latest or installed == latest:
        return False
    try:
        def parse(v):
            return tuple(int(x) for x in v.strip().split("."))
        return parse(latest) > parse(installed)
    except (ValueError, AttributeError):
        return latest.strip() != installed.strip()


def get_plugins(client: ServiceNowClient):
    """
    Returns (updatable, all_plugins) via the Plugin Overseer Scripted REST API.
    updatable: plugins where latest_version > version, sorted by name.
    """
    result = client.get(PLUGIN_API_PATH)

    # Response is double-nested: {"result": {"result": [...]}}
    inner = result.get("result", {})
    records = inner.get("result", []) if isinstance(inner, dict) else inner

    all_plugins = []
    updatable = []

    for r in records:
        version = r.get("version", "").strip()
        latest  = r.get("latest_version", "").strip()
        has_update = _has_update(version, latest)

        plugin = {
            "sys_id":                  r.get("sys_id", ""),
            "name":                    r.get("name", ""),
            "scope":                   r.get("scope", ""),
            "version":                 version or "—",
            "latest_version":          latest or "—",
            "vendor":                  r.get("vendor", ""),
            "install_date":            (r.get("install_date") or "")[:10],
            "short_description":       r.get("short_description", ""),
            "release_notes":           r.get("release_notes", ""),
            "has_update":              has_update,
            "installed_as_dependency": bool(r.get("installed_as_dependency", False)),
            "dependencies":            r.get("dependencies", []),
        }
        all_plugins.append(plugin)
        if has_update:
            updatable.append(plugin)

    updatable.sort(key=lambda x: x["name"].lower())
    return updatable, all_plugins
