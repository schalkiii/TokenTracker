# 云端同步设备轮换部署指南（供 QI-SHAO-L 的 AI Agent 执行）

本文件描述如何在 **QI-SHAO-L** 上复刻 Thunderobot 已有的「按本地日期奇偶轮换云端同步设备槽位」部署。
执行前请通读全文；所有命令均按 Windows + PowerShell 7 编写。

## 1. 背景与目标

- TokenTracker 免费 / 已过期档的 Cloud 同步只有一个**活跃设备槽位**（`machine_limit=1`），上传额度是**账号级、每天 1 次**。
- 两台机器轮流占用槽位：
  - **偶数日** → `Thunderobot`（machine slot id `ef3e91d5-0440-4305-903d-f1a595e422b6`）
  - **奇数日** → `QI-SHAO-L`（machine slot id `dd8ced79-08cd-4772-8709-1b5aa4b1c235`）
- Thunderobot 上已注册隐藏计划任务 `tokentracker-device-rotate`，每天 00:10 调用仓库脚本 `scripts/rotate-cloud-devices.cjs`。
- 本机目标：做**同样的部署**。脚本是幂等的（先判断目标设备是否已活跃），两台机器同时安装不会冲突；建议把本机执行时间设为 00:20，错开请求。

> 注意：仓库里另有一份旧的每小时轮换方案 `scripts/cloud-device-rotate.cjs`（计划任务名 `TokenTrackerCloudRotate`）。
> **两套逻辑不要同时启用**，会互相抢槽位。若本机已装旧任务，先执行第 3 步的停用命令。

## 2. 前置条件（逐项确认，缺一不可）

1. Node.js ≥ 20：`node -v` 输出 `v20.x` 或更高。
2. 本机 TokenTracker 服务正在运行，且浏览器已登录云账户：
   - `http://127.0.0.1:7681/` 返回 200；
   - `Invoke-RestMethod http://127.0.0.1:7681/api/local-auth` 返回 `token` 字段。
   - 若本机服务不是 7681，记下实际端口，后续命令加 `--server http://127.0.0.1:<端口>`。
3. 仓库 checkout 存在且包含 `scripts/rotate-cloud-devices.cjs` 与 `src/lib/tracker-paths.js`。
   建议路径与 Thunderobot 一致：`D:\workspace\TokenTracker`。
4. 所有 git 写操作（pull/checkout）用 **Windows 侧 git**，不要用 WSL 的 git。

## 3. 获取脚本（若本机仓库还没有）

个人仓库已上传该脚本（上游 `xiufengsun/TokenTracker` 没有）：

```powershell
# 若本机还没配置个人仓库 remote，先添加（已有则跳过）
git remote add personal https://github.com/schalkiii/TokenTracker.git

git fetch personal main

# 只取需要的文件，不切换分支、不影响本机未提交改动
git checkout personal/main -- scripts/rotate-cloud-devices.cjs docs/ops/cloud-device-rotation.md
```

若本机就是 `schalkiii/TokenTracker` 的干净 clone，可直接 `git pull`。

停用旧的小时级轮换任务（存在才执行）：

```powershell
Get-ScheduledTask -TaskName "TokenTrackerCloudRotate" -ErrorAction SilentlyContinue |
  Unregister-ScheduledTask -Confirm:$false
```

## 4. Dry-run 验证（必须通过）

```powershell
node scripts/rotate-cloud-devices.cjs `
  --parity-even ef3e91d5-0440-4305-903d-f1a595e422b6 `
  --parity-odd  dd8ced79-08cd-4772-8709-1b5aa4b1c235 `
  --dry-run
```

期望：先打印「本地 YYYY-MM-DD（N 号）为奇/偶数日，目标设备: ...」，再打印将暂停/恢复的设备。
`--dry-run` 不会调用任何修改接口，可反复执行。

判定规则摘要：

- 偶数日目标 = Thunderobot；奇数日目标 = QI-SHAO-L；
- 若当前活跃设备已是目标设备 → 输出「无需切换」并退出 0；
- 否则先暂停所有非目标活跃设备（`remove-device` 仅置为 paused，不删除历史数据），再恢复目标设备；
- 恢复失败会自动回滚原设备，避免账号出现「没有活跃设备」。

## 5. 创建隐藏启动器

在 `%USERPROFILE%\.tokentracker\rotate-cloud-devices-hidden.vbs` 写入以下内容（**node 路径必须是绝对路径**，按本机实际安装位置调整）：

```vbs
' TokenTracker cloud device rotation wrapper (hidden, runs daily).
' Even local date -> Thunderobot, odd local date -> QI-SHAO-L.
CreateObject("WScript.Shell").Run """C:\CommonTools\scoop\apps\nodejs\current\node.exe"" ""D:\workspace\TokenTracker\scripts\rotate-cloud-devices.cjs"" --parity-even ef3e91d5-0440-4305-903d-f1a595e422b6 --parity-odd dd8ced79-08cd-4772-8709-1b5aa4b1c235", 0, True
```

可用 `where.exe node` 确认绝对路径；若本机服务端口不是 7681，在脚本参数后追加 `--server http://127.0.0.1:<端口>`。

写入方式（避免 PowerShell 重定向生成 UTF-16）：

```powershell
$vbs = Join-Path $env:USERPROFILE ".tokentracker\rotate-cloud-devices-hidden.vbs"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $vbs) | Out-Null
# 用记事本/编辑器保存为 UTF-8（无 BOM）或 ASCII，内容为上面的 VBS
```

## 6. 注册隐藏计划任务

```powershell
$vbs = Join-Path $env:USERPROFILE ".tokentracker\rotate-cloud-devices-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "C:\Windows\System32\wscript.exe" `
  -Argument ('//B //NoLogo "' + $vbs + '"')
$trigger = New-ScheduledTaskTrigger -Daily -At "00:20"
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName "tokentracker-device-rotate" `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "TokenTracker cloud device slot rotation by local date parity" -Force
```

说明：

- 必须用 `wscript.exe` + VBS 包裹，直接跑 `.cmd` 或 `.bat` 会弹黑框（任务计划的 `-Hidden` 只隐藏任务，不隐藏窗口）。
- `-LogonType Interactive`：脚本需要通过本机 7681 服务换取登录态，不能放在 Session 0。
- 不需要管理员权限；不要 `Start-Process` 提权。

## 7. 立即执行一次并验证

```powershell
node scripts/rotate-cloud-devices.cjs `
  --parity-even ef3e91d5-0440-4305-903d-f1a595e422b6 `
  --parity-odd  dd8ced79-08cd-4772-8709-1b5aa4b1c235
```

期望输出包含：

```
本地 YYYY-MM-DD（N 号）为奇/偶数日，目标设备: <设备名>
已暂停设备 <另一台>          # 需要切换时才会出现
已恢复设备 <目标设备>
校验：目标状态=active，活跃设备数=1
```

再验证计划任务：

```powershell
Get-ScheduledTask -TaskName "tokentracker-device-rotate" | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName "tokentracker-device-rotate" | Select-Object NextRunTime,LastTaskResult
```

## 8. 状态、日志与手动操作

- 状态文件：`%USERPROFILE%\.tokentracker\tracker\cloud-device-rotation.json`
- 日志文件：`%USERPROFILE%\.tokentracker\tracker\cloud-device-rotation.log`
- 并发锁：`cloud-device-rotation.json.lock`（正常情况下运行结束即删除）
- 手动 dry-run / 强制切换：直接运行第 4 / 7 节命令
- 停用轮换：`Unregister-ScheduledTask -TaskName "tokentracker-device-rotate" -Confirm:$false`
- 恢复设备槽位：dashboard「设置 → 云服务 → 云端设备」里点「恢复 / 暂停」

## 9. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `无法从本地服务换取 access token` | 浏览器未登录云账户，或本机 TokenTracker 服务未运行。先打开 `http://127.0.0.1:7681` 登录 |
| `cloud_machine_limit` | 还有其他活跃设备未暂停；脚本会先暂停非目标活跃设备，仍失败说明存在第三台 active 设备，去云端设备列表手动处理 |
| `cloud_machine_paused` | 本机被轮换暂停属正常状态；到目标日会自动恢复，或手动「恢复」 |
| `另一个轮换进程正在运行` | 上一次运行未结束；等待 5 分钟后重试，确认无 node 进程后可删除 `.lock` |
| 计划任务 `LastTaskResult` 非 0 | 看日志文件最后一行；常见为本地服务未启动或登录态失效 |
| 月末连续两天同一台设备 | 日期奇偶在 31→1 时会出现同奇偶；这是按「日期奇偶」实现的已知边界 |

## 10. 安全边界（必须遵守）

- 只允许调用 `remove-device`（暂停）和 `resume-device`（恢复）；**禁止**删除设备、改数据库或调用管理接口。
- 不把 access token / relay cookie 写入文件、日志或提交到仓库。
- 不改动上游仓库 `xiufengsun/TokenTracker`；个人改动只提交到 `schalkiii/TokenTracker`。
- 部署完成后，把 dry-run 输出、任务状态、首次真实执行日志三项结果回报给用户。

## 11. 验收清单

- [ ] `node -v` ≥ 20
- [ ] 本机 7681 返回 200，`/api/local-auth` 可返回 token
- [ ] dry-run 输出的目标设备与当天日期奇偶一致
- [ ] `tokentracker-device-rotate` 状态 Ready，NextRunTime = 次日 00:20
- [ ] 首次真实执行后：目标设备 active，活跃设备数 = 1
- [ ] 状态文件与日志文件已生成
- [ ] 旧任务 `TokenTrackerCloudRotate` 不存在（或已说明保留原因）
