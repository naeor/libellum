# -*- coding: utf-8 -*-
"""Latin-finalists, round 2: 换更合适的后缀找可用域名。"""
import time
import urllib.error
import urllib.request

NAMES = ["libri", "librum", "librio", "libry", "libris", "librae", "ratione", "libella"]
RDAP = {
    "app": "https://pubapi.registry.google/rdap/domain/{n}.app",
    "dev": "https://pubapi.registry.google/rdap/domain/{n}.dev",
    "me": "https://rdap.identitydigital.services/rdap/domain/{n}.me",
    "one": "https://rdap.identitydigital.services/rdap/domain/{n}.one",
}
UA = {"User-Agent": "Mozilla/5.0 (name-check)"}


def probe(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
            r.read(64)
            return "TAKEN"
    except urllib.error.HTTPError as e:
        return "FREE" if e.code == 404 else f"H{e.code}"
    except Exception:  # noqa: BLE001
        return "ERR"


def main():
    tlds = list(RDAP)
    print(f"{'name':<10} {'npm':<6} {'ghOrg':<6} " + " ".join(f"{'.'+t:<7}" for t in tlds))
    for n in NAMES:
        npm = probe(f"https://registry.npmjs.org/{n}")
        org = probe(f"https://github.com/orgs/{n}")
        doms = {}
        for t in tlds:
            doms[t] = probe(RDAP[t].format(n=n))
            time.sleep(0.3)
        print(f"{n:<10} {npm:<6} {org:<6} " + " ".join(f"{doms[t]:<7}" for t in tlds), flush=True)


if __name__ == "__main__":
    main()
