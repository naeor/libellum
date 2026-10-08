# -*- coding: utf-8 -*-
"""查 GitHub 用户名是否可注册：github.com/<name> 返回 404 即为空闲。

注意：GitHub 用户名是"先到先得"，404 只代表此刻没人用；注册以 GitHub 实际校验为准。
"""
import sys
import time
import urllib.error
import urllib.request

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
}


def probe(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
            r.read(64)
            return "TAKEN"
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return "FREE"
        return f"H{e.code}"
    except Exception:  # noqa: BLE001
        return "ERR"


CANDIDATES = [
    # 柔和 5 字母，元音多
    "alune", "avelo", "elior", "elune", "elira", "elori", "ilora", "iolan", "iriel",
    "liora", "loreo", "luven", "lyria", "lyara", "melio", "miroe", "mirae", "myrlo",
    # n 开头（贴近 naelo）
    "naelu", "naelio", "naeor", "naero", "naimo", "nelio", "nerio", "nielo", "nimeo",
    "nirae", "noreo", "nyrae",
    # o / r / s / v / z 开头
    "oriel", "orino", "ovira", "relio", "rielo", "saelo", "selio", "solen", "sorel",
    "syrae", "vaelo", "velio", "verio", "veyla", "vireo", "zaelo", "zairo", "zelio",
    "zenoa", "zeria", "zevae", "zirae", "naelo",
]


def main():
    names = sys.argv[1:] or CANDIDATES
    free, taken, other = [], [], []
    for n in names:
        r = probe(f"https://github.com/{n}")
        (free if r == "FREE" else taken if r == "TAKEN" else other).append((n, r))
        print(f"{n:<9} {r}", flush=True)
        time.sleep(0.5)

    print("\n=== 空闲（可以注册）===")
    print("  " + "  ".join(n for n, _ in free) if free else "  （本批全部已被占用）")
    if other:
        print("=== 异常（限流等，需重试）===")
        print("  " + "  ".join(f"{n}:{r}" for n, r in other))


if __name__ == "__main__":
    main()
