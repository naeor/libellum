# -*- coding: utf-8 -*-
"""Check Latin-derived finalists across several TLDs (authoritative RDAP endpoints).

在 .com 基本被抢光的前提下，问题变成：哪个拉丁名还能拿到一个像样的域名。
"""
import time
import urllib.error
import urllib.request

NAMES = [
    "liberum", "libri", "librum", "libellus", "libellum",
    "libro", "libre", "libretto", "libella", "rationum",
    "naelo", "yinda",  # 基准：已验证 .app 空闲
]
RDAP = {
    "com": "https://rdap.verisign.com/com/v1/domain/{n}.com",
    "app": "https://pubapi.registry.google/rdap/domain/{n}.app",
    "dev": "https://pubapi.registry.google/rdap/domain/{n}.dev",
    "io": "https://rdap.identitydigital.services/rdap/domain/{n}.io",
    "xyz": "https://rdap.centralnic.com/xyz/domain/{n}.xyz",
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
    winners = []
    for n in NAMES:
        npm = probe(f"https://registry.npmjs.org/{n}")
        org = probe(f"https://github.com/orgs/{n}")
        doms = {}
        for t in tlds:
            doms[t] = probe(RDAP[t].format(n=n))
            time.sleep(0.3)
        print(f"{n:<10} {npm:<6} {org:<6} " + " ".join(f"{doms[t]:<7}" for t in tlds), flush=True)
        if npm == "FREE" and org == "FREE":
            good = [f".{t}" for t in ("com", "app", "dev") if doms[t] == "FREE"]
            if good:
                winners.append((n, good))

    print("\n=== npm + GitHub 组织均空闲，且有优质域名（.com/.app/.dev）===")
    for n, g in winners:
        print(f"  {n:<10} {' '.join(g)}")


if __name__ == "__main__":
    main()
