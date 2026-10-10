/**
 * Make a certificate for the local development server.
 *
 * **Why this is needed at all.** `getUserMedia` and `MediaRecorder` are
 * *secure-context* APIs: a browser only defines them over HTTPS, or on
 * `localhost`. Reached at `http://192.168.0.184:5173` — which is how a phone on
 * the same Wi-Fi reaches this machine — `navigator.mediaDevices` is `undefined`,
 * and so is `crypto.randomUUID`, and so is a service worker. Nothing about the
 * code is broken; the page is simply not in a context where the browser will
 * offer those things, **and no permission prompt appears because there is no API
 * to prompt for.**
 *
 * That last part is what made this hard to diagnose from the outside: a screen
 * saying "this browser does not support recording" on a phone that obviously
 * does sounds like a detection bug, and it was one — the detection was right and
 * the explanation was useless.
 *
 * **A self-signed certificate, not a real one.** This is a development machine on
 * a home network; there is nothing to verify the identity of. The phone has to be
 * told once to trust it, and `docs/README.md` says how.
 *
 * The certificate covers `localhost`, `127.0.0.1` and **every LAN address this
 * machine currently has**, because the phone connects by IP and a certificate
 * without the IP in its subjectAltName is rejected even after being trusted.
 *
 * Re-run it when the router hands out a different address:
 *
 *     pnpm dev:cert
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "apps", "web", ".certs");

/**
 * Every IPv4 address this machine has, minus loopback and link-local.
 *
 * Virtual adapters are skipped. A VPN sits on its own subnet and is unreachable
 * from a phone on the Wi-Fi, but it still gets an address — and printing
 * `https://26.x.x.x:5173` as somewhere to go sends the user to a URL that cannot
 * work, which reads as "the certificate did not help" rather than "that is not
 * your Wi-Fi address".
 */
const VIRTUAL_INTERFACE_HINTS = ["radmin", "vpn", "virtual", "vmware", "hyper-v", "loopback", "tap"];

function localAddresses() {
  const found = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    const lower = name.toLowerCase();
    if (VIRTUAL_INTERFACE_HINTS.some((hint) => lower.includes(hint))) continue;

    for (const address of addresses ?? []) {
      if (address.family !== "IPv4") continue;
      if (address.internal) continue;
      // 169.254.x.x means the interface never got a lease; it will not be used.
      if (address.address.startsWith("169.254.")) continue;
      found.push({ address: address.address, interface: name });
    }
  }

  return found;
}

function findOpenssl() {
  const candidates = [
    "C:/Program Files/Git/usr/bin/openssl.exe",
    "C:/Program Files/Git/mingw64/bin/openssl.exe",
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return "openssl";
}

const networks = localAddresses();
const addresses = networks.map((entry) => entry.address);

if (addresses.length === 0) {
  console.error("找不到局域网地址。请先连上 Wi-Fi 再运行。");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const keyPath = path.join(outDir, "dev-key.pem");
const certPath = path.join(outDir, "dev-cert.pem");
const configPath = path.join(outDir, "openssl.cnf");

/**
 * `subjectAltName` is the part that matters.
 *
 * Modern browsers ignore the legacy `commonName` entirely: a certificate whose
 * CN is `192.168.0.184` but whose SAN lists only `localhost` is refused with
 * `ERR_CERT_COMMON_NAME_INVALID` even after the phone has trusted the root. The
 * IP has to be in the SAN, spelled as `IP:` rather than `DNS:`.
 */
const config = `[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_ext

[dn]
CN = Libellum local development

[v3_ext]
basicConstraints = critical, CA:TRUE
keyUsage         = critical, digitalSignature, keyEncipherment, keyCertSign
extendedKeyUsage = serverAuth
subjectAltName   = @alt

[alt]
DNS.1 = localhost
IP.1  = 127.0.0.1
${addresses.map((address, index) => `IP.${String(index + 2)}  = ${address}`).join("\n")}
`;

writeFileSync(configPath, config, "utf8");

const openssl = findOpenssl();

try {
  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      // A long life on purpose: an expired development certificate produces a
      // browser warning that looks exactly like the problem this script exists
      // to fix, and the cause would be a date.
      "-days",
      "825",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-config",
      configPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`生成证书失败：${detail}`);
  console.error("需要 openssl。装了 Git for Windows 的话它就在 Git 的安装目录里。");
  process.exit(1);
}

console.log("");
console.log("  开发用 HTTPS 证书已生成");
console.log("");
console.log(`  证书：${path.relative(root, certPath)}`);
console.log(`  私钥：${path.relative(root, keyPath)}`);
console.log("");
console.log("  这张证书覆盖了这些地址：");
console.log("    localhost");
console.log("    127.0.0.1");
for (const address of addresses) console.log(`    ${address}`);
console.log("");
console.log("  手机上要访问的地址：");
for (const address of addresses) console.log(`    https://${address}:5173`);
console.log("");
console.log("  ⚠️ 手机第一次打开会提示证书不受信任，需要手动信任一次。");
console.log("     步骤写在 docs/README.md 的「手机访问」一节。");
console.log("");
console.log("  ⚠️ 证书文件在 .gitignore 里，不会进仓库。");
console.log("");
