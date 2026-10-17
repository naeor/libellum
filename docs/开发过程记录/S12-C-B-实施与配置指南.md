# S12-C-B · 自动备份 · 实施与配置指南

> **状态（2026-10-17）：代码与测试完成，配置与启用尚未做。**
> 本文件是**逐项操作指南**：你按它开通 COS / Resend / Healthchecks.io，
> 我负责服务器侧接入与真实验证。
>
> 关联：[`S12-C-自动备份-审计与设计.md`](S12-C-自动备份-审计与设计.md)（阶段一审计）、
> [`部署记录-S12-B.md`](部署记录-S12-B.md)、[`生产环境与运维手册.md`](../生产环境与运维手册.md) §15

---

## 0. 现在的状态（已实测 / 待配置 / 待启用）

| 能力 | 状态 |
|---|---|
| 本地备份 + **隔离恢复演练（动态取 23 张表）** | ✅ **已实测**（2026-10-17，逐表一致） |
| 本地轮转（7 天、永不删最新 3 份） | ✅ 已实测（删除 0 个） |
| AES-256 加密（gpg 2.4.4，带 MDC 完整性校验） | ✅ 已实测（往返一致、错口令被拒） |
| 状态文件 `last-local.json` / `last-run.json` | ✅ 已实测（失败路径也验证过） |
| 失败退出码、状态记录、告警"未启用"如实报告 | ✅ 已实测（假凭据测试，退出码 1） |
| 备份脚本自动测试（28 项） | ✅ 本地通过，已接入 CI |
| 上传身份最小权限 | ⏳ **待你在 CAM 配置** |
| COS 上传 / 远端元数据校验 | ⏳ **待配置**（代码已就绪） |
| 邮件告警（Resend） | ⏳ **待你开通 + 真实收件测试** |
| 外部心跳（Healthchecks.io） | ⏳ **待你开通 + 真实"没心跳"测试** |
| 月度异地内容演练 | ⏳ 脚本已就绪，待恢复身份 |
| systemd timer | ⏳ **已写好，未安装、未启用** |

**⚠️ 不要把它描述成"已上线"。现在只有本地备份这一层是真实可用的。**

---

## 1. COS（腾讯云对象存储）

'> **⚠️ 一次只做一个平台。** 顺序：**COS → 邮件 → 心跳**。
> 每个平台做完告诉我，我验证完再给下一个的教程。不要三个一起弄 ——
> 同时改三个地方，出问题时无法判断是哪一处。

### 1.1 ⚠️ 先确认对象锁定资格（这一步我没法替你查）'

腾讯云 COS 的**对象锁定（WORM / 合规保留）**通常**需要申请白名单**才能在控制台开启。
**我无法确认你的账号是否有资格** —— 请在控制台或问客服确认：

> 问题模板：「COS 对象锁定（合规保留策略）是否对我的账号开放？需要申请吗？香港地域支持吗？最短保留期是多少？」

| 结果 | 方案 |
|---|---|
| **有资格** | 开 **32 天对象锁定**（最强：保留期内连主账号都删不掉） |
| **没资格** | **不要因此卡住整个项目**：用「版本控制 + 只写不删的子账号 + 生命周期」作为第一阶段方案（见 1.4） |

**⚠️ 即使有对象锁定，也仍然需要版本控制**（锁定要求先开版本控制）。

### 1.2 建桶

控制台 → 对象存储 COS → 存储桶列表 → 创建存储桶：

| 项 | 值 |
|---|---|
| 名称 | `libevra-backup`（完整名会变成 `libevra-backup-<APPID>`） |
| 地域 | **中国香港 ap-hongkong** |
| 访问权限 | **私有读写** |
| 版本控制 | **开启** |
| 服务端加密 | 可选（SSE-COS，免费，建议开） |
| 对象锁定 | 若 1.1 确认有资格 → 开启，保留 **32 天** |

建完后记下 **APPID**（控制台右上角账号信息里那串数字），桶名是 `libevra-backup-<APPID>`。

### 1.3 两个子账号（访问管理 CAM）

#### 身份 A：日常上传（**放在服务器**）

新建用户 → 自定义创建 → **编程访问**（会生成 SecretId/SecretKey）→ **不加入任何用户组** →
**自定义策略**（不要用预设策略），策略 JSON：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "cos:PutObject",
        "cos:HeadObject",
        "cos:InitiateMultipartUpload",
        "cos:UploadPart",
        "cos:CompleteMultipartUpload",
        "cos:AbortMultipartUpload",
        "cos:ListParts"
      ],
      "resource": [
        "qcs::cos:ap-hongkong:uid/<APPID>:libevra-backup-<APPID>/daily/*",
        "qcs::cos:ap-hongkong:uid/<APPID>:libevra-backup-<APPID>/baseline/*"
      ]
    }
  ]
}
```

**⚠️ 为什么是这几个（不是猜的，是抓包实测的）**：
用本地 mock S3 端点抓 rclone 的真实请求，`rclone copyto` 上传时依次发：

```
HEAD  /bucket/daily/…/x.dump.gpg     ← 需要 HeadObject（检查是否已存在）
PUT   /bucket/daily/…/x.dump.gpg     ← 需要 PutObject
HEAD  /bucket/daily/…/x.dump.gpg     ← 需要 HeadObject（校验大小）
（仅当传输大小不符时）DELETE …       ← 我们**不给** DeleteObject，所以这种情况只会报错、不会清掉对象
```

**⚠️ 刻意不给的**：`GetObject`（读内容）、`GetBucket`（列对象）、`DeleteObject`、
`DeleteMultipleObjects`、`PutBucket*`、`DeleteBucket*`、任何服务器/CAM 权限。
**⚠️ 由此带来的取舍**：上传身份**无法把文件下载回来比对内容**，所以日常只做
"对象存在 + 大小一致"的元数据校验；内容级验证交给恢复身份（月度演练）。

#### 身份 B：灾难恢复（**不放在服务器**）

新建另一个子账号，自定义策略：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": ["cos:GetObject", "cos:HeadObject", "cos:GetBucket"],
      "resource": [
        "qcs::cos:ap-hongkong:uid/<APPID>:libevra-backup-<APPID>/daily/*",
        "qcs::cos:ap-hongkong:uid/<APPID>:libevra-backup-<APPID>/baseline/*",
        "qcs::cos:ap-hongkong:uid/<APPID>:libevra-backup-<APPID>/"
      ]
    }
  ]
}
```

**⚠️ 恢复身份的密钥只保存在你这里**（本机敏感信息目录 + 密码管理器），
**不放到生产服务器**。需要恢复时，在你自己的电脑上设置环境变量后再跑脚本。

**⚠️ 两个身份的密钥必须分开**，脚本会拒绝"恢复身份 = 上传身份"这种偷懒配置。

### 1.4 生命周期规则（保留与成本）

桶 → 生命周期 → 添加规则：

| 项 | 值 |
|---|---|
| 前缀 | `daily/` |
| 对象过期删除 | **35 天**（保留目标 ≥30 天，留 5 天缓冲） |
| **删除非当前版本** | **30 天**（配合版本控制） |
| 未完成分片上传清理 | **3 天**（rclone 中断会留下分片，不清理会悄悄产生存储费） |

**再加一条规则**（前缀 `baseline/`）：

| 项 | 值 |
|---|---|
| 对象过期删除 | **400 天**（约 13 个月） |
| 未完成分片上传清理 | **3 天** |

### 1.4.1 ⚠️ 为什需要 `baseline/`：连续失败 35 天会让 `daily/` 全部消失

`daily/` 的生命周期是**按对象创建时间**算的，与"备份是否成功"无关。
如果连续 35 天备份都失败，`daily/` 会被**全部清空**，而那 35 天里没有任何新备份可以替换它们 ——
结果就是**异地一份都没有了**。

**基准备份（简单可靠）**：

* 每个自然月（**香港时间**）**第一次成功备份**时，额外上传一份到 `baseline/YYYY-MM/`；
* 名称带时间戳 + 随机后缀，**绝不覆盖**；上传后立刻 `HeadObject` 校验大小；
* `baseline/` 生命周期 **400 天** —— 即使 `daily/` 全空，也**永远有一年内的基线**；
* 基准备份失败**不让整次备份失败**（daily 已成功），但会记录 `baselineMonth`/`baselineRef` 为空，
  **不谎称有基线**；
* 成本：约 40 KB × 12 ≈ **0.5 MB/年**，可忽略。

**⚠️ 已核实的版本控制/删除标记/生命周期关系**：

- 开版本控制后，**删除对象只是加一个"删除标记"**，旧版本仍在 → 能防误删；
- 但**主账号**可以"彻底删除指定版本"或删整个桶 → **历史版本会真的消失**；
  只有**对象锁定**能挡住主账号。所以：**主账号必须开 MFA**（见 1.5）；
- 生命周期按**对象创建时间**算，35 天 > 30 天保留目标 → 不会提前删有效备份；
- **非当前版本**单独设 30 天，不会被"当前版本过期"连带提前删；
- ⚠️ 生命周期规则本身由主账号管理 —— 有人改成"1 天删除"就会清空。**对象锁定是唯一的技术防线**。

### 1.5 主账号保护（当前设计挡不住的操作）

| 风险 | 缓解 |
|---|---|
| 主账号被盗后删桶/关版本控制/改生命周期 | **开 MFA**；不把主账号密钥放到任何服务器；只用子账号 |
| 子账号密钥泄露 | 无法删除、无法读取、无法改桶配置 → 影响面只剩"占空间"，而生命周期会清理 |
| 误把生命周期改成 1 天 | 对象锁定（若可用）或定期核对桶配置 |

### 1.6 费用与预算提醒

**估算**（香港标准存储，数据约 1.4 MB / 35 天，加历史版本约 2 MB）：

| 计费项 | 用量/月 | 估算 |
|---|---|---|
| 标准存储 | ~2 MB | **¥0.001 以内** |
| 请求（PUT/HEAD） | ~100 次 | **¥0.0001 以内** |
| 恢复流量（月度演练） | ~2 MB | **¥0.001 以内** |
| **合计** | | **≈ ¥0/月；最坏 < ¥1/月** |

**⚠️ 以控制台账单为准。设置预算提醒（强烈建议）**：

控制台 → **费用中心 → 预算管理 → 新建预算**：
- 预算类型：**每月固定预算**
- 金额：**¥5**
- 提醒阈值：**50% / 80% / 100%**
- 接收人：你的邮箱/微信

这样即使哪天忘了关、数据量涨了、或有人恶意上传，**你会先收到预算提醒**，而不是收到一张大账单。

**⚠️ 必须说清楚：预算提醒只是"费用通知"，不是"硬性费用上限"。**
腾讯云不会因为你设了 ¥5 预算就自动停止计费或封停服务 —— 提醒响了，钱还是照扣。
真正能兜住成本的是：正确的生命周期规则、不被盗用的子账号、以及你看到提醒后的处理。

**⚠️ 三个容易忽略的费用点**：① 未完成分片上传会持续计费（生命周期 3 天清理）；
② 历史版本也占存储；③ 外网**下载**流量收费（上传免费），所以别频繁下载大备份。

---

## 2. 邮件告警（Resend 免费套餐）

'**为什么选它**：HTTPS API（不用自建 SMTP）、免费 3,000 封/月（我们一个月最多几封）、
域名级 DKIM/SPF、API 一行 curl 可发、将来做邮箱验证码可复用同一套域名与 API。

**⚠️ 用独立子域名 `send.libevra.com`，不要用主域名 `libevra.com`。** 理由：
① 发信相关的 MX/SPF 记录只落在子域，**不影响主站的邮件配置与其他邮件服务**；
② 将来换服务商或同时用两家（告警 + 验证码），只需换子域，主域不动；
③ 发信声誉风险（万一被判垃圾邮件）被隔离在子域里，不牵连主域。
教程里 Resend 显示的记录会以 `send` 为主机前缀，加到 Namecheap 即可。'

### 2.1 开通步骤（零基础）

1. 打开 <https://resend.com> → **Sign Up**（用你日常收信的邮箱）
2. 登录后 **API Keys → Create API Key**：名字 `libevra-backup`，权限选 **Sending access**（只发信）
3. **复制 key（`re_` 开头）** —— 只显示一次
4. **Domains → Add Domain**：填 **`send.libevra.com`**（独立发送子域名，见下）
5. Resend 会给出几条 **DNS 记录**（在 Namecheap 添加，见 2.2）
6. 等状态变成 **Verified**

**⚠️ 不要把 API Key 贴到聊天里。** 请写到：
`Documents\Libevra-敏感信息（勿上传）\resend-api-key.txt`
写完告诉我，我用 `scp` 传到服务器 `deploy/.backup-mail.env`（600）。

### 2.2 DNS 记录（Namecheap → Advanced DNS）

Resend 会给出具体值，通常是：

| 类型 | 主机 | 值 | 用途 |
|---|---|---|---|
| TXT | `resend._domainkey` | `p=MIGfMA0…` | **DKIM** 签名 |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | **SPF**（Resend 的子域） |
| MX | `send` | `feedback-smtp.us-east-1.amazonses.com` (优先级 10) | 退信处理 |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:<你的邮箱>` | **DMARC**（先观察模式） |

**⚠️ DMARC 先 `p=none`**，确认能正常收信后再考虑收紧；一上来 `p=reject` 可能把自己告警信拦掉。

### 2.3 服务器配置（我做）

`deploy/.backup-mail.env`（600、不进仓库）：

```
MAIL_API_KEY=re_xxxxxxxx
MAIL_TO=你的日常邮箱
MAIL_FROM="Libevra 备份 <backup@libevra.com>"
```

**⚠️ `MAIL_FROM` 必须加引号** —— 里面有空格和尖括号，不加引号 shell 会解析错（这个坑在自测里踩过）。
发件地址必须是已验证域名下的地址。

### 2.4 真实验证（我做，步骤写在这里）

```bash
./deploy/alert-mail.sh --test          # 发一封测试邮件
```

然后**你去收件箱确认**（含垃圾箱）。只有你确认收到，才能说"邮件告警可用"。
API 返回 200 只代表"服务商接受"，**不代表你收到**。

---

## 3. 外部心跳（Healthchecks.io 免费套餐）

**为什么需要**：服务器彻底失效（断电/断网/实例被删/定时器没启动）时，
服务器上的脚本没法报告任何东西 —— 而"什么都没发生"和"一切都好"看起来一样。

### 3.1 开通步骤

1. 打开 <https://healthchecks.io> → 注册（免费：20 个 check）
2. **Create Check**：
   - Name：`Libevra 备份`
   - **Period：1 day**（每天一次）
   - **Grace Time：2 hours**（备份 03:00 开始，正常 3 分钟内结束；05:00 前没收到就是异常）
   - **Schedule：按 systemd 的 OnCalendar 对齐** —— 选 **"Simple: every 1 day"**，
     并把 **Starting at 03:00（时区选 Asia/Hong_Kong）** 填上；这样监测服务按同样节奏期待心跳
   - **Integrations：Email**（填你的日常邮箱）
3. 复制 **Ping URL**（`https://hc-ping.com/<uuid>`）
4. 写到 `Documents\Libevra-敏感信息（勿上传）\healthchecks-ping-url.txt`

**⚠️ 这个 UUID 等同于"可以伪造心跳"的凭据** —— 不进 GitHub、不贴聊天。

### 3.2 服务器配置（我做）

`deploy/.backup-heartbeat.env`（600）：

```
HEARTBEAT_URL=https://hc-ping.com/<uuid>
```

### 3.3 心跳规则（已实现）

| 情况 | 行为 |
|---|---|
| 整条流程全部成功 | `GET <url>` → 记录 `heartbeat.ok=true` |
| 任一阶段失败 | `GET <url>/fail` → 外部**立即**发邮件（不等宽限期） |
| 心跳发送失败 | 不影响备份结论，但记录 `heartbeat.ok=false`，并在下一条告警正文里体现 |
| 备份从未运行 | 外部服务在 **03:00 + 2 小时**后发邮件 |

### 3.4 ⚠️ "没收到心跳"的**真实**测试（检查点 C 必做，不能作弊）

**不合格的测试**：在面板上暂停 check、或用错误 UUID —— 那只是"人为让服务不响"，不能证明链路。

**合格测试（我会做，需要你在场确认收信）**：

1. 确认当前心跳正常（面板显示 "Up"）。
2. **在服务器上真实地让备份流程不发送心跳**：`./backup-all.sh --skip-heartbeat --skip-notify`
   （模拟"脚本跑了但没送心跳"→ 等价于"脚本根本没跑"）。
3. 等宽限期过去（2 小时）→ **Healthchecks.io 自己发邮件**。
4. 你去收件箱确认收到，并**把邮件原文（去掉个人信息）**留档。
5. 恢复：手动跑一次完整备份发成功心跳 → 面板回到 "Up"。

'**✅ 不用等两小时**：检查点 C 会用**一个临时短周期 Check** 来测：
在 Healthchecks.io 里另建一个 `Libevra 失联测试`（Period **5 分钟**、Grace **1 分钟**、
邮件通知同一个邮箱），把服务器的 `HEARTBEAT_URL` **临时**指向它，
然后跑一次**不发心跳**的备份（`--skip-heartbeat`），等约 **7 分钟** → 外部服务发邮件。
确认收到后，把 `HEARTBEAT_URL` 换回正式 check，并删除临时 check。
**这仍然是"外部服务因为我们没发成功心跳而发信"的真实链路测试**，不是伪造。'

---

## 4. 日常状态怎么读

```bash
cat /srv/libevra/deploy/backups/last-run.json     # 全量状态（schemaVersion 2）
cat /srv/libevra/deploy/backups/last-local.json   # 本地备份细节 + 每张表行数
cat /srv/libevra/deploy/backups/alert-state.json  # 告警去重状态
cat /srv/libevra/deploy/backups/heartbeat-state.json
journalctl -u libevra-backup -n 100 --no-pager
```

`last-run.json` 里分开记的几件事（**不是一个"备份成功"布尔值**）：

| 字段 | 含义 |
|---|---|
| `local.localOk` | 本地导出成功 |
| `local.restoreOk` | 隔离恢复演练通过 |
| `encryptOk` | 加密成功 |
| `offsite.uploadOk` | 上传成功 |
| `offsite.remoteMetaOk` | 远端对象存在且大小一致 |
| `offsite.contentVerified` | **内容级验证**（月度演练才有，日常恒为 `false`） |
| `heartbeat.ok` | 外部心跳是否送出 |
| `notify.ok` | 失败告警是否被服务商接受 |

---

## 5. 月度异地演练（每月一次，**在你自己的电脑/临时机器上**）

```bash
# 1. 恢复身份（只在你这台机器上，临时）
export COS_RESTORE_ID=...
export COS_RESTORE_KEY=...
export COS_BUCKET=libevra-backup-<APPID>

# 2. 取回 + 解密
./deploy/offsite-fetch.sh --latest

# 3. 隔离恢复验证（需要一个独立的 PostgreSQL，绝不能指向生产）
./deploy/verify-dump.sh deploy/backups/restored/<name>.dump \
    --expect deploy/backups/last-local.json
```

**⚠️ `monthly-offsite-drill.sh` 会拒绝在 `POSTGRES_DB=libevra_prod` 的环境里运行。**

---

## 6. 启用定时任务（**检查点 D，需所有者再次批准**）

```bash
sudo cp deploy/systemd/libevra-backup.service /etc/systemd/system/
sudo cp deploy/systemd/libevra-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now libevra-backup.timer
systemctl list-timers libevra-backup.timer --no-pager
```

- 时间：**每天 03:00 Asia/Hong_Kong**（`OnCalendar` 带时区，**不改系统时区**）
- `Persistent=true`：关机错过会在开机后补跑一次
- `flock`：防手动与定时重叠
- 超时 `TimeoutStartSec=1h`
- 低优先级 IO（不影响网站）

**暂停 / 恢复**：

```bash
sudo systemctl stop libevra-backup.timer     # 暂停自动备份
sudo systemctl start libevra-backup.timer    # 恢复
```

---

## 7. 灾难恢复（服务器整机丢失）

```
① 新开空服务器（Ubuntu 24.04）+ 装 Docker
② 取回部署代码：GitHub 同一个 commit（git archive；**服务器不放 GitHub 凭据**）
③ 恢复 deploy/.env —— 它不在任何备份里，**必须你另行保存**
④ 恢复身份：export COS_RESTORE_*，运行 offsite-fetch.sh --latest
⑤ 解密后的 dump：./verify-dump.sh <dump>     ← 先证明它能恢复
⑥ 起空 db 容器 → ./restore.sh <dump> --yes   ← 人工确认后才执行
⑦ 起 api/web → /api/v1/health；登录检查账目
```

---

'## 8. ⚠️ mock 测试 ≠ 真实云端验收

`deploy/tests/run.sh` 用假 curl 和本地 mock S3，验证的是**脚本的决策逻辑**
（该发邮件时发、不该发时不刷屏、URL 对不对、危险操作会不会被拒绝）。
**它不能证明腾讯云上的权限真的按预期生效。** 检查点 C 必须在**真实桶**里逐条验：

| # | 真实验收项 | 怎么做 | 期望 |
|---|---|---|---|
| 1 | 上传成功 | 完整跑一次 `backup-all.sh` | `uploadOk=true`，桶里出现 `daily/…` |
| 2 | HeadObject 可用 | 同上（脚本已调用） | `remoteMetaOk=true`，大小一致 |
| 3 | **上传身份读不了内容** | 用上传凭据跑 `rclone copyto cos:… /tmp/x` | **失败**（AccessDenied） |
| 4 | **上传身份删不掉** | 用上传凭据跑 `rclone deletefile cos:…` | **失败**（AccessDenied） |
| 5 | **上传身份列不了目录** | 用上传凭据跑 `rclone lsf cos:bucket/daily/` | **失败**（AccessDenied） |
| 6 | 上传身份改不了桶配置 | 尝试 `PutBucketVersioning` 等（用 rclone 无法直接做，以 CAM 策略为准） | 无权限 |
| 7 | **恢复身份能读** | 用恢复凭据 `lsf` + `copyto` 下载 | 成功 |
| 8 | **恢复身份不能写** | 用恢复凭据 `copyto` 上传一个小文件 | **失败**（AccessDenied） |
| 9 | **恢复身份不能删** | 用恢复凭据 `deletefile` | **失败** |
| 10 | 基准备份 | 看桶里 `baseline/YYYY-MM/` 是否存在且大小一致 | 存在其一 |
| 11 | 生命周期不会提前删 | 控制台核对规则：daily 35 天 / baseline 400 天 / 分片 3 天 | 与文档一致 |

**任何一项不符合，先报告，不自行扩大权限。**

## 9. 仍然存在的风险（诚实清单）'

| # | 风险 | 现状 |
|---|---|---|
| 1 | 主账号误删/被盗 | 子账号可挡，主账号挡不住；缓解=**MFA**；对象锁定若可用则是技术防线 |
| 2 | 加密口令在服务器上 | 全自动加密必然如此；缓解=600 权限 + 最小暴露 + 本机副本 |
| 3 | 邮件"已送达"无法从 API 证明 | 只能靠真实收件确认（检查点 C） |
| 4 | 心跳服务自身故障 | 不套娃；接受 |
| 5 | 月度演练需你动手 | 定每月一次，需人工执行 |
| 6 | 异地内容验证不是每天做 | 日常只有元数据校验（上传身份无读权限，这是有意的取舍） |
