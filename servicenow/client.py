import re
import requests
from requests.auth import HTTPBasicAuth


class ServiceNowClient:
    def __init__(self, instance, username, password):
        # Normalise: accept bare subdomain, full hostname, or full URL
        instance = instance.strip()
        instance = re.sub(r'^https?://', '', instance)
        instance = re.sub(r'\.service-now\.com.*$', '', instance)
        self.instance = instance
        self.base_url = f"https://{instance}.service-now.com"
        self.session = requests.Session()
        self.session.auth = HTTPBasicAuth(username, password)
        self.session.headers.update({
            "Accept": "application/json",
            "Content-Type": "application/json",
        })

    def get(self, path, params=None):
        resp = self.session.get(f"{self.base_url}{path}", params=params, timeout=30)
        resp.raise_for_status()
        return resp.json()

    def post(self, path, body=None):
        import logging
        resp = self.session.post(f"{self.base_url}{path}", json=body, timeout=60)
        if not resp.ok:
            logging.error("POST %s → %s: %s", path, resp.status_code, resp.text[:500])
        resp.raise_for_status()
        return resp.json()
