# Libevra 服务器部署与日常维护入门

> 写给第一次管理服务器的项目所有者。编写日期：2026-10-16。
>
> ## ⚠️ 2026-10-16 更新：服务器**已经部署完成**
>
> 本文写作时服务器尚未被触碰，所以下面说"本轮没有连接服务器"。**那句话现在不成立了**：
> Libevra **1.10.23 已经部署并上线到 <https://libevra.com>**。
>
> **实际发生了什么、验证结果如何，看 [`部署记录-S12-B.md`](部署记录-S12-B.md)。**
> 本文作为**概念与教学**材料保留（"每段命令在哪里运行""数据存在哪里""坏了怎么恢复"
> 这些讲解仍然有效），**但涉及"当前状态"的表述以部署记录为准。**
>
> **三处与本文预期不同的实测结果**：
>
> | 本文的预期 | 实际情况 |
> |---|---|
> | 服务器 2 核 2 GB，需按 `deploy/README.md` §3 做内存降级 | **实测 7.5 GiB + 1.9 GiB swap**，语音模型直接用 `small`，四档降级方案**不需要** |
> | `Caddyfile` 的 `email {$ACME_EMAIL}` 可直接用 | ⚠️ **空值会让 Caddy 拒绝整个配置**，站点起不来。已改由 `deploy/web-entrypoint.sh` 按需生成（部署记录 §4） |
> | 部署配置"已写好但从未执行" | **已执行，并因此发现 3 个真 bug**：`prisma.config.ts` 未进镜像、`node_modules` 不可写、pnpm 重装依赖导致 `migrate` 退出 127 |
>
> **这是一份教学文件，不是服务器操作记录。** 本文不声称自己执行过任何部署。
> 内容依据当前工作区的 S12-A 文档、管理员设计、品牌迁移记录、交接与开发日志，以及 `deploy/` 配置和脚本。
> 基准 Git 提交为 `d2c7a67f206ba7a704790aae57a5c6ded6d2702b`；本文把"代码中有这个步骤"和"服务器上已成功完成"分开说明。

## 0. 先看全貌：网站怎样从电脑来到手机

```text
开发与发布（由所有者决定何时上线）
Windows 改代码 → Git 提交 → 推送 GitHub → CI 自动检查
                                          │ 人工核对目标提交与结果
                                          ▼
                              SSH 登录 Ubuntu → 构建、迁移、启动、验收

用户使用（电脑关机不影响云服务器运行）
手机浏览器打开 https://libevra.com
    │ DNS：把域名查成公网 IP 43.161.227.152
    ▼
腾讯云实例防火墙 → Ubuntu / Docker 网络 → web 容器里的 Caddy
                                            ├─ 普通页面 → 静态前端文件
                                            └─ /api/* → api 容器（Fastify）
                                                           ├─ Prisma → db（PostgreSQL）
                                                           ├─ OCR Python 子进程
                                                           └─ 语音 Python 子进程

数据与恢复
PostgreSQL → db-data 数据卷 → 数据库备份文件 → 另一台设备的受保护副本
浏览器中的未同步账目 ── 尚未进入服务器备份，必须另外保护
```

建议按顺序读一遍概念，再阅读第 9 章首次部署。已经部署成功后，日常主要用第 10—14 章。不要把全篇命令一次粘贴执行。

### 0.1 每段命令在哪里运行

| 标记 | 实际位置 | 怎么辨认 |
|---|---|---|
| **Windows PowerShell（普通）** | 自己电脑的 PowerShell 窗口 | 通常显示 `PS C:\Users\…>` |
| **Windows PowerShell（管理员）** | 右键 PowerShell → 以管理员身份运行 | 用于管理 Windows 服务，操作后回到普通窗口 |
| **Ubuntu Bash** | SSH 成功后，或腾讯云 VNC 登录后的 Linux 终端 | 常见提示符为 `用户名@主机:~$`；不再是 Windows |
| **容器内执行，由 Ubuntu 发起** | 在 Ubuntu 输入 `docker compose … exec …` | 命令前半段在服务器，`exec` 后面的程序在指定容器 |
| **网站操作** | Namecheap、腾讯云、GitHub 或 Libevra 的浏览器页面 | 不是终端命令 |

代码块不包含提示符；只复制命令。说明中的占位符必须替换：例如“实际 Ubuntu 用户名”“目标提交完整 hash”，不是要求照打这些汉字。密码输入时没有字符回显通常是正常行为。`Ctrl+C` 可中断前台命令；`exit` 退出 SSH，回到 Windows。

### 0.2 先约定三个位置

| 位置 | 用途 |
|---|---|
| Windows 项目目录 `C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1` | 日常开发 |
| Windows `$env:USERPROFILE\.ssh\libevra_server` | 已有 SSH 私钥，不能上传服务器、GitHub 或聊天 |
| Ubuntu `/srv/libevra`，其下 `deploy/` | **本教程的部署路径约定，尚未核实实际部署路径** |

如果 DeepSeek 最终部署在其他目录，日后沿用它的真实目录和 Compose 项目名，并在自己的运维记录中记下来。**不要为配合教程另建一套生产栈**。Compose 项目名会影响数据卷名称；换目录或随意增加 `-p` 参数，可能连接到全新的空卷，造成“数据不见了”的错觉。

## 1. 我们已经做到哪里

### 1.1 能确认的事实与不能代替验收的记录

| 事项 | 已知情况 | 证据与边界 |
|---|---|---|
| 服务器 | 腾讯云 Lighthouse，中国香港，Ubuntu 24.04.4 LTS，x86_64，2 核 / 8 GB / 80 GB，公网 IPv4 `43.161.227.152` | 所有者提供；本轮未登录核验 |
| 域名 | Namecheap 注册的 `libevra.com` | 所有者提供 |
| 主域名 DNS | A 记录查询返回 `43.161.227.152` | 本轮 Windows 只读查询；不是网页可用性测试 |
| `www` DNS | 查询 `www.libevra.com` 的 CNAME 返回 **`libvera.com`** | 本轮默认解析器及 `1.1.1.1` 查询均如此；与目标 `libevra.com` 不一致，可能是拼写错误，须由所有者在实际 DNS 托管处核对；本轮未改记录 |
| SSH 密钥 | Windows 已有 Ed25519 密钥 `libevra_server` 与 `.pub`；公钥已安装，曾成功登录 | 所有者提供；本轮未读取私钥、未尝试登录 |
| SSH Agent | 本机服务查询显示 Running、启动类型 Manual | 编写过程的本地只读检查；**服务运行不代表目标密钥已加入** |
| 早先服务器检查 | 资源充足、22 可达、当时未装 Docker，也未发现 nginx / Caddy / PostgreSQL；有待安装更新 | 所有者提供的先前检查；DeepSeek 正在部署，不能当作当前状态 |
| S12-A | 1.10.23 的安全与发布准备；已有部署配置、管理员双重校验和历史检查记录 | 见原审计文档，其日期和测试结果属于当时 |
| S12-B | 所有者说明 DeepSeek 正在真实部署 | 进行中；本教程不宣称 Docker、HTTPS、生产迁移、管理员、备份或异地恢复已验收 |

**本教程所有部署命令均为供以后操作的步骤，未由本轮在 Linux / Docker 环境执行。** 新增配置中的“已在真实部署发现问题”属于部署方写入的记录，不是本轮独立复测。

### 1.2 接收部署交付时，应让部署方留下什么

无需交出密码。请保存：真实部署目录、Ubuntu 登录用户名、Compose 项目名、目标完整提交、未提交修补是否已归入版本、应用显示版本、镜像 ID、数据库迁移状态、DNS 与 HTTPS 检查时间、管理员初始化结果、首份备份及恢复演练结果、异地副本位置、定时任务与服务器时区。缺少这些信息，日后无法可靠判断“正在运行哪一版”和“应该恢复哪一份”。

## 2. 服务器与操作系统：把资源的含义弄清楚

### 第一层：简单理解

云服务器也是计算机，区别是放在服务商机房，持续供电、联网。自己的电脑主要用于写代码和发起管理命令；网站进程在云端，因此关闭 Windows 或退出 SSH，正常后台运行的网站仍然存在。服务器到期、关机、系统故障或服务退出仍会造成停机。

| 名词 | 简单理解 | 本项目中要关注什么 |
|---|---|---|
| CPU | 处理计算的能力 | 2 核；构建、图片识别、语音转写会竞争计算时间 |
| 内存 RAM | 程序运行时的工作空间 | 8 GB；看 `available`，不要只看 `free`；Linux 会利用闲置内存缓存文件 |
| 磁盘 | 重启后仍保存的空间 | 80 GB；系统、镜像、数据库、备份、模型和日志都占用它 |
| Swap | 用一部分磁盘缓解内存压力 | 比内存慢，不能保证不会 OOM；频繁交换说明资源紧张 |
| 公网 IP | 互联网上可访问的地址 | `43.161.227.152`；还必须有允许访问的端口和正在监听的程序 |
| 内网 IP | 私有网络中的地址 | 不等于域名应填写的公网地址；容器另有自己的内部网络 |
| Ubuntu | 服务器操作系统 | 管进程、权限、网络、磁盘；24.04 是版本系列，LTS 表示长期支持系列 |
| 系统服务 | 由系统管理的后台程序 | `ssh` 处理登录，`docker` 管容器；由 `systemctl` 查看 |

旧说明按 2 GB 估算资源，本机实际购买规格为 8 GB。不要照旧说明直接降模型、购买升级或增加固定大小 Swap；先测量真实负载。Swap 不是备份，磁盘够用也不代表内存够用。

### 第二层：实际操作——查看，不改变系统

**目的**：确认当前系统和资源。**设备**：Ubuntu Bash。**前提**：已能登录。**重复**：首次接收、发布前、发生性能问题时。

```bash
uname -m
cat /etc/os-release
uptime
free -h
df -h
swapon --show
sudo ss -tlnp
```

预期：架构显示 `x86_64`；系统为 Ubuntu 24.04 系列；磁盘检查重点看 `/` 的可用空间和使用率。`swapon --show` 无输出可能表示未启用 Swap，不等于故障。`ss` 中 `127.0.0.1` 是本地监听，`0.0.0.0` 通常是所有 IPv4 接口监听，`[::]` 涉及 IPv6；监听与防火墙是否放行是两件事。

如果内存紧张、磁盘接近满或系统版本不同，先记录现象，不直接重启、扩容或清理数据。不能根据这几个命令就判断所有业务正常。

## 3. SSH、公钥、私钥与 SSH Agent

### 3.1 第一层：简单理解

SSH 是加密的远程终端连接。登录后，你在窗口里输入的 Linux 命令会在服务器执行。

- **公钥**是允许某个身份登录的公开验证材料，可安装到服务器。
- **私钥**用来证明自己持有这个身份，只保存在自己的受保护设备上。
- **私钥密码短语 passphrase**用来加密磁盘上的私钥文件；它不是 Ubuntu 登录密码，也不是 Libevra 密码。
- **`authorized_keys`**是某个 Ubuntu 用户允许登录的公钥列表，通常位于该用户的 `~/.ssh/authorized_keys`。
- **服务器 Host Fingerprint**是服务器自身 SSH 主机密钥的指纹，用于确认“我连的是正确的服务器”。它与自己的用户公钥指纹不是同一件事。
- **SSH Agent**在本机帮助 SSH 使用已经解锁的身份进行签名。它不是把私钥复制到服务器；使用它也不需要把密码短语交给 AI。

`~/.ssh` 在 Linux 指当前 Linux 用户的目录；Windows 的用户目录用 `$env:USERPROFILE` 表示。这是两种终端语言，不能互换。

### 3.2 第二层：实际操作——使用已经存在的密钥

**目的**：确认文件存在并连接。**设备**：普通 Windows PowerShell。**前提**：确认真实 Ubuntu 登录用户名，不能把 Libevra 用户名当成 Linux 用户名。**重复**：登录时运行 SSH；不需要重新生成密钥。

```powershell
Test-Path "$env:USERPROFILE\.ssh\libevra_server"
Test-Path "$env:USERPROFILE\.ssh\libevra_server.pub"
ssh-keygen -lf "$env:USERPROFILE\.ssh\libevra_server.pub"
$libevraSshUser = Read-Host '请输入已有的 Ubuntu 登录用户名'
ssh -i "$env:USERPROFILE\.ssh\libevra_server" -o IdentitiesOnly=yes "${libevraSshUser}@43.161.227.152"
```

前两个结果应为 `True`。第三条显示用户公钥的 SHA256 指纹，可以用来核对是否装了同一把公钥。`-i` 指定身份文件；`IdentitiesOnly=yes` 避免客户端依次尝试一堆不相关密钥。连接成功后提示符变为 Ubuntu 提示符。

首次连接如提示服务器指纹，**先通过独立渠道核对**。腾讯云控制台 → 轻量应用服务器 → 此实例 → 服务器登录 → VNC 登录，在确认是该实例的控制台中运行：

**Ubuntu Bash，腾讯云 VNC 内：**

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

仅当 SSH 提示的算法也是 Ed25519 时直接比较这一行。算法不同应核对对应 `.pub`，不要比较错对象。确认一致才在自己的 PowerShell 输入 `yes`。`known_hosts` 会记住主机身份；以后出现主机密钥改变，先查是否重装、换 IP 或换密钥，不能为消除报错就随便删除记录。单独通过网络取得的 `ssh-keyscan` 结果不构成独立身份验证。

VNC 通常需要 Linux 用户名和密码；应在调整 SSH / 防火墙前由所有者确认备用方式确实能用，不是只确认按钮存在。参考[腾讯云 VNC 登录说明](https://cloud.tencent.com/document/product/1207/46824)。不要为了本教程临时更改已经工作的登录配置。

### 3.3 仅在将来新增设备或更换密钥时生成密钥

**现有 `libevra_server` 已生成，不要覆盖。** 以下示例为将来另建新密钥，先检查新文件不存在。

**普通 Windows PowerShell：**

```powershell
$libevraNewKey = "$env:USERPROFILE\.ssh\libevra_server_new"
if ((Test-Path $libevraNewKey) -or (Test-Path "$libevraNewKey.pub")) { throw '目标已存在，停止，不能覆盖' }
ssh-keygen -t ed25519 -f $libevraNewKey -C 'libevra-owner-windows'
```

按提示由本人输入强密码短语并妥善保管。生成的无扩展名文件是私钥，`.pub` 是公钥。**不要生成后把两者都上传**。

安装新公钥时，通过已有可信 SSH 连接登录目标 Ubuntu 用户，先备份原列表，再用 `nano` 追加新公钥的一整行，保留原有登录方式：

**Ubuntu Bash，以实际目标用户操作：**

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
if [ -f ~/.ssh/authorized_keys ]; then
  cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.before-libevra-change
fi
nano ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

公钥可从 Windows 的 `.pub` 文件复制；私钥不能复制。编辑后保留旧 SSH 窗口，用另一个 Windows 窗口以新私钥测试。成功后再决定是否撤销旧钥匙。若备份文件已存在，先另取备份名，避免覆盖唯一可恢复副本。

`700` 表示该目录只有所有者可以读、写、进入；`600` 表示文件只有所有者可以读写。不是“数值越大越好”，也不能用 `777` 解决权限问题。Windows 文件权限由 ACL 管理，不在 PowerShell 用 Linux `chmod` 来修复。

### 3.4 配置 Windows SSH Agent

**目的**：本人解锁一次后，让同一 Windows 用户下的 SSH 客户端使用该身份。**前提**：本人掌握密码短语，使用 Windows 系统 OpenSSH。**重复**：服务设置通常一次；服务重启或身份未加载时按需重新加入并验证。

先在**管理员 Windows PowerShell**查看并启动服务：

```powershell
Get-Service ssh-agent | Select-Object Name,Status,StartType
Set-Service -Name ssh-agent -StartupType Automatic
Start-Service ssh-agent
Get-Service ssh-agent
```

本轮查到服务已经 Running、Manual；如只需要当前会话，可保留 Manual，不必为教程重复改设置。自动启动表示开机启动 Agent 服务，**不等于保证每次开机目标密钥都可用**。

然后回到**自己的普通 Windows PowerShell**：

```powershell
Get-Command ssh,ssh-add,ssh-keygen | Select-Object Name,Source
ssh-add "$env:USERPROFILE\.ssh\libevra_server"
ssh-add -l
```

由本人在终端输入密码短语。预期出现身份已加入，列表包含对应公钥指纹。对照第 3.2 节的指纹即可，不需要查看私钥内容。再运行第 3.2 节 SSH 登录命令验证。

如果报告找不到 Agent，先看服务是否启动；若 Git Bash、WSL 和 Windows 系统 OpenSSH 混用，可能连接的是不同 Agent。先统一使用 `C:\Windows\System32\OpenSSH\` 下的工具、同一 Windows 用户和普通窗口，再排查。微软说明见[Windows OpenSSH 密钥管理](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)。

### 3.5 AI 使用 Agent 的权限边界与撤销

**能使用 Agent 不等于没有服务器权限。** AI 若能调用这个身份登录，就拥有该 Linux 账号能行使的权限；账号能 `sudo` 或管理 Docker 时，影响范围可能接近整台服务器。Agent 保护的是私钥使用方式，不是给远程命令自动加审批。

建议把授权写清楚：可以读取状态；安装更新、发布、重启、改防火墙、改密钥和恢复数据库前，先说明确切命令、影响及恢复办法，由所有者确认。对别的任务给过的登录授权，不应自动解释成可以删库。不要使用 Agent 转发 `ssh -A` 作为默认部署方法。

暂时从本机 Agent 卸下这一把身份：

**普通 Windows PowerShell：**

```powershell
ssh-add -d "$env:USERPROFILE\.ssh\libevra_server"
ssh-add -l
```

这不会删除私钥，也不会撤销服务器公钥；已有 SSH 会话通常仍然存在。要撤销服务器登录资格：本人先确认另一条登录路径可用，备份目标用户 `authorized_keys`，用 `nano` 删除与待撤销指纹对应的**完整公钥行**，保留其他行，再在新窗口测试其他身份仍能登录。不要删除整个 `.ssh` 或整个列表。已建立会话、其他用户装的相同公钥和仍持有的其他钥匙，需要分别处理。

## 4. Linux 基本操作：只学日后会用到的部分

### 第一层：简单理解

终端的“当前目录”决定相对路径指向哪里。`/srv/libevra` 是从根目录开始的绝对路径；`deploy` 是相对当前目录的路径。大小写、空格和换行都有意义。Bash 中 `#` 后面是注释，反斜杠 `\` 放在行末可续行；不要把 PowerShell 的反引号续行复制进 Bash。

### 第二层：实际操作速查

以下都在 **Ubuntu Bash**，前提是拥有相应路径或权限。普通浏览操作可随时重复；修改文件、安装和重启按需执行。

| 命令 | 本项目示例与用途 | 成功与注意事项 |
|---|---|---|
| `pwd` | `pwd`：显示当前目录 | 部署操作前应确认处于预期目录 |
| `ls` | `ls -lah /srv/libevra/deploy`：列文件 | `-a` 能看到 `.env` 文件名；不要打开或公开其内容 |
| `cd` | `cd /srv/libevra/deploy` | 不输出通常是成功；失败后不要继续执行后面的部署命令 |
| `mkdir` | `mkdir -p backups` | 建目录，不自动等于权限安全；备份目录用 `700` |
| `cat` | `cat /etc/os-release` | 用于非敏感短文件；不要对 `.env`、私钥或恢复码运行 |
| `nano` | `nano .env` | 本人编辑秘密文件；`Ctrl+O` 保存、回车确认，`Ctrl+X` 退出；不把内容发聊天 |
| `chmod` | `chmod 600 .env` | 调整 Linux 权限；不递归放宽整个仓库 |
| `sudo` | `sudo systemctl status docker --no-pager` | 提升权限，可能要求 Linux 密码；不会自动让操作安全 |
| `apt` | `sudo apt update` | 刷新可安装软件清单，尚未升级软件；`apt upgrade` 才安装更新 |
| `systemctl` | `sudo systemctl status docker --no-pager` | 看系统服务；`restart` 会重启服务，应评估停机 |
| `df -h` | `df -h / /srv/libevra` | 看文件系统空间；不是单个目录占用统计 |
| `free -h` | `free -h` | 看内存，重点 `available` 和 Swap 使用 |
| `ss -tlnp` | `sudo ss -tlnp` | 看 TCP 监听；容器端口映射也要结合 Compose 检查 |

如果提示 `Permission denied`，先确认路径、文件所有者、当前用户。不要反射性加 `sudo`；如果提示命令不存在，先确认自己在 Ubuntu 而不是容器或 Windows，再决定安装。

## 5. 域名、DNS、防火墙与端口

### 5.1 DNS：第一层，简单理解

域名便于记忆，DNS 告诉客户端应该联系哪个地址。**注册商**负责域名注册、续费；**DNS 托管方**负责回答记录。二者可以是同一家公司，也可以不同，取决于域名设置的 Nameservers。

- A 记录：名字直接对应 IPv4。目标是 `libevra.com → 43.161.227.152`。
- CNAME：一个名字指向另一个名字。目标是 `www.libevra.com → libevra.com`，填写域名，不是 IP，也不是 `https://` URL。
- TTL：缓存时间。修改后不同网络可能短时间看到不同答案。
- AAAA：对应 IPv6。若存在错误 AAAA，部分设备可能优先访问错误地址；没有配置 IPv6 时不能随手添加。

DNS 正确只说明“找到地址”，不会安装网站、打开端口或保证证书正常。DNS CNAME 也不是浏览器跳转，地址栏仍是 `www`。

### 5.2 DNS：第二层，实际操作

**设备**：Namecheap 网站。**目的**：核对记录。**前提**：本人账号；确认谁托管 DNS。**重复**：首次配置、改 IP、故障时，不是每次发布。

1. 登录 Namecheap → Domain List → `libevra.com` → Manage。
2. 查看 Nameservers；若是 Namecheap BasicDNS / PremiumDNS / FreeDNS，进入 Advanced DNS → Host Records。若使用第三方 Nameservers，应去那个托管方修改，改 Namecheap Host Records 可能无效。
3. 核对 Host `@` 的 A Record，值为 `43.161.227.152`。
4. 核对 Host `www` 的 CNAME，值应为 `libevra.com`。**本轮查询看到的是 `libvera.com`，字母顺序有误，须由本人核实并纠正。** 不要照错误值填写。
5. 保存，等待缓存更新。不要随便删除 MX、TXT 等可能用于邮箱或验证的其他记录。

界面说明参考[Namecheap Host Records](https://www.namecheap.com/support/knowledgebase/article.aspx/434/2237/how-do-i-set-up-host-records-for-a-domain/)。

**普通 Windows PowerShell，只读验证：**

```powershell
Resolve-DnsName libevra.com -Type NS
Resolve-DnsName libevra.com -Type A
Resolve-DnsName www.libevra.com -Type CNAME
Resolve-DnsName www.libevra.com -Type CNAME -Server 1.1.1.1
```

预期主域名 A 匹配服务器，`www` 的 NameHost 拼写正确。公共解析器查询失败也可能是本地网络拦截，不能单独据此判断记录不存在；结合托管控制台、另一个网络与缓存时间排查。

**当前 Caddy 只配置一个域名 `LIBEVRA_DOMAIN`。** 即使 `www` CNAME 正确，也不代表它已有匹配证书、站点或跳转。首次按 `https://libevra.com` 验收。将来要支持 `www`，由部署方另行配置对应 HTTPS 站点和跳转并验收，不能只改 DNS 就宣称完成。

### 5.3 防火墙：第一层，简单理解

IP 类似地址，端口用来区分这个地址上的不同服务。**腾讯云实例防火墙**在云网络入口控制访问；**Ubuntu 的 UFW**在操作系统内管理防火墙规则。通过外层后仍可能被内层挡住；两层都放行，也必须有程序监听。

| 协议 / 端口 | 用途 | 目标策略 |
|---|---|---|
| TCP 22 | SSH 运维登录 | 保留可靠登录；条件允许后限制为本人可信公网 IP |
| TCP 80 | HTTP、转 HTTPS、部分证书验证 | 网站所需，允许公众访问 |
| TCP 443 | HTTPS | 网站所需，允许公众访问 |
| UDP 443 | HTTP/3 | 可选，不开不妨碍普通 HTTPS |
| TCP 5432 | PostgreSQL | **不对公网放行，Compose 不发布此端口** |
| TCP 3000 | API 内部服务 | 由 Caddy 转发，不对公网发布 |

不能把“同名叫 internal 的 Docker 网络”理解成绝对隔离。当前网络是普通 bridge，没有配置 `internal: true`；宿主机管理员和拥有 Docker 权限的人仍可能接触数据库。Docker 发布端口还可能绕过常规 UFW 规则，必须同时核对云防火墙和 Compose 的 `ports`，见[Docker 防火墙说明](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。

### 5.4 防火墙：第二层，实际操作

**腾讯云网站**：轻量应用服务器控制台 → 选择香港实例 → 防火墙，按上表逐条核对，避免全端口放通。SSH 来源 IP 若设错，会断掉下一次登录；动态 IP 变化后也需重新处理。备用 VNC 登录确认可用、保留当前 SSH 窗口之后，再缩小 SSH 来源范围。参考[腾讯云实例防火墙](https://cloud.tencent.com/document/product/1207/44577)。

**Ubuntu Bash，首次启用 UFW 的示例；已有规则先审查，不重复覆盖：**

```bash
sudo ufw status verbose
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

前提是 SSH 确实使用 22，且备用登录已验证。这里先保住 SSH，再启用 UFW；云防火墙仍可限制 SSH 来源。成功后立即从另一个 Windows 窗口测试新 SSH 登录和网站访问，原窗口先别关。若失败，用原连接或 VNC 检查，不继续叠加规则。此配置通常首次做一次；改变策略时再操作，不在每次发版时重做。

## 6. Docker 与 Compose：代码怎么成为后台服务

### 6.1 第一层：简单理解

| 名词 | 含义 | 和本项目的关系 |
|---|---|---|
| Image 镜像 | 程序和依赖的打包模板 | API 镜像带 Node、Prisma、Python 识别依赖；Web 镜像带前端构建产物和 Caddy |
| Container 容器 | 从镜像启动的一次运行实例 | 可以重启、替换；容器自己的可写层会随删除消失 |
| Dockerfile | 描述怎样构建镜像的文件 | `Dockerfile.api`、`Dockerfile.web` |
| Compose | 用一份 YAML 管理多个服务及依赖、网络和卷 | `deploy/docker-compose.prod.yml` |
| Volume 数据卷 | 与容器生命周期分开的持久化存储 | 更新容器后仍保留数据库；仍可能因误删、磁盘故障而丢失，所以还要备份 |

当前四个服务：`db` 保存 PostgreSQL 数据；`migrate` 执行迁移后退出；`api` 接收业务请求并启动 OCR / 语音子进程；`web` 用 Caddy 提供页面、HTTPS 和反向代理。OCR 和语音不是两个独立网络服务，不需要为它们开放公网端口。

四个卷分别是：`db-data`（数据库）、`api-data`（上传临时文件及模型缓存等）、`caddy-data`（证书与 ACME 账户材料）、`caddy-config`（Caddy 配置状态）。实际 Docker 名称通常带 Compose 项目前缀，例如项目名加 `_db-data`；不要凭示例名字删除卷。

### 6.2 第二层：实际操作——安装与检查

**此节只给未安装的新服务器使用。DeepSeek 如果已经安装完成，只检查版本，不再安装。**

目的：安装 Docker Engine 和 Compose 插件。设备：Ubuntu Bash。前提：Ubuntu 24.04 amd64、可用 sudo、网络与磁盘正常；没有正在维护的其他容器业务。首次安装一次，以后升级另选维护窗口。

先检查：

```bash
command -v docker
sudo systemctl status docker --no-pager
```

未安装时报告找不到属预期。若已安装，运行 `docker version`、`docker compose version` 并记录结果即可；权限错误不代表没安装。

对确定未安装的机器，先更新软件清单和系统。`apt upgrade` 会改变系统，保留 SSH、确认备份与 VNC，逐项查看确认提示，不直接无人值守重启。

```bash
sudo apt update
sudo apt upgrade
sudo apt install ca-certificates curl git ufw python3
```

如果提示有软件占用包管理锁，确认是否系统自动更新在运行，等待它完成；不要直接删锁文件。若提示需要重启，安排维护窗口、确认当前业务和 Docker 开机启动后再由本人执行重启，重新 SSH 验证。

下面采用 Docker 官方 APT 仓库安装方式，适用 Ubuntu 24.04；已有 `docker.io`、Podman 或旧 containerd 时先按官方兼容性说明确认，不在生产机盲目卸载。参考[Docker 官方 Ubuntu 安装指南](https://docs.docker.com/engine/install/ubuntu/)。

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl status docker --no-pager
sudo docker run --rm hello-world
sudo docker compose version
```

成功时服务为 `active (running)`，测试容器输出 Hello from Docker，Compose 显示版本。下载失败先查网络、系统时间与仓库访问；不要换成来源不明的镜像或关闭 TLS 验证。官方便捷脚本主要面向测试开发，此处不用 `curl | sudo sh` 作为生产入门步骤。

为了使后文脚本不需要混用 `sudo`，若所有者决定让当前普通运维用户管理 Docker：

```bash
sudo usermod -aG docker "$USER"
```

退出后重新 SSH 登录，再运行 `docker version` 验证权限。**docker 组接近 root 权限**，不是普通低权限账号，参考[Docker 安装后权限说明](https://docs.docker.com/engine/install/linux-postinstall/)。不希望给这个权限时，需要部署方提供一致的 sudo 操作方案；不能一半用 sudo、一半用普通用户后忽略目录权限问题。

### 6.3 日常管理命令

以下在 **Ubuntu Bash**，已安装 Docker、拥有权限，先进入真实部署的 `deploy` 目录。这里用教程约定路径：

```bash
cd /srv/libevra/deploy
docker compose -f docker-compose.prod.yml ps -a
docker compose -f docker-compose.prod.yml logs --tail 80 api
docker compose -f docker-compose.prod.yml logs --tail 80 web
```

`ps -a` 中常驻服务应运行，带健康检查的服务应 healthy；`migrate` 正常是 Exited (0)，不是必须一直 Up。失败时看对应日志与退出码，不先删容器或卷。日志可能含账号、路径或业务信息，仅在受控终端查看；发给别人前脱敏，不开启 `set -x` 或打印全部环境变量。

| 操作 | 完整命令（同一目录） | 影响与何时使用 |
|---|---|---|
| 构建 | `docker compose -f docker-compose.prod.yml build` | 从当前文件构建镜像，耗 CPU / 磁盘；不自动等于已上线 |
| 启动 / 应用配置 | `docker compose -f docker-compose.prod.yml up -d` | 后台运行，按需要创建或重建容器；可能短暂中断 |
| 看状态 | `docker compose -f docker-compose.prod.yml ps -a` | 只读，可重复 |
| 连续日志 | `docker compose -f docker-compose.prod.yml logs --tail 80 -f api` | `Ctrl+C` 只退出日志跟随，不停止 API |
| 重启 API | `docker compose -f docker-compose.prod.yml restart api` | 只是重启现有容器，不载入新镜像，也不可靠应用新的 `.env` |
| 停止 API | `docker compose -f docker-compose.prod.yml stop api` | 暂停业务写入，网站 API 不可用 |
| 停整栈 | `docker compose -f docker-compose.prod.yml down` | 删除该项目容器和网络，命名卷通常保留；网站会停，不是日常必须步骤 |

**不要给 `down` 添加 `-v`**，那会删除卷。不要拿 `docker volume prune`、`docker system prune --volumes` 或删 Docker 数据目录当常规修复。容器自动重启不是数据备份；卷保留也不能防整盘损坏。

## 7. Caddy、HTTPS 与反向代理

### 第一层：简单理解

HTTPS 用证书证明域名身份并加密传输。它不代表网站没有程序错误，也不替代账号权限和备份。Caddy 是站在入口处的服务器：把页面文件交给浏览器，把 `/api/*` 请求转发给 `api:3000`，并负责申请、续期证书。

这里使用 `handle /api/*`，**保留 `/api` 路径前缀**；不是把 `/api/v1/health` 改成 `/v1/health`。浏览器只访问同一个 HTTPS 域名，因此当前架构不需要为了上线额外开放跨域到 3000。数据库只接受应用的查询，不直接接受浏览器请求，更不能把数据库口令放进前端。

Caddy 通常能在域名解析、网络可达和证书机构条件满足时自动申请续期。需要持续保留 `/data` 卷、可用磁盘、正确时间和网络。**自动续期不是永不失效的保证**。

旧注释声称填写 `ACME_EMAIL` 会收到证书到期提醒，不能依赖它：Let's Encrypt 已在 2025-06-04 停止到期通知邮件服务，应主动监测有效期，见[官方公告](https://letsencrypt.org/2025/01/22/ending-expiration-emails.html)。可以填本人有效联系邮箱，但不能把邮箱当监控。

### 第二层：实际操作——验证配置与外部访问

**目的**：区分配置语法、容器运行与外部访问。**设备**：Ubuntu Bash。**前提**：镜像已构建、生产 `.env` 正确。**重复**：首次、Caddy 变更及证书故障时。

当前 Compose 把宿主机 `Caddyfile` 挂成 `/etc/caddy/Caddyfile.template`，`web-entrypoint.sh` 在容器内生成 `/etc/caddy/Caddyfile`，只有邮箱非空时才加入 `email` 行。**模板路径和真正运行的配置路径不同。**

先做模板检查，不启动依赖，也不发布临时容器端口：

```bash
cd /srv/libevra/deploy
docker compose -f docker-compose.prod.yml run --rm --no-deps --entrypoint caddy web validate --config /etc/caddy/Caddyfile.template --adapter caddyfile
```

这检查基础模板，未覆盖启动脚本生成邮箱行的结果。Web 启动成功后再检查**实际生成配置**：

```bash
docker compose -f docker-compose.prod.yml exec -T web caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

预期为配置有效。语法有效不代表 DNS、证书签发或 API 已通过。若邮箱含异常字符、模板挂载丢失或启动脚本失败，应交部署方修复，不在生产现场随意删除安全头来试。

**普通 Windows PowerShell，从外部验证：**

```powershell
Test-NetConnection 43.161.227.152 -Port 80
Test-NetConnection 43.161.227.152 -Port 443
curl.exe -I https://libevra.com/
curl.exe --fail --silent --show-error https://libevra.com/healthz
curl.exe --fail --silent --show-error https://libevra.com/api/v1/health
```

预期 TCP 可达，证书校验成功，页面响应正常，`/healthz` 为 `ok`，API JSON 含 `ok: true` 与 `database: "up"`。不要加 `-k` 绕过证书来宣布成功，也不要用裸 IP 的 HTTPS 代替域名验收。

当前 Web 镜像及 `deploy.sh` 的检查访问 `http://127.0.0.1/healthz`，而 Caddy 是命名 HTTPS 站点；**这个内部检查存在主机名、重定向与 TLS 匹配风险，需要部署方按实际镜像验证**。出现“外网可用但 Web unhealthy / 脚本失败”时先核对两种检查，不要直接恢复数据库或认定 DNS 错误。本轮没有修改该检查。

当前配置 `admin off`，不要假定 `caddy reload` 能通过默认管理 API 生效。配置变更由部署方验证后，可在维护窗口用 `docker compose -f docker-compose.prod.yml restart web` 重新启动并生成配置，随后重新验证外部请求；这会短暂中断。信号重载依赖 Caddy 版本及启动条件，不能照旧注释直接当通用步骤，参见[Caddy 命令行说明](https://caddyserver.com/docs/command-line)。

## 8. PostgreSQL 与 Prisma：为什么上线也有“改表”

### 第一层：简单理解

PostgreSQL 保存服务器端的用户、账本、交易、授权等数据。生产库必须与 Windows 开发库、CI 测试库隔离，不能共用连接地址或凭据。

- **数据库账号**用于程序连接 PostgreSQL，拥有数据库级能力。
- **Libevra 账号**用于人在网页登录，权限由应用逻辑控制。二者不是同一账号系统。
- **Prisma Schema**：`prisma/schema.prisma`，描述模型和字段。
- **Migration 迁移**：`prisma/migrations/` 下按顺序保存的数据库变更，可能新增表，也可能变更或删除列。
- **生成 Client**：`pnpm db:generate`，按 Schema 生成程序访问数据库的代码，不能替代迁移。
- **生产迁移**：项目命令 `pnpm db:deploy` 调用当前 Prisma 7 的 `prisma migrate deploy`，应用已经随代码提交的待执行迁移，不在服务器临时设计新迁移。

根目录 `prisma.config.ts` 指定 Schema 位置并读取 `DATABASE_URL`。生产容器使用 `db` 服务名连接；容器里的 `127.0.0.1` 指它自己，不能代表另一个数据库容器。

`migrate reset` 会重置数据库，**不能在生产执行**；开发用的 `pnpm db:migrate` / `migrate dev` 也不是生产发布命令。不要把开发机 `.env` 临时改成生产 URL 后运行开发测试。命令细节参考[Prisma 7 migrate deploy](https://docs.prisma.io/docs/cli/v7/migrate/deploy)，不要把新大版本文档里的不同命令直接套进本项目。

### 第二层：实际操作——检查与应用迁移

**设备**：Ubuntu 发起，迁移容器执行。**前提**：确认目标生产库、备份、目标代码和镜像；新增迁移先看 SQL 及旧代码兼容性。**重复**：有待执行迁移的发布，按部署流程显式确认。

只读状态检查（数据库已启动、镜像可用）：

```bash
cd /srv/libevra/deploy
docker compose -f docker-compose.prod.yml run --rm --no-deps migrate pnpm exec prisma migrate status
```

应明确显示数据库已更新，或者列出待执行 / 失败迁移。非零退出不一概等于损坏，先读状态。应用迁移的命令是：

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps migrate
```

它使用服务中的 `command: ["pnpm", "db:deploy"]`。完成后再次查状态，检查服务健康和实际业务。执行失败时**停下发布，保留输出**，不要擅自修改 `_prisma_migrations`、标记成功或 reset。

Compose 的 `depends_on` 规定先后顺序，但已经完成的一次性容器不等于每次更新都保证重新执行迁移。日常发布流程显式运行一次迁移，再启动业务；首次启动 API 时 Compose 可能再执行其 `migrate` 服务，无新迁移时应无额外变更。

**回滚应用不会撤销数据库变更。** 旧镜像可能不认识新字段，也可能依赖已被删除的列。先判断能否用旧代码兼容当前库；不能时优先评估兼容修复，只有确认恢复目标和数据损失窗口后才考虑整库恢复。不能把恢复脚本当成每次发版失败的默认按钮。

## 9. 第一次部署：按阶段走，每步都有验收点

> **正在部署的服务器不要从这里重新执行一次。** 先接收 DeepSeek 的最终记录；已做完的步骤只核对，未做的步骤由所有者安排。以下是以后理解和复现流程的教学步骤，不表示本轮已验证可一键上线。

### 9.1 开始之前的检查单

准备好本人云控制台、DNS 和 GitHub 访问；确认 SSH 与备用 VNC；记录实际部署目录和项目名；主域名 DNS 正确，80/443 放通，5432 未发布；确认磁盘和内存；确定要部署的完整提交及其 CI 结果。首次没有生产数据，也要避免覆盖其他项目现有数据。

当前部署修订已加入 Prisma 配置 / 迁移文件复制、构建占位连接、运行权限，以及可选邮箱的 Caddy 启动脚本。编写中再次核对时，原先尝试的 `npmrc.runtime` 已被部署方移除，相关 pnpm 设置转入 `pnpm-workspace.yaml` 的 `verifyDepsBeforeRun: false`。这也说明配置仍在调整；**本轮仅核对文件，未独立构建或在 Linux 测试**。让部署方验收这些变更并归档版本，不能把未提交的本地修补当作 GitHub 已测试代码。

### 9.2 取代码并固定目标提交

**目的**：让服务器运行能追溯的代码。**设备**：Ubuntu Bash。**前提**：这是首次创建目录，真实目标路径不存在；若已存在，直接进入第 10 章，不覆盖。**重复**：克隆只一次，以后 fetch 与切提交。

```bash
sudo install -d -o "$USER" -g "$(id -gn)" -m 0755 /srv/libevra
git clone https://github.com/naeor/libevra.git /srv/libevra
cd /srv/libevra
git status --short
git log --oneline -10
read -r -p '粘贴已核对 CI 的目标完整提交 hash：' LIBEVRA_TARGET_COMMIT
git checkout --detach "$LIBEVRA_TARGET_COMMIT"
git rev-parse HEAD
```

前两条只用于不存在的首次目录；不要对已部署目录修改所有者。也不要把整个 `/srv` 的所有权改给自己。若仓库无访问权限，使用本人批准的只读 GitHub 访问方案，不能把 Token 写进 clone URL、聊天或脚本；服务器登录私钥不等于 GitHub 仓库授权。

成功时 HEAD 与目标一致，工作区无未归档改动。如果切换失败或有未提交文件，停下核对来源；不要 `git reset --hard`、`git clean -fd` 抹掉别人的部署修补。本文发布命令不自动清理这些文件。

### 9.3 建立生产配置，秘密直接写文件

**目的**：建立独立生产凭据。**设备**：Ubuntu Bash，本人终端。**前提**：首次部署且 `deploy/.env` 不存在；已经有的配置不能重新生成覆盖。**重复**：通常一次；轮换密码是另外的数据库与应用协同操作。

`.env` 存放数据库口令、Session Secret 等，不进入 Git。下面的 Python 仅作为教学中的本地生成器，随机值直接写入新文件，不打印到终端。数据库口令用十六进制，避免 URL 和 Bash 特殊字符问题；脚本采用独占创建，文件已存在会停止。

```bash
cd /srv/libevra/deploy
umask 077
python3 - <<'PY'
import os
import secrets
from pathlib import Path

path = Path('.env')
db_password = secrets.token_hex(24)
values = {
    'POSTGRES_USER': 'libevra',
    'POSTGRES_PASSWORD': db_password,
    'POSTGRES_DB': 'libevra_prod',
    'DATABASE_URL': f'postgresql://libevra:{db_password}@db:5432/libevra_prod?schema=public',
    'SESSION_SECRET': secrets.token_hex(32),
    'LIBEVRA_DOMAIN': 'libevra.com',
    'WEB_ORIGIN': 'https://libevra.com',
    'ACME_EMAIL': '',
    'API_HOST': '0.0.0.0',
    'API_PORT': '3000',
    'LIBELLUM_WHISPER_MODEL': 'small',
    'LIBELLUM_WHISPER_THREADS': '2',
    'DEMO_USERNAME': 'demo',
    'DEMO_PASSWORD': secrets.token_hex(24),
}
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as stream:
    stream.write(''.join(f'{key}={value}\n' for key, value in values.items()))
print('已创建受限权限的 .env；未输出任何秘密。')
PY
chmod 600 .env
nano .env
```

本人在 `nano` 中按需填写有效 `ACME_EMAIL`，不要截屏或复制全文件给 AI。其他值与模板字段核对；后续新增必填字段时由部署方同步更新，不能无限沿用这份快照。`DEMO_*` 有值不等于演示账号已经创建、只读或每天重置，这些仍需单独初始化和验收。

不要随意给 `.env` 放 Bash 命令、空格或 shell 特殊语法：当前备份 / 恢复脚本会把它作为可信 Bash 文件加载。保持每行 `KEY=value`、LF 换行，字段值使用安全字符；不要下载别人提供的 `.env` 直接加载。

检查文件权限和配置结构，**只验证，不展开秘密到终端**：

```bash
ls -l .env
git -C .. check-ignore deploy/.env
docker compose -f docker-compose.prod.yml config --quiet
mkdir -p backups
chmod 700 backups
chmod +x deploy.sh backup.sh restore.sh
```

预期生产文件命中忽略规则，权限只有所有者读写，Compose 检查成功。**不要改成不带 `--quiet` 的 `config`**，它可能把替换后的秘密打印出来。缺变量时在本人终端编辑，不把配置原文粘到日志。

### 9.4 构建 → 数据库 → 迁移 → API → Web

**目的**：按依赖启动。**设备**：Ubuntu Bash / 容器。**前提**：前面各项通过，部署方已确认当前 Docker 配置可用。**重复**：首次完整操作；后续按第 10 章维护流程。

```bash
cd /srv/libevra/deploy
docker compose -f docker-compose.prod.yml build
```

逐步查看构建结果。2 核机器构建 Python 依赖可能较慢；出现明确 error 或非零退出就停，不把仍在下载当成成功。构建不使用真实生产 URL；当前 API Dockerfile 用无生产凭据的占位 URL 加载 Prisma 配置。

运行第 7 章模板检查，通过后启动数据库：

```bash
docker compose -f docker-compose.prod.yml up -d db
docker compose -f docker-compose.prod.yml ps -a
```

等待 db healthy；失败看 `docker compose -f docker-compose.prod.yml logs --tail 80 db`。不能通过删 `db-data` 反复重试初始化。**PostgreSQL 首次初始化后，改 `.env` 的密码不会自动修改现有库密码**；不一致要按密码轮换流程处理。

数据库 healthy 后应用迁移，确认退出成功：

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps migrate
docker compose -f docker-compose.prod.yml run --rm --no-deps migrate pnpm exec prisma migrate status
docker compose -f docker-compose.prod.yml up -d api web
docker compose -f docker-compose.prod.yml ps -a
```

API 启动时的服务依赖可能再次检查 / 运行迁移，这是预期的幂等迁移行为；不能因它已退出就手动给它设为常驻。随后按第 7 章校验实际 Caddy 配置、外部 HTTPS 和 API。Web 内部健康检查若异常按已知风险核查，不能把全部绿灯当作未经运行就有的事实。

**首次不要直接用 `deploy.sh` 起空栈**：它会先调用 `backup.sh`，数据库尚未运行时备份失败，流程会停止。先分阶段初始化，再建立第一份真实备份。不要为绕过失败而取消执行权限让脚本跳过备份。

### 9.5 建立所有者账号和应用管理员

**目的**：在生产库建立独立身份。**设备**：Ubuntu 发起命令 + Libevra 浏览器注册。**前提**：API 健康、生产库已迁移，确认尚未初始化所有者。**重复**：首次一次；以后按实际授权需求处理。

生产库不继承开发库的用户 UUID。当前管理员资格要求账号编号处于 `10000000–10000099`，还必须非演示账号、持有有效授权并在独立允许名单。**先注册的普通邀请码账号不必然取得该编号资格**。

首次使用 `--reserved` 生成一个预留编号的邀请码；不使用旧注释中的 `--admin` 来期待自动提权。邀请凭据写入受保护的新文件，不打印到聊天或共享日志：

```bash
cd /srv/libevra/deploy
umask 077
mkdir -p backups
chmod 700 backups
LIBEVRA_INVITE_FILE="backups/owner-invite-$(date +%Y%m%d-%H%M%S).txt"
( set -o noclobber; docker compose -f docker-compose.prod.yml exec -T api pnpm invite:create '生产所有者' --reserved > "$LIBEVRA_INVITE_FILE" )
nano "$LIBEVRA_INVITE_FILE"
```

本人查看邀请码并注册自己的账号，妥善保存注册时的恢复凭据，不把它交给 AI。生成命令失败或预留编号已耗尽，先核对现有账号和计数器；不要写 SQL 强行改编号。

注册成功后查看实际 UUID，并核对姓名和账号编号：

```bash
docker compose -f docker-compose.prod.yml exec -T api pnpm admin:list
read -r -p '输入刚注册且核对无误的所有者 UUID：' LIBEVRA_OWNER_UUID
docker compose -f docker-compose.prod.yml exec -T api pnpm admin:grant "$LIBEVRA_OWNER_UUID" --by 'owner@server'
docker compose -f docker-compose.prod.yml exec -T api pnpm admin:allow "$LIBEVRA_OWNER_UUID" --by 'owner@server'
docker compose -f docker-compose.prod.yml exec -T api pnpm admin:list
```

成功时同一账号既有授权又在名单。`--by` 必填，用于记录操作者；不要把账号编号当 UUID。`admin:list` 也列有资格但尚未授权的账号，便于首次定位。若拒绝资格或演示身份，停下来确认注册过程，不能绕过 guard。

应用管理员、账本 Owner/Editor/Viewer、服务器 / 数据库管理是三套权限。**应用管理员不自动获得其他人的账本读取权**；旧邀请码脚本里“管理员可访问全部数据”的打印文案不代表当前权限实现。撤销管理资格也分别对应 `admin:revoke` 和 `admin:disallow`，清空最后一个管理员有额外保护，不应随便绕过。完整依据见[管理员与权限边界](管理员与权限边界-设计决定.md)。

### 9.6 首次上线验收：不能只看健康检查

先用无敏感正式数据的测试账本走：注册 / 登录 → 新建账本 → 记一笔、改一笔、删一笔 → 明细 / 分析 → 两台设备同步 → 离线读写主路径 → 联网同步 → 邀请与分享权限。OCR / 语音另测首次下载、耗时和错误回退，它们不支持离线识别。

检查手机 / iPad 的来源域名、版本显示、HTTPS、控制台错误和同步结果。不能为了排错清除未同步的 IndexedDB、网站数据或恢复码。新域名是新的浏览器存储来源，不会自动继承旧开发地址的本地数据。

最后按第 11 章完成首份数据库备份、恢复演练、受保护异地副本；确认定时备份、证书监测和资源检查的负责人。全部完成后，才把 S12-B 中对应项从待验证改成已验收。

## 10. 日常开发与发布：每次都能说清楚上线了什么

### 10.1 第一层：简单理解

`git commit` 在本机记录一组明确修改；`git push` 把提交上传 GitHub，并不直接修改生产服务器。commit hash 是内容关联的提交身份，应记录完整值；应用界面版本如 `1.10.23` 是产品版本标记，不能独自证明构建用了哪个提交。

GitHub Actions 是自动运行检查的工作流。当前 `.github/workflows/ci.yml` 在推送 main 和 Pull Request 时，使用临时 PostgreSQL 17，安装依赖、生成 Prisma Client、迁移干净库、类型检查、测试、构建。它**没有 SSH 发布步骤，也没有 Docker 镜像构建验证**。CI 绿灯是重要前提，但不能证明生产 Compose 和证书已经可用。CI 中的测试数据库与生产库不同，不能照抄 CI 口令作为生产配置。

main 是会变化的分支。服务器应发布所有者验收过的指定提交，不执行“拉 main 最新就自动上线”的逻辑。`deploy.sh --version` 的参数只是记录标签，**不会自动 checkout 对应代码、验证标签匹配版本或固定基础镜像**。

### 10.2 第二层：Windows 准备与 GitHub 验证

目的：让改动可审查、可追溯。设备：普通 Windows PowerShell，进入项目目录。前提：相关代码已开发完成、未混入别人的工作；本教学文件的编写不要求提交或升程序版本。重复：以后每次代码发布。

```powershell
Set-Location 'C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序\记账程序v1'
git status --short
git diff --stat
pnpm typecheck
pnpm test
pnpm check:build
pnpm check:docs
```

逐条检查退出结果，任何失败先处理。涉及数据库时，还需在独立开发 / 测试库验迁移与兼容性；不能把生产地址放进本机测试环境。

本人审查后，只暂存本次需要发布的文件，不使用 `git add .` 混入临时文件和秘密。示例用交互输入文件路径；不含 `.env`、私钥、备份等：

```powershell
$libevraPublishFile = Read-Host '输入本次已审查、需要暂存的文件相对路径'
git add -- $libevraPublishFile
git diff --cached --stat
git diff --cached
git commit -m '填写本次具体修改说明'
git push
git rev-parse HEAD
```

有多个文件就逐个 `git add -- 路径`，不要只提交一部分依赖改动。`git diff --cached` 应在私人终端审查，若意外发现秘密，取消暂存并按泄露处置，不能推送。成功后记下完整 hash。

**GitHub 网站**：进入 `naeor/libevra` → Actions → CI，打开与这个**完整提交**对应的运行。确认各步骤成功，不能只看另一个提交的绿色勾。当前 CI 不包含 `check:docs`，所以本地文档检查仍有意义。GitHub 推送成功不表示服务器已上线。

### 10.3 服务器发布前：核对、备份和保留退路

目的：选中明确版本。设备：Ubuntu Bash。前提：维护窗口、无另一位代理同时部署，已保存上一版完整提交、应用版本、镜像 ID、备份路径；已确认数据库迁移风险。重复：每次发布。

```bash
cd /srv/libevra
git status --short
git rev-parse HEAD
git fetch origin
git log --oneline -10
read -r -p '粘贴已验收且 CI 通过的目标完整提交 hash：' LIBEVRA_TARGET_COMMIT
git show --no-patch --format=fuller "$LIBEVRA_TARGET_COMMIT"
```

先核对目标与旧版间的变更，特别是 `prisma/migrations/`、部署配置、依赖与环境字段。工作区不干净时先停止协调；不要覆盖 DeepSeek 或其他人的修改。确认无误后再切目标：

```bash
git checkout --detach "$LIBEVRA_TARGET_COMMIT"
git rev-parse HEAD
git status --short
cd deploy
docker compose -f docker-compose.prod.yml config --quiet
docker compose -f docker-compose.prod.yml ps -a
df -h / /srv/libevra
free -h
umask 077
flock -n /srv/libevra/deploy/backups/backup.lock ./backup.sh --keep 7
```

该发布流程用于已经完成首次初始化的服务器，`backups/` 和可执行脚本已存在。`flock` 让使用同一锁的备份避免重叠；因拿不到锁而退出时先确认是否备份正在运行，不跳过备份继续发布。脚本失败则停止，不能只看到 `.dump` 文件就放行。

**切换代码并不改变正在运行的容器**。如果新的 Compose 与旧容器 / 卷名称不兼容，先完成专项迁移计划，再执行备份和发布，不能生搬本流程。

### 10.4 推荐的可观察发布步骤

当前脚本有已知限制（见 10.5），因此这里把它实际涉及的动作拆开教学，便于看清每一步；这仍是单机维护流程，不是零停机方案。**每条成功后才执行下一条**。

**Ubuntu Bash，仍在真实 `deploy/` 目录：**

```bash
docker compose -f docker-compose.prod.yml build
```

构建成功后，如果有迁移，按已批准维护窗口暂停 API 写入，运行迁移。即使没有新迁移，显式执行迁移服务也应报告无待应用项：

```bash
docker compose -f docker-compose.prod.yml stop api
docker compose -f docker-compose.prod.yml run --rm --no-deps migrate
docker compose -f docker-compose.prod.yml run --rm --no-deps migrate pnpm exec prisma migrate status
docker compose -f docker-compose.prod.yml up -d --remove-orphans
docker compose -f docker-compose.prod.yml ps -a
```

停止 API 会造成短时不可用；维护期间也应通知使用者暂停操作。迁移失败则保留现场，不执行接下来的上线步骤；查清后由所有者决定继续兼容修复或恢复。普通不涉及迁移的发版可由部署方评估缩短停机流程，不能把上面的停止服务当作对所有情况都无成本。

接着按第 7 章做外部健康检查，在浏览器确认“账户 → 软件更新”的版本、登录和记账同步。只有完成这些，才在发布记录中写成功。记录时间、完整 commit、界面版本、迁移结果、备份文件名和实际镜像 ID：

```bash
git -C .. rev-parse HEAD
docker compose -f docker-compose.prod.yml images
docker compose -f docker-compose.prod.yml ps -q api web | xargs -r docker inspect --format '{{.Name}} {{.Image}}'
```

最后一条只取名称和镜像 ID，**不要改为完整 `docker inspect` 输出**，容器环境可能含秘密。主版本标签如 `node:24`、`postgres:17`、`caddy:2-alpine` 仍可能随时间更新；重新构建同一提交不一定得到字节相同的镜像。回滚需要保留已验证旧镜像的身份和可用性，不能只记一个产品版本号。

### 10.5 现有 `deploy.sh` 到底做什么

脚本正常用法如下，由 Ubuntu 在 `deploy/` 内发起；先完成首次初始化、备份验证，并确认部署方已经验收脚本及健康检查：

```bash
read -r -p '输入与当前签出代码匹配的应用版本号：' LIBEVRA_RELEASE_VERSION
./deploy.sh --version "$LIBEVRA_RELEASE_VERSION"
```

它读取上一版标签 `.last-deployed` → 提示脏工作区 → 调备份（可执行时）→ 构建 → `up -d` → API / Web 健康检查 → 成功才写标签。理解以下边界：

| 容易误解的地方 | 实际行为 |
|---|---|
| `--version` 会选代码 | 不会拉取或切换 Git；必须先核对实际 HEAD |
| 失败会自动回滚 | **不会**；只打印手动处理建议，服务保留在失败时的状态 |
| 一定做了备份 | 若 `backup.sh` 不可执行，代码会提示并跳过；因此先检查权限，不能利用这个分支绕过备份 |
| 每次一定跑新迁移 | 依赖已完成的一次性 migrate 服务，需结合容器 / 镜像重建情况核实；推荐显式执行迁移并查状态 |
| Web 健康表示公网 HTTPS 正常 | 脚本测内部 loopback；其站点匹配风险见第 7 章，外部验证不能省 |
| `--no-build` 能保证指定旧版 | 它只是跳过构建；若现有镜像并非目标代码，就会运行错误版本 |
| `.last-deployed` 是运行版本证明 | 只是成功时写入的自报标签，可能与真实镜像 / 提交不一致 |

第 10.4 和本节是两种讲解路径，**不要为一次发布把两套步骤原样连续跑一遍**。在部署方修订并实测脚本前，使用可观察流程；脚本验收完成后，再依据其最新行为简化。

### 10.6 更新后出错：先判断，再回滚

若只是代码问题、**已确认旧代码兼容现有数据库**，在维护窗口切回发布记录中的上一提交，构建或恢复已保留的旧镜像，使用同一项目和数据卷重建 API / Web。示例只用于数据库已健康且无需撤销迁移的情况：

**Ubuntu Bash：**

```bash
cd /srv/libevra
git status --short
read -r -p '输入发布记录中核对好的上一版完整提交 hash：' LIBEVRA_PREVIOUS_COMMIT
git checkout --detach "$LIBEVRA_PREVIOUS_COMMIT"
git rev-parse HEAD
cd deploy
docker compose -f docker-compose.prod.yml config --quiet
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d --no-deps api web
```

这里 `--no-deps` 避免用旧配置意外重新触发依赖服务；前提是 db 已运行且 Schema 兼容。然后检查状态、HTTPS、API 和业务，补写真实回滚记录；不用手工改 `.last-deployed` 来伪造脚本成功。

若新迁移已经改表，先审查迁移和旧程序兼容性。删除列、数据变换等不会随 Git checkout 撤销。优先考虑经验证的向前修复；整库恢复必须满足第 11.5 的确认条件。**不要因为 502 就回档数据库。**

## 11. 备份、验证、异地保存与恢复

### 11.1 第一层：简单理解

数据库卷是正在使用的数据，备份是另存的可恢复副本。服务器上的 `.dump` 虽然有用，但服务器或磁盘丢失时也会一起丢。可靠策略需要：定期导出、验证可恢复、异地保存、定期练习恢复，以及能说清楚允许丢失多久的数据。

每天一次备份不等于最多只会丢一天：还取决于最近一次备份是否成功、异地传输是否成功、何时发现事故。浏览器里未同步的账目不在服务器库里，不能由服务器备份找回。备份文件不是自动加密的保险箱，应按财务数据保护。

### 11.2 第二层：运行当前项目备份

**目的**：导出生产库并在临时库恢复验证。**设备**：Ubuntu 发起，db 容器执行。**前提**：数据库健康、`.env` 正确、备份目录受限、留出足够空间，尽量选择无写入的时间。**重复**：每日、发版前、关键迁移前。

```bash
cd /srv/libevra/deploy
umask 077
mkdir -p backups
chmod 700 backups
df -h / /srv/libevra
docker system df
docker compose -f docker-compose.prod.yml exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT pg_size_pretty(pg_database_size(current_database()));"'
flock -n /srv/libevra/deploy/backups/backup.lock ./backup.sh --keep 7
```

上面的数据库命令只输出库体积，不显示账目和口令。数据库体积不能直接等于备份文件体积；恢复演练还需要临时库、索引及临时文件空间，另有镜像 / 日志增长，不能只留一个 `.dump` 大小的空闲。空间吃紧时先暂停发布并检查，不能赌能写完。

脚本实际步骤：`pg_dump -Fc` 导出自定义格式 → `pg_restore --list` 查看归档目录 → 同一个 PostgreSQL 实例创建 `libevra_verify_…` 临时库 → 真正恢复 → 对代码里列出的业务表比较行数 → 删除临时库 → 按天清理旧 `.dump`。成功应看到导出、恢复和比对通过，退出码为 0。

**现有实现的限制要一起记住：**

- 注释声称预先检查空间，实际没有自动 `df` 守卫，所以前面的手工空间检查不可省。
- `--list` 主要验证归档目录可读，不足以证明整个数据载荷完好；真正恢复更重要。
- 行数比对是固定 20 张业务表，不是动态检查全库；没有比对 `admin_grants`、`admin_allowlist`、`_prisma_migrations`。正常 `pg_dump` 应包含它们，但“脚本绿色”不证明这些表被单独核验。
- 某些查询失败会变成 `missing`；两边同时失败可能被判相等。重要恢复仍应检查表清单、授权与实际业务，不把行数相等当成内容完全一致。
- 源库在导出后继续有写入，稍后比对实时源表可能不一致；先查是否并发变动，不立即认定文件损坏或删掉它。
- 演练在生产实例旁建临时库，会额外使用 CPU / 磁盘，虽不替换真实库，仍会影响资源；应避开高负载，重要灾备还要在独立实例演练。
- `--keep 7` 是按天清理，不是保留最近 7 个文件；`find -mtime` 有整日取整边界。恢复前安全副本也可能被同目录轮转清理，需另存受保护的长期副本。
- `--no-restore-drill` 会跳过恢复演练，不应作为日常默认；它得到的是验证不足的副本。
- 脚本将 `PGPASSWORD` 作为 `env` 参数传给 Docker 执行，仍有本机进程参数可见性问题，和旧注释“不进命令行”不同。本轮不改脚本；不要开启 shell trace、分享进程参数或把调试输出当公共日志。

因此，某次失败时先保留副本和原因，核对数据库状态、剩余空间与临时库清理情况，不为追求绿灯而关闭演练。不要手工删除不确定名称的库。

### 11.3 自动每日备份：先手工成功，再安排定时

目的：减少遗忘。设备：Ubuntu Bash。前提：本账号可无交互运行 Docker、手工备份和恢复演练已成功、备份目录权限正确。重复：首次配置；以后定期查看任务是否真的成功。

```bash
timedatectl
crontab -l
crontab -e
```

`crontab -l` 首次没有任务属正常。先看系统时区；下面的 03:17 是**服务器时区**，不一定是中国时间或本人所在时间。保留其他任务，在编辑器中增加这一行：

```cron
17 3 * * * umask 077; cd /srv/libevra/deploy && /usr/bin/flock -n /srv/libevra/deploy/backups/backup.lock ./backup.sh --keep 7 >> /srv/libevra/deploy/backups/cron.log 2>&1
```

此例要求实际路径吻合、`/usr/bin/flock` 存在、cron 默认 PATH 能找到 Docker；首次安排后核对实际执行。cron 不会自动给你可靠告警，也不会上传异地；锁忙、Docker 不可用、空间不足都可能使任务没完成。次日检查最新文件时间、日志末尾和演练结果，并持续轮转受限日志，不能让 `cron.log` 无限长。不要在任务中写口令、把全环境打印进日志，或让任务遇错自动删卷重建。

### 11.4 异地副本：下载到自己的受保护设备

目的：服务器损坏时还有副本。设备：先在 Ubuntu 查看，再在普通 Windows PowerShell 下载。前提：备份已验证，SSH 可信，目标磁盘有空间并启用可靠的设备保护。重复：每次重要备份后；按策略至少每日有新的异地副本，异地可独立保留约 30 天，实际由本人制定。

**Ubuntu Bash，只列文件并计算所选文件校验值：**

```bash
cd /srv/libevra/deploy
ls -lh backups/*.dump
read -r -p '输入刚验证成功的备份文件名，不含目录：' LIBEVRA_DUMP_NAME
sha256sum "backups/$LIBEVRA_DUMP_NAME"
```

SHA256 用于确认传输前后文件一致，不证明来源可信或备份包含正确业务数据。

**普通 Windows PowerShell，使用同一个文件名：**

```powershell
$libevraSshUser = Read-Host '输入实际 Ubuntu 登录用户名'
$libevraDumpName = Read-Host '输入刚验证成功的完整备份文件名'
if ($libevraDumpName -notmatch '^libevra_prod-\d{8}-\d{6}\.dump$') { throw '请先核对标准备份文件名；不要输入路径或通配符' }
$libevraBackupDir = Join-Path $env:USERPROFILE 'Libevra-Backups'
New-Item -ItemType Directory -Force -Path $libevraBackupDir | Out-Null
scp -i "$env:USERPROFILE\.ssh\libevra_server" "${libevraSshUser}@43.161.227.152:/srv/libevra/deploy/backups/$libevraDumpName" $libevraBackupDir
if ($LASTEXITCODE -ne 0) { throw '传输失败，尚未得到完整异地副本' }
Get-FileHash -Algorithm SHA256 (Join-Path $libevraBackupDir $libevraDumpName)
```

核对输出的 hash 与服务器一致。默认库名不同或要取 `pre-restore` 文件时，应先由本人核对名称和上述校验规则，不能盲目放宽成任意路径。路径也要换成实际部署目录。

私钥仅留在 Windows，传输是加密的，但**落盘的 `.dump` 不是自动加密**。应放本人可访问、启用磁盘加密的存储，或另做经过验证的加密归档，再考虑云盘 / 对象存储；不要上传公开仓库、共享聊天或无保护网盘。异地保留策略不能简单同步删除：服务器误删或被破坏时，不应让异地历史也立即消失。

另外要分别保护 `.env`、云账号恢复方式、Caddy ACME 状态和必要 API 文件；数据库 dump 不包含数据库集群角色、操作系统配置、证书私钥、浏览器未同步数据或所有文件卷。秘密备份另走本人控制的加密存储，不发给 AI；恢复秘密的方法和加密密钥不能只存在那台服务器上。

### 11.5 恢复生产库：这是覆盖，不是查看

**第一层理解**：`restore.sh` 会先导出当前库作安全副本，再停止 API，执行 `dropdb + createdb + pg_restore`，覆盖**整个生产库**，之后重启 API。备份时间以后的服务器数据会丢失，账号、权限、邀请和账本都可能回到旧状态。脚本失败也不会自动恢复原状。

**第二层操作**：只有所有者明确批准了“目标数据库、完整备份路径、备份时间、允许丢失的数据范围、恢复后的兼容代码 / 镜像”才执行。设备为 Ubuntu Bash，重复仅真实灾难恢复需要，**不在生产库练手**。

恢复前依次完成：

1. 暂停用户写入与自动备份任务，保留客户端未同步数据；不要清浏览器数据。恢复后的旧库与客户端待同步修改如何协调，需另行确认，不能盲目让所有设备立即重放。
2. 先在独立隔离环境验证备份能恢复，并确认业务、用户和授权正确；数据库主版本、所需角色与工具兼容。
3. 核对剩余磁盘，保留当前状态的可恢复副本及异地副本。脚本自带安全导出发生在停止 API **之前**，不是自动保证无并发变化的最后快照，故写入静默窗口要先安排。
4. 让部署方选好与恢复目标 Schema 兼容的代码和镜像。脚本末尾 `up -d api` 可能触发 `migrate` 依赖，若仍是新版本会再次应用新迁移；不能只恢复库却忽略代码。
5. 通过备份完整路径、目标库名和时间再次确认；接受维护停机，准备恢复中途失败的处理人。

准备完成后，**由本人逐条执行**：

```bash
cd /srv/libevra/deploy
umask 077
read -r -p '输入已核对并批准恢复的备份绝对路径：' LIBEVRA_RESTORE_FILE
test -f "$LIBEVRA_RESTORE_FILE"
./restore.sh "$LIBEVRA_RESTORE_FILE"
```

`test` 失败就停。脚本显示目标库和文件，并要求本人输入小写 `yes`；这里不提供跳过确认的 `--yes` 作为常规方式。相对路径由脚本切到 `deploy` 后解释，因此使用绝对路径更不容易恢复错文件。

成功后不能只看“API 健康”：检查完整迁移状态、账号 / 管理员双表、账本成员、关键日期交易、金额和业务写入，再建新的验证备份与异地副本，最后恢复定时任务和客户端同步。恢复中断时保留安全副本，查日志和实际库状态；不要连按多次恢复，更不能删除数据卷求重来。

## 12. 常见事故：按从外到内的顺序排查

### 12.1 网站打不开 / 502

**简单理解**：打不开可能卡在 DNS、网络、证书或页面服务；502 通常表示入口代理无法正常取得上游响应，不等于数据库内容丢了。

**实际顺序**：

1. 普通 Windows PowerShell 先查第 5 章 DNS，确认拼写和 IP。
2. 使用第 7 章 `Test-NetConnection` 测 80/443。超时先查实例运行、云防火墙和当前网络；连接拒绝常见于无监听 / 服务未起，仍需实测判断。
3. 能连 443 但证书报错，查域名、系统时间、证书签发日志；不要绕过证书长期使用。
4. Ubuntu 运行 Compose `ps -a`，看 web / api / db 分别状态；查看 `web` 和 `api` 的受限尾部日志。
5. Web 正常但 `/api` 502：查 API 是否启动、健康、监听 `0.0.0.0:3000`，以及是否共用 Compose 网络。不要对公网开放 3000 来绕过 Caddy。
6. API 报数据库连接错误，再按 12.3 查数据库；不要因为 502 先恢复库。

这些均先只读排查，可按需重复。只有定位到具体原因并确认影响，才重启相应服务；不默认重启整台服务器。

### 12.2 容器反复重启、突然变慢或磁盘不足

**Ubuntu Bash，只读检查：**

```bash
cd /srv/libevra/deploy
docker compose -f docker-compose.prod.yml ps -a
docker compose -f docker-compose.prod.yml logs --tail 100 api
docker stats --no-stream
df -h
free -h
docker system df
sudo journalctl -k --since '1 hour ago' --no-pager
```

看退出时间、错误信息、内存和空间；内核日志中若有 Out of memory / Killed process，才有 OOM 证据。日志中有敏感字段先脱敏再分享。Caddy 设 ERROR 日志等级并不等于 Docker 日志大小受限，当前不能假定已配置日志轮转；需部署方确认。

磁盘满时暂停发布和大导入，确认占用来源；先确保异地备份有效，人工保留必要恢复点，再按批准策略处理旧备份和确认不用的构建缓存。不要删数据库目录、卷、唯一备份或不明容器。清理和日志轮转属于变更，不是这几条只读命令已经完成的工作。

### 12.3 数据库无法连接

顺序：db 容器是否运行且 healthy → db 日志是否显示磁盘 / 权限 / 恢复问题 → API 配置主机是否为 `db` → 口令是否与**当前已初始化数据库**一致 → 迁移状态。

**容器内执行，由 Ubuntu 发起：**

```bash
cd /srv/libevra/deploy
docker compose -f docker-compose.prod.yml logs --tail 80 db
docker compose -f docker-compose.prod.yml exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose -f docker-compose.prod.yml exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1;"'
```

预期本地连接返回接受连接、查询返回 `1`。这仅证明容器内本地连接，不保证 API 的网络认证；如本地可用但 API 失败，继续查服务网络、URL 和真实口令匹配。不要为方便排查开放公网 5432，也不要在命令行打印完整 URL、修改密码后删卷。

### 12.4 HTTPS 证书申请或续期失败

顺序：主域名 DNS 与可能存在的 AAAA → 80/443 云防火墙和监听 → Caddy 实际配置校验 → `web` 日志 → 系统时间 → 出站 DNS / HTTPS 与证书机构可达性 → 磁盘与 Caddy 数据卷 → 是否触发申请频率限制。

在浏览器站点信息里看证书域名、颁发者、有效期。对只读终端核查，也可在 Ubuntu 使用系统已有 OpenSSL：

```bash
date -Is
openssl s_client -connect libevra.com:443 -servername libevra.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

只查看公共证书，不读取私钥。命令失败不能被当作有效期正常；再查网络与日志。不要反复删除 `caddy-data` 强迫重签，也不要关闭 HTTPS 作为长期解决方案。可在独立外部监测上设置临近到期 / 连通性告警，最终是否已配置需部署交付记录证明。

### 12.5 SSH 无法登录

先看错误类型：

| 现象 | 排查顺序 |
|---|---|
| Timeout | 本机网络 → 腾讯云实例运行 → 22 云防火墙来源 IP → UFW / ssh 监听；必要时 VNC |
| Connection refused | 实例与 IP → ssh 服务 / 端口监听 → 是否换了端口；不要直接换私钥 |
| Permission denied | 用户名 → `-i` 私钥路径 → Agent 中身份 → 服务器目标用户公钥和权限，见第 13 章 |
| Host identification changed | 独立核对主机身份和是否重装，不先清 known_hosts |

**普通 Windows PowerShell：**

```powershell
Test-NetConnection 43.161.227.152 -Port 22
Get-Service ssh-agent
ssh-add -l
```

**腾讯云 VNC 登录后的 Ubuntu Bash：**

```bash
sudo systemctl status ssh --no-pager
sudo ss -tlnp
sudo ufw status verbose
```

上述只读检查不能修复身份错误；按发现的原因由本人修改。不要把私钥放进服务器来“让它认识这把钥匙”，也不要为解决登录问题开放所有端口。

### 12.6 更新后页面仍旧或数据看起来不一致

先比对运行镜像、目标提交、浏览器“软件更新”版本与来源域名，确认是否实际交付新构建。核对同步状态与选中的当前账本，不把切错账本判为数据库丢失。浏览器缓存、Service Worker 和 IndexedDB 是不同东西；**不能默认清空网站数据排错**，尤其存在未同步变更时。先保存必要证据，再由部署方采取最小化更新 / 修复。

## 13. 我们真实遇到的五类错误

### 案例 1：在 Ubuntu 输入了 Windows PowerShell 命令

**现象**：在 Ubuntu 执行包含 `$env:USERPROFILE` 的命令，路径解析错误或找不到密钥。

**原因**：PowerShell 用 `$env:USERPROFILE` 读取 Windows 用户目录，Bash 不认识这种环境变量语法；而 Windows 私钥也没有必要存在服务器上。

**处理**：若要从 Windows 登录，输入 `exit` 回到 `PS …>` 再执行第 3.2 节。若在 Ubuntu 操作其本地文件，用 Linux 路径，例如 `~/.ssh/authorized_keys`。不要把命令中变量简单换成 Linux 路径后把私钥上传。

**成功标志**：Windows 发起连接，登录后再运行 Linux 命令；两种终端各做自己的事。

### 案例 2：私钥有密码短语，AI 无法非交互登录

**现象**：本人可以输入 passphrase 登录，无交互代理却失败或等待输入。

**原因**：加密私钥需要解锁，这正是保护作用。不能为方便把密码短语写到脚本、环境变量或发给 AI，也不能默认删除密码短语。

**处理**：本人在普通 Windows PowerShell 运行 `ssh-add`，在自己的终端解锁，按第 3.4 节核对指纹。AI 使用的是已授权客户端能够调用的身份；若它运行在另一用户、WSL 或独立隔离环境，不一定能访问这个 Agent，需要先核对环境，而不是反复输秘密。

**成功标志**：同一用户的 SSH 不再重复询问私钥密码短语且能登录；服务器写操作仍按本人批准范围执行。

### 案例 3：`ssh-add` 报 `Error connecting to agent`

**原因**：Agent 服务未运行、启动方式未设置，或使用了另一套 OpenSSH / 另一个用户的 Agent。

**处理顺序**：普通窗口查看 `Get-Service ssh-agent` → 管理员窗口按第 3.4 节设置 / 启动 → 回普通窗口确认工具来源 → `ssh-add` 加入目标私钥 → `ssh-add -l` 对指纹。若是访问被拒绝，先确认管理员窗口和当前用户，不开启 Windows 的 SSH **服务器** `sshd` 来解决客户端 Agent 问题。

**成功标志**：服务 Running，身份列表存在对应钥匙，实际 SSH 登录成功。仅服务 Running 不够。

### 案例 4：`Permission denied (publickey,password)`

该提示说明认证没通过，不等于 TCP 22 不通。按顺序确认：

1. 登录目标是否正确：公网 IP、Linux 用户名；`ubuntu` / `root` / 自建运维用户不能混用。
2. `Test-Path` 是否能找到指定私钥；不要把 `.pub` 当成 `-i` 的私钥文件。
3. `ssh-add -l` 的指纹是否与本机 `.pub` 一致，Agent 是否在同一用户环境。
4. 通过已存在的可信连接或 VNC，确认公钥安装在**那个 Linux 用户**的 `authorized_keys`，一把钥匙完整一行，未粘进私钥段落。
5. 检查文件所有者是目标用户、目录 `700`、文件 `600`，目标账号是否可用、SSH 服务配置是否允许对应认证。

修改权限前先看 `ls -ld ~/.ssh` 和 `ls -l ~/.ssh/authorized_keys`；不要把整个目录变成 `777`。如需更详细 SSH 诊断，先由本人检查并脱敏，不把密钥路径、用户、认证细节及其他私密信息原样发公共日志。使用已知有效密钥在新窗口验证后，才关闭备用连接。

### 案例 5：DNS 正确，网页却打不开

DNS 只处理名字。用第 7 章命令分别看：A 记录正确吗 → TCP 80/443 通吗 → Caddy 容器启动并有匹配域名吗 → 证书能校验吗 → `/healthz` 是否正常 → `/api/v1/health` 数据库是否 up → 浏览器业务是否正常。

我们另有 `www` 拼写不匹配的观测，即使修正 DNS，当前 Caddy 也不自动支持 `www`。排查时固定使用主域名 `libevra.com`，不能把两种域名的不同结果混在一起。不要为了打开页面向公网暴露 PostgreSQL。

## 14. 以后照着用的维护清单

| 频率 / 时机 | 做什么 | 成功证据 |
|---|---|---|
| 每天或由可靠告警覆盖 | 外部 HTTPS、API 健康；最近备份和异地副本 | 不仅任务存在，还要最近一次成功时间、校验和与验证结果 |
| 每次发布前 | 确定 commit、CI、干净工作区、迁移风险、资源、验证备份和上一版 | 有可追溯记录，遇到任何失败停止 |
| 每次发布后 | HTTPS、运行镜像、界面版本、登录与记账同步 | 真正业务验收；不以内部健康检查单独宣布完成 |
| 每周 | 磁盘、Docker 空间、内存、错误日志、系统待更新、备份轮转 | 增长趋势受控；维护窗口处理更新，不无人值守重启 |
| 每月及重大变更后 | 独立环境恢复演练、证书期限与告警测试、SSH / 管理员授权核对 | 恢复后实际业务可用；本人仍掌握备用登录与秘密恢复方式 |
| 到期前 | 云服务器续费、域名续费与联系邮箱有效性 | 账单与控制台状态；不要只依赖某一封通知 |

一份最小发布记录可以只写以下内容，**不含秘密**：

```text
时间及服务器时区：
操作者与批准人：
真实部署目录 / Compose 项目名：
上一提交 / 上一应用版本 / 上一镜像 ID：
目标完整提交 / 目标应用版本 / 实际镜像 ID：
CI 运行链接与对应提交：
迁移文件与兼容性结论：
发布前备份路径、时间、验证结果、异地副本：
外部 HTTPS / API / 浏览器业务验收：
回滚办法与允许的数据损失范围：
遗留问题、下一次检查人及日期：
```

遇到以下情况先停止依赖操作：目标库不确定、备份失败、磁盘不足、迁移失败、未提交变更来源不明、SSH 主机指纹变化、另一位代理正在发布、恢复会覆盖本人未批准的数据。先说明确切阻碍，再由所有者决定下一步，不用大范围清理来“恢复干净”。

## 15. 与旧文档的差异、后续怎样更新本教程

本轮只新增这一份教程；**没有改代码、部署配置、索引、历史日志或程序版本**。原文档仍保留审计时事实。以下为截至编写时的勘误和解释，不代表替部署方宣布上线完成：

| 旧说法 / 容易误读之处 | 本教程采用的准确边界 |
|---|---|
| 服务器 / 域名尚未确认、按 2 GB 估计 | 所有者现已提供 2 核 / 8 GB / 80 GB 与 `libevra.com`；当下负载仍待验收 |
| S12-A 配置“从未运行”可以代表今天 | 它描述 S12-A 当时；S12-B 现由 DeepSeek 部署，本轮不独立宣称完成 |
| Prisma 文件缺失仍是未改的 blocker | 当前工作区已有复制 Schema、config、migrations 等修订；需要构建与生产迁移结果确认，不重复宣称仍未修复 |
| 空邮箱直接进入 Caddy `email` 行 | 当前已有模板与入口脚本的条件生成机制，应分别验证模板与实际配置 |
| 加 Swap 后不会 OOM | Swap 只能缓解，仍需测量和监控 |
| 配置 ACME 邮箱就有到期邮件 | Let's Encrypt 已停止该通知，需主动监测 |
| 日志等级 ERROR 就是日志大小受限 | 不等于大小轮转，需另查 Docker 日志策略 |
| `--version` 选择发布代码、失败自动回滚 | 均不成立，Git、镜像、迁移和人工处置必须明确 |
| 普通首个邀请码足以建立管理员 | 要核对预留编号资格，再执行独立授权与允许名单两步 |
| `backup.sh` 预查磁盘、核对全库全部表 | 实际无空间守卫，固定表列表有遗漏；不能把脚本打印当作完整灾备证明 |
| `restore.sh` 只是重建，不删除 | 重建包含 `dropdb`，会覆盖整个库；且安全导出前不自动暂停写入 |
| 未发布端口的服务绝对不可访问 | 不直接向公网发布，但主机 / Docker 管理者仍有高权限；UFW 也不能单独保证 Docker 暴露策略 |
| 把 `/srv` 整体改给部署用户 | 只在首次创建具体项目目录时设置该目录的所有者 |

原记录中的测试数量、开发库账号、旧凭据事件、备案说法和完成状态均有时间及环境边界。涉及法律适用或备案义务，应由所有者结合实际服务与辖区另行向主管部门 / 云服务商确认，不能把早期计划直接当成法律结论。

部署完成后，可由所有者把第 1 章的“待验收”按**真实证据**更新，并补充实际目录、提交和部署方修订结果。不要填入真实密码、私钥、邀请码、恢复码或完整环境文件；也不要把本轮的文档静态检查改写成“服务器测试通过”。

### 相关项目材料

- [S12-A 上线前安全与发布准备](S12-A上线前安全与发布准备.md)：审计与历史验证边界。
- [交接入口](交接.md)、[开发日志](DEVLOG.md)：背景与历史，读时注意日期。
- [管理员与权限边界](管理员与权限边界-设计决定.md)：资格、授权、允许名单、账本权限相互独立。
- [品牌迁移记录](Libevra品牌迁移记录.md)：产品名是 Libevra；`@libellum/*`、部分环境变量、存储和 Cookie 标识有意保留，不随教程更名。
- [部署 README](../deploy/README.md)、[Compose](../deploy/docker-compose.prod.yml)、[API 镜像](../deploy/Dockerfile.api)、[Web 镜像](../deploy/Dockerfile.web)。
- [Caddy 模板](../deploy/Caddyfile)、[Web 启动脚本](../deploy/web-entrypoint.sh)、[pnpm 工作区配置](../pnpm-workspace.yaml)、[环境模板](../deploy/.env.production.example)。
- [发布脚本](../deploy/deploy.sh)、[备份脚本](../deploy/backup.sh)、[恢复脚本](../deploy/restore.sh)：以执行代码为准，注意注释与行为可能不一致。

外部操作步骤所依据的官方文档链接已放在对应章节。云控制台界面、依赖版本或配置变动后，应重新核对后再操作，不把本教程当成永远适用的一键脚本。

### 本教程的本地检查记录（2026-10-16）

- `pnpm check:docs` 通过：项目相对链接和已有文档审计检查通过。该工具不检查外链可达性或部署是否成功。
- 36 个 Bash 代码块通过 Git Bash 的 `bash -n`；11 个 PowerShell 代码块通过 PowerShell 语法解析；内嵌 Python 生成器通过 AST 语法解析。**这些只解析文本，没有执行教程中的安装、SSH、数据库或发布命令。**
- Markdown 围栏成对，文档未包含真实私钥或生产凭据。命令内容经过静态核对，仍待部署方在相应系统逐步验证运行效果。
- 本轮没有 Linux / Docker 运行验收、远程数据库验证或浏览器业务验收；这些必须由实际部署交付记录补齐。

