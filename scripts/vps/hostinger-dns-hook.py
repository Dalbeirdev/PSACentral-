#!/usr/bin/env python3
"""Let's Encrypt DNS-01 validation through the Hostinger DNS API (certbot manual hooks).

Used when the Control Plane shares a server whose port 80 belongs to another product (PioDesk), so
the HTTP-01 challenge cannot be served. certbot calls this script twice per name:
  auth:    HOSTINGER_API_TOKEN=... hostinger-dns-hook.py auth     (CERTBOT_DOMAIN, CERTBOT_VALIDATION set by certbot)
  cleanup: HOSTINGER_API_TOKEN=... hostinger-dns-hook.py cleanup
and `hostinger-dns-hook.py test <zone>` adds and removes a harmless TXT record to prove the token works.

Only the Python standard library is used, so the script runs unchanged inside the certbot image.
The token is read from the environment and never printed. Record names are relative to the zone, as
the Hostinger API expects ("_acme-challenge" for the apex, "_acme-challenge.www" for www).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("HOSTINGER_API_BASE", "https://developers.hostinger.com")
TTL = 300


def token():
    t = os.environ.get("HOSTINGER_API_TOKEN", "").strip()
    if not t:
        sys.exit("HOSTINGER_API_TOKEN is not set (an API token from the Hostinger panel, Account → API).")
    return t


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read().decode() or "{}"
            return res.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        sys.exit(f"Hostinger API {method} {path} failed: HTTP {e.code} {detail}")
    except urllib.error.URLError as e:
        sys.exit(f"Hostinger API unreachable: {e.reason}")


def zone_of(domain):
    """The zone (registered domain) a validated name belongs to: HOSTINGER_DNS_ZONE wins, else the last two labels."""
    z = os.environ.get("HOSTINGER_DNS_ZONE", "").strip().lower()
    if z:
        return z
    labels = domain.lower().rstrip(".").split(".")
    return ".".join(labels[-2:])


def relative(name, zone):
    name = name.lower().rstrip(".")
    if name == zone:
        return "@"
    if name.endswith("." + zone):
        return name[: -len(zone) - 1]
    sys.exit(f"{name} is not inside the zone {zone}")


def add_txt(zone, rel, value):
    call("PUT", f"/api/dns/v1/zones/{zone}", {"overwrite": False, "zone": [{"name": rel, "type": "TXT", "ttl": TTL, "records": [{"content": value}]}]})


def delete_txt(zone, rel):
    call("DELETE", f"/api/dns/v1/zones/{zone}", {"filters": [{"name": rel, "type": "TXT"}]})


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("auth", "cleanup", "test"):
        sys.exit(__doc__)
    mode = sys.argv[1]
    if mode == "test":
        zone = (sys.argv[2] if len(sys.argv) > 2 else os.environ.get("HOSTINGER_DNS_ZONE", "")).lower()
        if not zone:
            sys.exit("usage: hostinger-dns-hook.py test <zone>")
        rel = "_psacc-dns-test"
        add_txt(zone, rel, f"psacc-{int(time.time())}")
        status, records = call("GET", f"/api/dns/v1/zones/{zone}")
        names = {r.get("name") for r in records} if isinstance(records, list) else set()
        delete_txt(zone, rel)
        if rel not in names:
            sys.exit(f"The test record was not visible after creation (names seen: {sorted(n for n in names if n)[:10]}).")
        print(f"Hostinger DNS API works for {zone}: a TXT record was created and removed ({len(names)} names in the zone).")
        return
    domain = os.environ.get("CERTBOT_DOMAIN", "")
    if not domain:
        sys.exit("CERTBOT_DOMAIN is not set; this script is meant to be called by certbot.")
    zone = zone_of(domain)
    rel = "_acme-challenge" if relative(domain, zone) == "@" else "_acme-challenge." + relative(domain, zone)
    if mode == "auth":
        add_txt(zone, rel, os.environ.get("CERTBOT_VALIDATION", ""))
        # Give the authoritative servers time to publish before Let's Encrypt looks.
        time.sleep(int(os.environ.get("HOSTINGER_DNS_WAIT", "60")))
        print(f"TXT {rel}.{zone} published for validation")
    else:
        delete_txt(zone, rel)
        print(f"TXT {rel}.{zone} removed")


if __name__ == "__main__":
    main()
