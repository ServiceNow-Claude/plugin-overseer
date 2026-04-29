import os
import logging
from datetime import datetime, timezone
from flask import Flask, jsonify, render_template, request
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")

from servicenow.client import ServiceNowClient
from servicenow.plugins import get_plugins
from servicenow.updater import get_update_status, update_batch, update_single

load_dotenv()

app = Flask(__name__)


def _client() -> ServiceNowClient:
    return ServiceNowClient(
        instance=os.environ["SN_INSTANCE"],
        username=os.environ["SN_USERNAME"],
        password=os.environ["SN_PASSWORD"],
    )


# ── Pages ──────────────────────────────────────────────────────────────────────

@app.route("/")
def report():
    try:
        client = _client()
        updatable, all_plugins = get_plugins(client)
        return render_template(
            "report.html",
            plugins=all_plugins,
            update_count=len(updatable),
            up_to_date_count=len(all_plugins) - len(updatable),
            total_count=len(all_plugins),
            instance=os.environ.get("SN_INSTANCE", ""),
            refreshed=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        )
    except Exception as exc:
        return render_template("error.html", error=str(exc)), 500


# ── API ────────────────────────────────────────────────────────────────────────

@app.route("/api/plugins")
def api_plugins():
    client = _client()
    updatable, _ = get_plugins(client)
    return jsonify(updatable)



@app.route("/api/update", methods=["POST"])
def api_update():
    plugin = request.get_json(force=True)
    logging.info("UPDATE single: %s", plugin.get("name"))
    result = update_single(_client(), plugin)
    if not result.get("success"):
        logging.error("Update failed: %s", result.get("error"))
    return jsonify(result)


@app.route("/api/update/batch", methods=["POST"])
def api_update_batch():
    body = request.get_json(force=True)
    plugins = body.get("plugins", [])
    logging.info("UPDATE batch: %d plugin(s)", len(plugins))
    result = update_batch(_client(), plugins)
    if not result.get("success"):
        logging.error("Batch update failed: %s", result.get("error"))
    return jsonify(result)


@app.route("/api/update/all", methods=["POST"])
def api_update_all():
    client = _client()
    updatable, _ = get_plugins(client)
    logging.info("UPDATE all: %d plugin(s)", len(updatable))
    result = update_batch(client, updatable, update_all=True)
    if not result.get("success"):
        logging.error("Update all failed: %s", result.get("error"))
    return jsonify(result)


@app.route("/api/status/<tracker_id>")
def api_status(tracker_id):
    result = get_update_status(_client(), tracker_id)
    return jsonify(result)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
