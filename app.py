import os
import logging
from datetime import datetime, timezone
from flask import Flask, jsonify, render_template, request
from dotenv import load_dotenv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
# Suppress Werkzeug's raw HTTP access log — we emit our own descriptive lines
logging.getLogger("werkzeug").setLevel(logging.WARNING)

from servicenow.client import ServiceNowClient
from servicenow.plugins import get_plugins
from servicenow.updater import get_app_version, get_update_status, update_batch, update_single

load_dotenv()


def _default_client_factory():
    for var in ("SN_INSTANCE", "SN_USERNAME", "SN_PASSWORD"):
        if not os.environ.get(var):
            raise RuntimeError(f"Missing required environment variable: {var}")
    return lambda: ServiceNowClient(
        instance=os.environ["SN_INSTANCE"],
        username=os.environ["SN_USERNAME"],
        password=os.environ["SN_PASSWORD"],
    )


def create_app(client_factory=None):
    """
    Application factory. Pass client_factory for testing:
        app = create_app(client_factory=lambda: FakeClient())
    """
    if client_factory is None:
        client_factory = _default_client_factory()

    app = Flask(__name__)
    logged_complete: set[str] = set()

    def _log_result(label: str, result) -> None:
        if result.success:
            logging.info("UPDATE  %s queued via %s  (tracker: %s)", label, result.method, result.tracker_id or "n/a")
        elif result.script:
            logging.warning(
                "UPDATE  %s — direct API unavailable (%s). "
                "Background script generated — open the browser modal to copy it.",
                label, result.error,
            )
        else:
            logging.error("UPDATE  %s failed — %s", label, result.error)

    # ── Pages ──────────────────────────────────────────────────────────────────────

    @app.route("/")
    def report():
        try:
            client = client_factory()
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
        client = client_factory()
        updatable, _ = get_plugins(client)
        return jsonify(updatable)

    @app.route("/api/update", methods=["POST"])
    def api_update():
        plugin = request.get_json(force=True)
        name = plugin.get("name", "<unknown>")
        logging.info("UPDATE  starting update for: %s", name)
        result = update_single(client_factory(), plugin)
        _log_result(name, result)
        return jsonify(result.to_dict())

    @app.route("/api/update/batch", methods=["POST"])
    def api_update_batch():
        body = request.get_json(force=True)
        plugins = body.get("plugins", [])
        names = ", ".join(p.get("name", "?") for p in plugins)
        logging.info("UPDATE  batch starting — %d plugin(s): %s", len(plugins), names)
        result = update_batch(client_factory(), plugins)
        _log_result(f"batch ({len(plugins)} plugins)", result)
        return jsonify(result.to_dict())

    @app.route("/api/update/all", methods=["POST"])
    def api_update_all():
        client = client_factory()
        updatable, _ = get_plugins(client)
        logging.info("UPDATE  all starting — %d plugin(s) need updates", len(updatable))
        result = update_batch(client, updatable, update_all=True)
        _log_result(f"all ({len(updatable)} plugins)", result)
        return jsonify(result.to_dict())

    @app.route("/api/version/<sys_id>")
    def api_version(sys_id):
        result = get_app_version(client_factory(), sys_id)
        if result.get("complete"):
            logging.info("VERSION  [%s] %s — updated to %s ✓",
                         sys_id[:8], result.get("name", ""), result.get("version"))
        return jsonify(result)

    @app.route("/api/status/<tracker_id>")
    def api_status(tracker_id):
        result = get_update_status(client_factory(), tracker_id)
        if not result.get("success"):
            logging.warning("STATUS  [%s] poll error — %s", tracker_id[:8], result.get("error"))
            return jsonify(result)

        state   = result.get("state", "")
        percent = result.get("percent", 0)
        message = result.get("message", "")

        state_lower = state.lower()
        terminal_success = state_lower in ("complete", "successful", "succeeded", "success")
        terminal_failure = state_lower in ("complete_with_errors", "error", "failed", "cancelled")
        if terminal_success or terminal_failure:
            if tracker_id not in logged_complete:
                logged_complete.add(tracker_id)
                if terminal_success:
                    logging.info("STATUS  [%s] COMPLETE ✓  %s%%  %s", tracker_id[:8], percent, message)
                else:
                    logging.warning("STATUS  [%s] %s  %s%%  %s", tracker_id[:8], state.upper(), percent, message)
        elif percent > 0 or state_lower in ("running", "in_progress"):
            logging.info("STATUS  [%s] %s  %s%%  %s", tracker_id[:8], state or "running", percent, message)

        return jsonify(result)

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=True, port=5000)
