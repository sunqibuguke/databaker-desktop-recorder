# Windows 外置声卡生产验收

本文档是第一版音频采集上线门禁，不是功能演示。每一种客户常用声卡、驱动版本和 Windows 机型都要留下独立报告。没有通过真实 Windows + USB 声卡的短录、长稳、拔设备和磁盘保护前，不应标记为“生产可发布”。

## 1. 验收工具做什么

`windows-audio-acceptance.cjs` 直接启动打包中的 `recorder-engine.exe`，使用与 Electron 主程序相同的 JSONL 协议。它不使用另一套录音实现。

自动记录：

- Windows 版本、CPU 和工具/引擎版本。
- WASAPI 输入设备显示名、稳定设备 ID、是否系统默认设备。
- 驱动暴露的采样率范围、输入通道数和样本格式。
- 请求值：采样率、交付 WAV 位深、输入通道。
- 实际值：引擎选中的设备 ID、输入样本格式、输入通道数、WAV 编码。
- `captured_samples` / `committed_samples` / `overflow_samples`、提交延迟、Peak / RMS、磁盘状态。
- 活动分段的文件增长；停止后的 RIFF/RF64 WAVE 属性、物理完整帧和头部/EOF 一致性。
- `audio-fault.json`、故障检测时间、时间轴是否停止、故障数据是否被禁止常规导出。

> `input_sample_format` 是驱动实际交给引擎的样本表示，例如 `i16` / `i24` / `i32` / `f32`。`--bit-depth` 是交付 WAV 编码。把低精度硬件输入写成 24-bit 或 32-bit 不会凭空增加有效精度，因此报告会同时保留两者。验收工具默认要求 16-bit 交付至少为 16-bit driver representation，24/32-bit 交付至少为 24-bit representation；可用 `--minimum-input-format-bits` 按项目提高。这仍不能证明 ADC 的 ENOB，声卡型号、驱动版本与厂商规格必须人工归档。

## 2. 安全规则

1. `inventory`、`inspect` 是只读模式。`short`默认只录 20 秒。
2. 所有录制都写入新建的 `acceptance-results/<timestamp>-<mode>-<pid>/recording`，不复用客户任务目录。
3. Ctrl+C 第一次不会直接杀引擎；工具会先执行安全停止，并把报告标为 `INCOMPLETE`。
4. `disk-full` 模式不会自动写填充数据。它要求显式 `--output`、两个确认参数，并在 Windows 上直接拒绝 `SystemDrive`。
5. 磁盘故障验收只能在可删除的 VHD/VHDX 或独立测试盘上进行，禁止对 Windows 系统盘、用户数据盘或客户交付盘做填满测试。

## 3. 运行方式

### 3.1 已安装/解压的 Windows 包

安装目录内包含：

```text
resources/
├── bin/recorder-engine.exe
└── acceptance/
    ├── run-windows-audio-acceptance.cmd
    ├── run-windows-audio-acceptance.ps1
    ├── windows-audio-acceptance.cjs
    └── Windows外置声卡生产验收.md
```

在 PowerShell 中进入 `resources\acceptance`，运行：

```powershell
.\run-windows-audio-acceptance.cmd --mode inventory
```

启动器会把已打包的 Electron exe 当作 Node host，客户机不需另外安装 Node.js。如果使用了自定义安装位置，从该位置的 `resources\acceptance` 运行即可。

Windows 默认把报告写到 `%LOCALAPPDATA%\DataBaker\acceptance-results`，不会尝试写入通常受保护的应用安装目录。需要把证据直接放到指定验收盘时，显式传入 `--output D:\DataBaker-Acceptance`；`disk-full` 必须按第 8 节使用专用测试卷。

### 3.2 源码环境

```powershell
npm ci
npm run build:engine:release
npm run acceptance:audio -- --mode inventory
```

可用 `npm run test:acceptance-tool` 只运行验收工具的无硬件单元测试。

### 3.3 退出码与文件

- `0` = `PASS`。
- `1` = 工具完整执行，但至少一项生产门禁为 `FAIL`。
- `2` = `INCOMPLETE`，例如人工取消、设备不支持请求参数或引擎未安全封存。

每次运行会产生：

```text
acceptance-report.json   最终配置、WAV 属性和判定
telemetry.jsonl          长稳/故障过程的持续样本
protocol.jsonl           命令、响应和低频引擎事件
engine-stderr.log        Rust/WASAPI 日志
recording/               本次验收的原始录制目录
```

报告、日志和 `recording/` 必须一起归档，不要只截图保存 `PASS`。

## 4. 设备清单与参数确认

```powershell
.\run-windows-audio-acceptance.cmd --mode inventory
```

通过标准：

- 外置声卡出现在列表中。
- 设备 ID 非空且与同一台机器上其他输入端点不重复。
- 需要的采样率和输入通道在 `configurations` 内。
- 声卡驱动版本、USB 端口和设备序列号（如有）由验收人补充到工单，因为 WASAPI 协议不保证提供厂商驱动版本。

## 5. 短录与 16/24/32-bit 矩阵

先使用 `inventory` 报告中的 ID。PowerShell 中 ID 应使用双引号包裹。

```powershell
$device = "<inventory 返回的完整设备 ID>"
.\run-windows-audio-acceptance.cmd --mode short --device-id $device --sample-rate 48000 --bit-depth 16 --channel 1 --seconds 30
.\run-windows-audio-acceptance.cmd --mode short --device-id $device --sample-rate 48000 --bit-depth 24 --channel 1 --seconds 30
.\run-windows-audio-acceptance.cmd --mode short --device-id $device --sample-rate 48000 --bit-depth 32 --channel 1 --seconds 30
```

执行噪声检测的前 3 秒保持安静，之后持续朗读或播放稳定测试音。如果是多输入声卡，对生产会使用的每一个 `--channel` 分别执行。如果项目要求 96 kHz，再以 `--sample-rate 96000` 重复完整矩阵。

强制通过标准：

- 请求设备 ID、采样率、输入通道和交付位深与会话快照一致。
- 引擎记录非空 `input_sample_format`，且通过 `minimum_input_format_bits` 门槛（默认 24/32-bit 交付不接受 `i16/u16`）。
- `captured` / `committed` 单调，最大提交延迟 ≤ 10 秒，无 overflow/fault marker。
- 所有分段 WAV 为请求采样率、请求位深、Mono；物理帧数等于最终 `committed_samples`。
- 安全停止后 WAV 头与物理 EOF 一致，整轨导出可解析；文件较大时能正确识别 RF64 的 `ds64` 计数和哨兵字段。
- 验收结束后原生引擎以退出码 0 正常收尾；超时、信号退出、非 0 退出或 `shutdown_error` 均不能判定 PASS。
- 检测到 Peak > -50 dBFS。Peak 达到 -0.1 dBFS 会给出 `WARN`，应降低声卡增益后重测。
- `engine-stderr.log` 无 panic/fatal runtime error。

## 6. 2–8 小时长稳

上线候选版至少执行 2 小时；正式客户版的主力声卡/驱动组合执行 8 小时。

```powershell
.\run-windows-audio-acceptance.cmd --mode soak --device-id $device --sample-rate 48000 --bit-depth 24 --channel 1 --hours 2 --poll-seconds 5
```

长稳前：

- 使用与录音棚实际相同的声卡、驱动、USB 端口、供电和线材。
- Windows 保持正常开机但禁止自动睡眠；不要为了跑测试临时关闭会在生产中开启的安全软件。
- 使用连续声源或定时人声，保证 Peak 不会全程为零。
- 使用实际生产存储介质。开始时剩余空间应高于引擎的 warning 线。

强制通过标准：

- 实际运行时长达到请求时长，无人工中止。
- 无 fault、overflow、`audio-fault.json`、panic。
- `captured` / `committed` / 文件总字节数始终单调。
- 采集与持久化最大差值 ≤ 10 秒。
- 文件增长停滞不超过 `max(10 秒, 3 × poll interval)`。
- 平均样本速率在请求采样率的 ±5% 内。
- 全程 `storage_status=healthy`。
- 安全停止后所有分段头部精确，物理总帧数等于最终提交水位。
- 引擎安全收尾并以退出码 0 正常退出。

`soak` 默认不复制整轨，是为了避免长录结束后再产生一次数十 GiB 级复制、占用额外时间和磁盘空间；原始五分钟分段仍会完整验证。整轨能装入标准 RIFF 时导出为 RIFF，超过其容量后引擎会自动导出 RF64。需要验证整轨交付链路时可显式增加 `--export`，但必须同时确认目标文件系统和下游工具支持该结果；例如 FAT32 单文件仍受 4 GiB 限制，部分播放器、标注工具或上传服务也可能不接受 RF64。

对预计超过 4 GiB 的 2–8 小时任务，`soak --export` 应作为独立的 RF64 兼容性门禁执行：验收报告中的 `full_track.container` 必须为 `rf64`、`exact_header=true`，并由实际交付所用的播放器/切分器/质检工具成功打开。不要只凭本工具解析成功就推定整条下游链路兼容。

## 7. 录制中拔出 USB 声卡

```powershell
.\run-windows-audio-acceptance.cmd --mode unplug --device-id $device --sample-rate 48000 --bit-depth 24 --channel 1 --trigger-delay-seconds 10 --fault-timeout-seconds 60
```

操作：

1. 开始时保持声卡连接并输入声音。
2. 终端打印大字提示并响铃后，直接拔出 USB，不点应用的“停止”。
3. 保持断开，等工具完成安全停止和检查。

强制通过标准：

- 提示拔出前已有至少 2 秒健康采集。
- 提示后 15 秒内 `faulted=true` / overflow / fault marker 至少一项被检测，引擎进入 fail-closed。
- 出现持久化 `metadata/audio-fault.json` 或其原子写临时代。
- 排空已接受队列后，`captured_samples` 在至少连续 2 个样本中不再增长。
- 故障前音频仍是完整物理帧，最终任务状态为 `faulted`。
- `export_session` 被拒绝，不会把时间轴不可信的数据伪装成正常交付。
- 不出现界面或 CLI 无限卡住；如写入线程仍在封存，必须明确返回可重试错误并保留会话锁。

拔设备故障会话是保护性封存，不应直接恢复当作正常交付。重连声卡后新建一次验收录制。

## 8. 磁盘临界/写满保护

### 8.1 准备专用卷

推荐在 Windows“磁盘管理”中创建一个可丢弃的 8–12 GiB VHDX，初始化并分配一个明确的测试盘符，例如 `Q:`。开始前再次确认：

```powershell
$env:SystemDrive
Get-Volume -DriveLetter Q
```

`Q:` 必须是新建的可丢弃测试卷，且必须与 `$env:SystemDrive` 不同。

### 8.2 启动监测

```powershell
.\run-windows-audio-acceptance.cmd --mode disk-full --output Q:\DataBaker-Acceptance --confirm-dedicated-volume --confirm-not-system-drive --device-id $device --sample-rate 48000 --bit-depth 24 --channel 1 --trigger-delay-seconds 15 --fault-timeout-seconds 300
```

工具会比较 `--output` 卷与 `SystemDrive`，相同则立即拒绝。两个 `--confirm-*` 参数都必须出现，这两个参数不会绕过系统盘检查。

### 8.3 人工降低剩余空间

在另一个 PowerShell 窗口中，只对上述专用卷的一个明确文件写入。下面示例在目标剩余空间约 900 MiB 时停止，不写系统盘：

```powershell
$testDrive = "Q:"
$testFile = "Q:\DataBaker-Acceptance\disk-pressure-filler.bin"
if ($testDrive -eq $env:SystemDrive) { throw "Refusing to fill the Windows system drive" }
New-Item -ItemType Directory -Force -Path (Split-Path $testFile) | Out-Null
$targetFree = 900MB
$buffer = New-Object byte[] (64MB)
$stream = [System.IO.File]::Open($testFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
try {
  while ((Get-PSDrive -Name $testDrive.TrimEnd(':')).Free -gt $targetFree) {
    $stream.Write($buffer, 0, $buffer.Length)
    $stream.Flush($true)
  }
} finally {
  $stream.Dispose()
}
```

如需验证真实 `ENOSPC`，也只能在这个可丢弃 VHDX 上进行。引擎正常应在物理写满前的 critical 保留线停止，所以默认门禁验证的是“不等到 0 byte 才停”。

强制通过标准：

- 录制能在开始时通过存储预检，故障前至少有 2 秒健康音频。
- 剩余空间到 critical 线后 5 秒内 fail-closed。
- 在仍有保留空间时成功写入 fault marker 和可恢复快照。
- 已接受队列排空，时间轴停止，故障前完整物理帧保留。
- 最终状态为 `faulted`，常规导出被拒绝，无 panic/死锁。

验收完成后，先保存整个验收结果目录，再在“磁盘管理”中分离并删除该专用 VHDX。

## 9. 发布判定与工单清单

同一个声卡/驱动/Windows 组合的发布门禁为：

| 项目 | 最低要求 |
| --- | --- |
| 设备枚举 | `inventory` PASS，稳定 ID 唯一 |
| 位深 | 48 kHz / 16、24、32-bit 短录各 PASS；24/32-bit 项目默认不接受 16-bit driver representation |
| 通道 | 生产会使用的每个输入通道 PASS |
| 长稳 | 候选版 2h PASS；客户正式版主力组合 8h PASS |
| USB 拔出 | `unplug` PASS |
| 磁盘保护 | 专用测试卷 `disk-full` PASS |
| 原始证据 | report + telemetry + protocol + stderr + recording 全部归档 |

任意一项 `FAIL` 或 `INCOMPLETE` 都不允许以“验收通过”结单。`WARN` 必须有书面处理记录；例如削波 WARN 需调整硬件增益后重测。

## 10. 已知边界

- 当前 Windows 基线是 WASAPI shared mode，不是 ASIO 或独占 bit-perfect 链路。需要 ASIO-only 的声卡不属于本门禁覆盖范围。
- 工具可证明驱动交给应用的样本格式和最终 WAV 编码，不能仅凭 WASAPI 元数据证明声卡 ADC 的真实 ENOB。模拟前端、噪声底和失真仍需专业测量。
- 标准 RIFF/WAV 容器有约 4 GiB 上限；整轨超过该边界时会自动切换为 RF64，五分钟分段、单句和预览仍保持普通 RIFF。RF64 的目标文件系统及播放器、标注、上传等下游兼容性必须按实际交付链路验收，FAT32 不能保存大于 4 GiB 的单文件。
- 本工具的人工模式覆盖真实 USB 拔出和存储保护。进程强杀/恢复的无硬件回归由 `npm run test:crash-recovery` 执行；真实断电仍应在可丢弃的 Windows 测试机上单独归档。
