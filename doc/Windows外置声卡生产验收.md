# Windows 外置声卡生产验收

本文档是第一版音频采集上线门禁，不是功能演示。每一种客户常用声卡、驱动版本和 Windows 机型都要留下独立报告。没有通过真实 Windows + USB 声卡的短录、长稳、拔设备和磁盘保护前，不应标记为“生产可发布”。

## 1. 验收工具做什么

`windows-audio-acceptance.cjs` 直接启动打包中的 `recorder-engine.exe`，使用与 Electron 主程序相同的 JSONL 协议。它不使用另一套录音实现。

自动记录：

- Windows 版本、CPU 和工具/引擎版本。
- WASAPI 输入设备显示名、稳定设备 ID、是否系统默认设备。
- 驱动暴露的采样率范围、输入通道数、样本格式，以及每条配置的 `share_mode`（独占 / 系统混音）。
- 请求值：开流模式、采样率、交付 WAV 位深、输入通道。
- 实际值：引擎选中的设备 ID、开流模式、输入样本格式、输入通道数、WAV 编码。
- `captured_samples` / `committed_samples` / `overflow_samples`、提交延迟、Peak / RMS、磁盘状态。
- 活动分段的文件增长；停止后的 RIFF/RF64 WAVE 属性、物理完整帧和头部/EOF 一致性。
- `audio-fault.json`、故障检测时间、时间轴是否停止、故障数据是否被禁止常规导出。

> `input_sample_format` 是最终交给引擎的数字样本表示，例如 `i16` / `i24` / `i32` / `f32`。`--bit-depth` 是交付 WAV 编码。验收门槛按有效数字精度计算：整数 `n` bit 按 `n`，IEEE-754 `f32` 按 24 bit 有效数字，`f64` 按 53 bit，不会把 `f32` 容器误认为 32 bit 有效精度。Windows shared mode 下，可枚举的客户端格式不得超过 `GetMixFormat` 声明的有效精度；`IsFormatSupported` 只能证明 Windows 音频引擎接受该客户端格式，不能用来把已知的低位深源判成高精度。把低精度硬件输入写成 24-bit 或 32-bit 不会凭空增加有效精度，因此报告会同时保留输入格式与交付编码。验收工具默认要求 16-bit 交付至少 16 bit 有效数字精度，24/32-bit 交付至少 24 bit；可用 `--minimum-input-format-bits` 按项目提高。这仍不能证明声卡 ADC 的 ENOB，声卡型号、驱动版本与厂商规格必须人工归档。

> 默认开流是 WASAPI exclusive。`capture_share_mode` 记录实际路径；`sample_rate` 在独占模式下才更接近驱动接受的硬件格式。生成 96 kHz WAV 在系统混音（shared）下只能证明 Windows 音频引擎向应用交付了 96 kHz 样本，不能单凭元数据证明 ADC/驱动原生 96 kHz。独占失败必须可见，禁止静默降级成共享还显示独占。真机仍需用硬件回环、频谱和时钟测试验收原生时钟。

> 音频 PCM 仍持续写入活动分段；为避免每秒 `FlushFileBuffers` 对长录音造成抖动，引擎默认约每 10 秒执行一次昂贵的“音频落盘 → WAV 头落盘” checkpoint。磁盘余量查询与 checkpoint 独立，仍每秒执行，频繁完成短句不会推迟安全余量保护。`committed_samples` 表示这个可恢复水位，因此正常验收允许最多 15 秒 committed 延迟；真实断电的默认尾差也是 15 秒，项目可用 `--max-tail-loss-seconds` 放宽，但生产工具不允许超过 30 秒。

## 2. 安全规则

1. `inventory`、`inspect` 是只读模式。`short`默认只录 20 秒。
2. 所有录制都写入新建的 `acceptance-results/<timestamp>-<mode>-<pid>/`，不复用客户任务目录；普通模式使用 `recording`，`replug` 使用两个独立的 `recording-before-unplug` / `recording-after-replug` 会话目录。
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
    ├── run-windows-audio-qualification.cmd
    ├── run-windows-audio-qualification.ps1
    ├── windows-audio-qualification.cjs
    ├── windows-audio-qualification-plan.schema.json
    ├── Windows外置声卡资格计划.example.json
    └── Windows外置声卡生产验收.md
```

在 PowerShell 中进入 `resources\acceptance`，运行：

```powershell
.\run-windows-audio-acceptance.cmd --mode inventory
```

启动器会把已打包的 Electron exe 当作 Node host，客户机不需另外安装 Node.js。如果使用了自定义安装位置，从该位置的 `resources\acceptance` 运行即可。

Windows CI 不只检查 `win-unpacked`：它还会静默安装最终 NSIS `.exe`，从实际安装目录运行 `inventory`，确认启动器、Electron-as-Node 和 `recorder-engine.exe` 完成一次干净 JSONL 生命周期。GitHub artifact 同时包含 `SHA256SUMS.txt`，下载后应在安装前核对。

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

`replug` 报告目录会以 `recording-before-unplug/` 和 `recording-after-replug/` 代替单个 `recording/`；两份原始会话都属于必归档证据。

报告、日志和 `recording/` 必须一起归档，不要只截图保存 `PASS`。

## 4. 设备清单与参数确认

```powershell
.\run-windows-audio-acceptance.cmd --mode inventory
```

通过标准：

- 外置声卡出现在列表中。
- 设备 ID 非空且与同一台机器上其他输入端点不重复。
- 需要的采样率和输入通道在 `configurations` 内，并带 `share_mode=exclusive` / `shared`。
- 工位默认验独占格式；独占列表为空时不得假装可用，应改 `--share-mode shared` 后单独归档。
- 声卡驱动版本、USB 端口和设备序列号（如有）由验收人补充到工单，因为 WASAPI 协议不保证提供厂商驱动版本。

## 5. 短录与 16/24/32-bit 矩阵

先使用 `inventory` 报告中的 ID。PowerShell 中 ID 应使用双引号包裹。

```powershell
$device = "<inventory 返回的完整设备 ID>"
.\run-windows-audio-acceptance.cmd --mode short --device-id $device --sample-rate 48000 --bit-depth 16 --channel 1 --seconds 30
.\run-windows-audio-acceptance.cmd --mode short --device-id $device --sample-rate 48000 --bit-depth 24 --channel 1 --seconds 30
.\run-windows-audio-acceptance.cmd --mode short --device-id $device --sample-rate 48000 --bit-depth 32 --channel 1 --seconds 30
.\run-windows-audio-acceptance.cmd --mode short --device-id $device --share-mode exclusive --sample-rate 48000 --bit-depth 24 --channel 1 --seconds 30
.\run-windows-audio-acceptance.cmd --mode short --device-id $device --share-mode exclusive --sample-rate 48000 --bit-depth 24 --channel 2 --seconds 30
```

默认 `--share-mode exclusive`。独占开流失败时报告应可复现（设备占用、不支持的采样率/位深/通道），再显式用 `--share-mode shared` 做对照，不得把共享会话标成独占。

执行噪声检测的前 3 秒保持安静，之后持续朗读或播放稳定测试音。如果是多输入声卡，对生产会使用的每一个 `--channel` 分别执行。完整生产资格必须在 44.1/48/96 kHz 下各重复 16/24/32-bit 矩阵；单次项目验证不能代替该资格矩阵。

强制通过标准：

- 请求设备 ID、开流模式、采样率、输入通道和交付位深与会话快照一致。
- 引擎记录非空 `input_sample_format` 与 `capture_share_mode`，且通过 `minimum_input_format_bits` 有效数字精度门槛（整数按位宽，`f32=24`、`f64=53`；默认 24/32-bit 交付不接受 `i16/u16`）。
- `captured` / `committed` 单调，最大提交延迟 ≤ 15 秒，无 overflow/fault marker。
- 所有分段 WAV 为请求采样率、请求位深、Mono；物理帧数等于最终 `committed_samples`。
- 安全停止后 WAV 头与物理 EOF 一致，整轨导出可解析；文件较大时能正确识别 RF64 的 `ds64` 计数和哨兵字段。
- 导出 `status.json` 已提交，其与 `metadata.json`、`metadata.csv`、整轨/单句 WAV 的 session、source 水位、条目数和格式一致；不允许只有 `full-track.wav` 就 PASS。
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
- 采集与持久化最大差值 ≤ 15 秒。
- 文件增长停滞不超过 `max(10 秒, 3 × poll interval)`。
- 平均样本速率在请求采样率的 ±5% 内。
- 全程 `storage_status=healthy`。
- 安全停止后所有分段头部精确，物理总帧数等于最终提交水位。
- 引擎安全收尾并以退出码 0 正常退出。

`soak` 默认不复制整轨，是为了避免长录结束后再产生一次数十 GiB 级复制、占用额外时间和磁盘空间；原始五分钟分段仍会完整验证。整轨能装入标准 RIFF 时导出为 RIFF，超过其容量后引擎会自动导出 RF64。需要验证整轨交付链路时可显式增加 `--export`，但必须同时确认目标文件系统和下游工具支持该结果；例如 FAT32 单文件仍受 4 GiB 限制，部分播放器、标注工具或上传服务也可能不接受 RF64。

对预计超过 4 GiB 的 2–8 小时任务，`soak --export` 应作为独立的 RF64 兼容性门禁执行：验收报告中的 `full_track.container` 必须为 `rf64`、`exact_header=true`，并由实际交付所用的播放器/切分器/质检工具成功打开。不要只凭本工具解析成功就推定整条下游链路兼容。

### 6.1 可恢复短暂抖动与缺帧

现场长稳出现非终止型声卡链路 warning 时，必须分别核对以下两类结果，不能只凭波形外观判定录音合格：

- 驱动上报 `DATA_DISCONTINUITY`，但 packet position 连续、`missing_frames=0`：`input_discontinuity_count` 可以增加，`input_discontinuity_silence_samples` 不增加；活动 attempt 仍可正常确认，界面按既有自动续录和标签规则进入下一句，采集保持 active。
- 确认存在 `missing_frames>0` 的有界前向缺口：引擎插入等值静音保持母音频时间轴，`input_discontinuity_silence_samples` 增加；受影响 attempt 必须标记 `needs_rerecord`，不得确认、试听切片或进入交付。界面先切到下一物理句并按自动续录规则继续，受损句保留在问题队列稍后补录；末句则停在末句提示重录。
- 两类情况都不得中断持续母音频或整批采集。超过恢复上限、位置倒退/溢出、设备断开、输入停滞、队列/写盘故障仍按 fail-closed 处理，不适用本节的继续采集规则。

验收证据至少包括 `events.jsonl`、最终 snapshot、discontinuity count/silence samples、受影响 attempt 状态、切句后的当前索引与录音状态，以及常规切片/交付拒绝结果。

## 7. 录制中拔出 USB 声卡

### 7.1 拔出后 fail-closed

```powershell
.\run-windows-audio-acceptance.cmd --mode unplug --device-id $device --sample-rate 48000 --bit-depth 24 --channel 1 --trigger-delay-seconds 10 --fault-timeout-seconds 60
```

操作：

1. 开始时保持声卡连接并输入声音。
2. 终端打印大字提示并响铃后，直接拔出 USB，不点应用的“停止”。
3. 保持断开，等工具完成安全停止和检查。

强制通过标准：

- 提示拔出前已有至少 2 秒健康采集。
- 提示后 15 秒内 `faulted=true` 且 `fault_kind=device_unavailable`，引擎进入 fail-closed。
- 录制中不会自动切到系统麦克风或同名声卡，任务中的稳定设备 ID 保持不变。
- 出现持久化 `metadata/audio-fault.json` 或其原子写临时代。
- 排空已接受队列后，`captured_samples` 在至少连续 2 个样本中不再增长。
- 故障前音频仍是完整物理帧，最终任务状态为 `faulted`。
- `export_session` 被拒绝，不会把时间轴不可信的数据伪装成正常交付。
- 不出现界面或 CLI 无限卡住；如写入线程仍在封存，必须明确返回可重试错误并保留会话锁。

拔设备故障会话是保护性封存，不应直接恢复当作正常交付。重连声卡后新建一次验收录制。

### 7.2 拔出并重插同一 endpoint 后开启新会话

```powershell
.\run-windows-audio-acceptance.cmd --mode replug --device-id $device --sample-rate 48000 --bit-depth 24 --channel 1 --seconds 30 --trigger-delay-seconds 10 --fault-timeout-seconds 60
```

操作：

1. 开始时保持目标声卡连接、固定在生产使用的 USB 端口，并持续输入声音。
2. 终端第一次鸣铃并提示后拔出声卡，不点停止，也不要立即插回。
3. 等工具明确确认设备列表中目标 endpoint ID 已至少消失一次，并提示重插后，再把同一声卡插回同一 USB 端口。
4. 重插后继续提供可检测的音频信号，等待新会话完成 `--seconds` 指定的健康采集和安全停止。

强制通过标准：

- 会话 A 在拔出前有至少 2 秒健康采集、有效信号和正确采样时钟；拔出后明确进入 `device_unavailable` / `faulted`，持久化故障标记，并保留完整物理 WAV 帧。
- 首个故障证据必须出现在终端明确打印“现在拔出”之后，且检测延迟必须在 `0–15` 秒内。过早拔出、测试前已断开或负延迟都必须失败，不得借后续重插补成 PASS。
- 会话 A 的常规导出和恢复追加都必须被拒绝；不能把故障时间轴继续用作新录制。
- `list_devices` 至少一次确认计划中的目标 endpoint ID 不存在。只有此证据成立后工具才进入重插等待，过早插回导致从未观察到消失时应 `FAIL`。
- 重插后的设备必须以原 endpoint ID、原名称和所需采样率/通道配置连续至少两次出现。仅同名但 ID 不同、系统默认设备或另一块声卡都不得替代。
- 协议中必须恰好有两次成功 `start_session`：会话 B 使用新的 session ID 和新的目录，且仍显式绑定原 endpoint ID/名称/格式。
- 会话 B 健康采集至少 `--seconds`，检测到有效信号，平均样本速率在请求值 ±5% 内；最终安全停止，无 fault/overflow/故障标记，且必须满足 `captured_samples = committed_samples = 物理 WAV 完整帧数`，不允许用“正常录制时可容忍的 checkpoint 延迟”解释停止后的尾音丢失。

报告中的 `replug.before`、`replug.transition`、`replug.after` 分别保存故障会话、消失/重现证据和新会话。资格聚合器不只信任报告内嵌的 `inspection`：它会重新读取两个录音目录中的 `items.snapshot.json`、`session.json`、fault marker 和所有分段 WAV，独立解析头部/EOF/物理帧并与会话身份、水位交叉绑定。它还会读取 `telemetry.jsonl` 验证“出现 → 提示后故障 → 消失 → 连续重现 → B 录制”的顺序，读取 `protocol.jsonl` 验证两次 start、两个会话的成功 stop、旧会话导出/恢复拒绝和引擎 shutdown，最后将两个录音目录都纳入证据哈希。

这里验证的是 Windows/WASAPI endpoint 身份，不是声卡机身序列号。驱动更新、换 USB 口或 USB 拓扑变化可能生成不同 endpoint ID；遇到这种情况本项应 fail-closed，先按新的生产端口重新建立资格计划，不能用同名回退绕过。

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

### 8.4 瞬时真实 ENOSPC 与恢复门禁

`disk-full` 模式只证明引擎在 critical 保留线上能提前 fail-closed。同目录的原子 rename 不等于“磁盘真的 0 byte 时仍能写入元数据”的保证，因此 `disk-full PASS` 不能代替瞬时 ENOSPC 验收。

完整资格还必须有独立的 `abrupt-enospc` 证据：只在可丢弃 VHDX/专用测试卷中，录制进行时将卷瞬间压到真实 ENOSPC，随后 kill 录音进程或重启测试机；重启后先释放足够空间，不修改录音会话，再执行离线 seal 和严格 inspect。验收必须证明无 panic/死锁、已持久化完整帧可保留、WAV 头与 EOF 可修复且时间轴不被伪装为正常交付。

**当前验收工具尚未实现 `abrupt-enospc` 模式。** 不得在系统盘、用户数据盘或客户交付盘上人工填到 0 byte。

## 9. 真实断电与重启恢复（两阶段）

这项门禁必须使用可丢弃的 Windows 测试机，不能在客户正在录音的机器上执行。“断电”指录制进行中切断整台计算机电源，不能用 Ctrl+C、任务管理器、关闭窗口或正常关机代替。

### 9.1 阶段 1：建立指定会话并在录制中断电

先创建一个未被客户任务使用的测试根目录，但不要预先创建 `$session` 目录；工具会拒绝复用已存在的会话目录。

```powershell
$device = "<inventory 返回的完整设备 ID>"
$qaRoot = "D:\DataBaker-PowerCut-QA"
$session = Join-Path $qaRoot "recording-01"
$reports = Join-Path $qaRoot "reports-phase-1"
.\run-windows-audio-acceptance.cmd --mode power-cut --session-dir $session --output $reports --device-id $device --sample-rate 48000 --bit-depth 24 --channel 1 --seconds 3900 --trigger-delay-seconds 3600 --poll-seconds 5
```

生产 `power-cut` 模式会强制 `--trigger-delay-seconds >= 3600`；未显式给出时，默认是录制 3600 秒后进入达标检查、最长等待 3900 秒。到达墙钟时间并不会立即提示断电；工具还会确认：

- `committed_samples >= sample_rate * 3600`，即至少 1 小时的样本已进入持久化水位。
- 样本水位和分段文件仍在增长，会话无 fault/overflow，磁盘读取正常。
- `captured - committed` 不超过 `--max-tail-loss-seconds`（默认 15 秒，覆盖约 10 秒 checkpoint、回调缓冲和少量调度抖动；允许配置到 30 秒，不能更高）。

全部达标后，工具才会生成随机 nonce，将同一份 `armed` 证据同步写入 phase-1 报告目录和 `<session>\metadata\power-cut.acceptance.json`，对重命名后的最终证据文件再次执行 flush，并强制落盘 telemetry，然后鸣笛并打印断电提示。提示出现后：

1. 确认终端中的 `captured` / `committed` 和文件字节仍在增长。
2. 直接切断整台测试机电源，不点击应用的停止或退出。
3. 如果工具在断电前自行结束，它会安全停止并返回 `INCOMPLETE`；这种情况不得计为断电通过。

阶段 1 不会产生 `PASS`。真实断电时进程来不及完成报告，这正是本测试的预期结果。工具会在 armed 时打印 `phase-1 报告` 和 `phase-1 证据` 的精确路径；阶段 2 必须显式传入其中一个，不会仅凭一个已封存目录判定断电通过。

### 9.2 阶段 2：重启后离线封存并严格检查

重新上电进入 Windows 后，不要先打开桌面录音任务，也不要人工修改 WAV 或 JSON。在同一版本的 `resources\acceptance` 中执行：

```powershell
$qaRoot = "D:\DataBaker-PowerCut-QA"
$session = Join-Path $qaRoot "recording-01"
$reports = Join-Path $qaRoot "reports-phase-2"
$phase1Report = Get-ChildItem (Join-Path $qaRoot "reports-phase-1") -Filter "acceptance-report.json" -File -Recurse |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName
.\run-windows-audio-acceptance.cmd --mode recover --session-dir $session --phase1-report $phase1Report --output $reports --yes
```

`--phase1-report` 也可以指向 phase-1 目录中的独立 `power-cut-evidence.json`，不能直接指向会话内那一份证据。`recover` 在启动引擎、更改 WAV 或写入恢复元数据之前，会先只读校验两份证据逐字段一致、session/device/format 身份、恢复前 `recording/stopping` 状态、1 小时 committed 水位、phase-1/phase-2 验收脚本与 `recorder-engine.exe` 的 SHA-256 完全一致，以及同一 hostname/platform/architecture 上的系统启动时间已晚于 armed 时间。因此仅强杀录音进程、没有重启 Windows，或换用另一个构建来恢复，都不能通过该门禁。用于无硬件测试的 boot 注入只在显式 `--test-only-power-cut` 分类下生效，设置 `NODE_ENV=test` 不能伪造生产恢复的新 boot。

预检通过后，`recover` 才会启动包内同一个 `recorder-engine.exe`，调用 `seal_interrupted_session`，修复最后一段的不完整帧和落后头部，再从磁盘重新读取全部证据。只有以下项目全部成立才返回 `PASS` / 退出码 `0`：

- `seal_interrupted_session` 成功，返回目录与指定会话完全一致，且 `no_op=false`；正常 stopped 或已恢复会话不能重复借用旧证据 PASS。
- 所有五分钟分段从 `000001` 连续编号，已闭合段长度正确，RIFF/RF64 头部与物理 EOF 精确一致，`block_align` / `byte_rate` 合法，没有半个音频帧的尾字节。
- 磁盘上的 `captured_samples == committed_samples == 物理完整帧总数`。不接受“物理帧不少于快照”这种宽松判定。
- 恢复后物理帧数不少于 phase-1 `armed_committed_samples`；相对 `armed_captured_samples` 的尾差不超过 phase-1 确定的上限（默认 15 秒，生产最大 30 秒）。
- 会话状态为 `stopped`，`overflow_samples=0`，不存在 `audio-fault.json` 或 `audio-fault.tmp`。
- `session.json` 与 `items.snapshot.json` 的 `session_id` / `journal_seq` / `status` 一致。
- 原生引擎完成正常 `shutdown`，退出码为 0，无信号退出或超时脱离。

任何 stale WAV header、不完整帧、故障标记、溢出、非 `stopped` 状态或水位不相等都是 `FAIL`。命令错误、无法读取证据或引擎无法安全退出是 `INCOMPLETE`，两者均不得发布。

必要时可再做一次不修改文件的复核：

```powershell
.\run-windows-audio-acceptance.cmd --mode inspect --session-dir $session --output (Join-Path $qaRoot "reports-inspect")
```

`inspect` 使用与 `recover` 相同的严格磁盘判定，但不修复任何文件。它会拒绝可识别的会话/分段 symlink 或 junction、分段编号缺口、孤立 descriptor 和语义无效的 WAV 头。与健康 WAV 对应的损坏冗余 descriptor 只会是 `WARN`：已闭合段不依赖 sidecar，健康末段的 sidecar 可由引擎原子补建；但末段 WAV 头已损坏时，必须有匹配的有效 descriptor 才允许恢复。阶段 1 的残留报告、阶段 2 的完整报告、协议日志、stderr 和整个会话目录必须一起归档。

> 开发回归可显式使用 `--test-only-power-cut` 缩短时间，但 phase-1 证据会固定写入 `test_only=true` / `production_eligible=false`，recover 只会返回 `TEST_ONLY_PASS`。该结果退出码为 0，仅用于自动回归，不得填入生产验收工单或代替 1 小时真实断电。

> 本地双份证据可以防止单文件损坏、误用旧报告或只杀进程被误判为断电，但它不是对本机管理员的密码学反篡改证明。需要对抗恶意管理员时，必须在断电前将 phase-1 证据的哈希/签名发往独立的可信存档或时间戳服务；这是实机验收流程门槛，不能靠会话目录内的自签 JSON 代替。

### 9.3 聚合整套生产资格

单次 `PASS` 只能证明一个参数组合，不等于该声卡已通过全部生产资格。复制 `Windows外置声卡资格计划.example.json`，按 `windows-audio-qualification-plan.schema.json` 填入安装包、引擎、验收工具哈希，以及主机、稳定设备 ID、驱动版本、USB 端口和序列号。每次验收都增加下列参数，将报告绑定到计划中唯一的 `required_runs[].id`：

```powershell
$qualification = "DB-WIN-RELEASE-DEVICE-001"
$installerSha256 = "<SHA256SUMS.txt 中的 64 位哈希>"
.\run-windows-audio-acceptance.cmd --mode short --device-id $device --sample-rate 48000 --bit-depth 24 --channel 1 --seconds 30 --qualification-id $qualification --qualification-run-id short-48000-24-ch1 --installer-sha256 $installerSha256
```

所有 run 完成后，将计划、安装包、各 run 目录和 power-cut 会话放在同一归档根下，执行：

```powershell
.\run-windows-audio-qualification.cmd --plan D:\QA\qualification-plan.json --reports D:\QA
```

整机断电需要两个唯一绑定：phase 1 `power-cut` 使用 recover 计划项的 `phase1_evidence_run_id`，phase 2 `recover` 使用该项自身的 `id`。recover 计划项还必须用 `phase1_report` 指向归档根下唯一的 phase-1 `acceptance-report.json`（相对路径）。两次的 qualification ID 和 installer hash 必须一致。例如：

```powershell
.\run-windows-audio-acceptance.cmd --mode power-cut <阶段 1 其他参数> --qualification-id $qualification --qualification-run-id power-cut-phase1-48000-24-ch1 --installer-sha256 $installerSha256
.\run-windows-audio-acceptance.cmd --mode recover <阶段 2 其他参数> --qualification-id $qualification --qualification-run-id power-cut-recover-48000-24-ch1 --installer-sha256 $installerSha256
```

真正断电后，phase-1 原始报告保持 `overall=INCOMPLETE`、`completed_at=null`、`power_cut.phase=armed`，这是预期状态，不要人工改成 `PASS`。该 run 目录必须整体归档，至少包含 `acceptance-report.json`、`power-cut-evidence.json`、`telemetry.jsonl`、`protocol.jsonl`和 `engine-stderr.log`，并保留会话内的 `metadata/power-cut.acceptance.json`。

聚合器会 fail-closed 核对上述原始报告、独立证据、会话证据和 phase-2 内嵌证据；还会从 telemetry/protocol 复核 armed 水位、引擎启动与成功 `start_session`，严格比对 qualification/run、安装包、验收工具、引擎、主机、设备和音频格式。原始报告缺失、出现重复或任一字段不一致，均为 `NOT_QUALIFIED`。通过后，phase-1 的报告、日志和证据也必须进入 `qualification-evidence.sha256`。

资格计划在运行时使用 Ajv 2020 严格验证：多余字段、用字符串写数字等情况会在生成报告前被拒绝，不会被自动删除或转型。安装包内的 launcher 直接使用 `app.asar` 中的 Ajv，客户机无需另装 Node.js。

聚合器只在以下条件全部满足时返回 `QUALIFIED`：44.1/48/96 kHz × 16/24/32-bit × 每个生产通道的 30 秒完整导出矩阵；三个采样率各至少 2 小时长稳；主力组合 8 小时；一次超过 RIFF 容量的 RF64 整轨导出；枚举、拔出、默认设备切换、重连后新录制、critical 磁盘保护、瞬时真实 ENOSPC 后恢复、真实断电恢复和严格复核。它还要求全部报告属于同一资格 ID、安装包、引擎、验收工具、Windows 主机和稳定设备 ID，且所有 check 都是 `PASS`、没有未处理 `WARN`。通过后会生成 `qualification-report.json` 和覆盖计划、报告、日志、原始录音及安装包的 `qualification-evidence.sha256`。

**当前 `default-switch` 和 `abrupt-enospc` 验收模式尚未实现。** 聚合器会将这两项标为 `NOT_IMPLEMENTED` 并返回 `NOT_QUALIFIED`；不允许删掉它们、修改示例或用人工声明获得整套资格。`replug` 已实现，但仍必须在真实 Windows、真实外置声卡和固定生产 USB 端口上留下完整双会话证据才能通过。

## 10. 发布判定与工单清单

同一个声卡/驱动/Windows 组合的发布门禁为：

| 项目 | 最低要求 |
| --- | --- |
| 设备枚举 | `inventory` PASS，稳定 ID 唯一 |
| 参数矩阵 | 44.1/48/96 kHz × 16/24/32-bit × 每个生产通道，每项至少 30s 且整轨导出 PASS；24/32-bit 项默认要求至少 24 bit 输入有效数字精度（`f32=24`） |
| 通道 | 生产会使用的每个输入通道 PASS |
| 长稳 | 44.1/48/96 kHz 各至少 2h PASS；主力组合 8h PASS |
| 超大整轨 | 超过 RIFF 容量的实际 RF64 导出及下游交付链解析 PASS |
| USB 拔出 | `unplug` PASS |
| 默认设备切换 | 指定声卡录制期间切换系统默认输入，`default-switch` PASS（当前模式待实现） |
| 拔出后重连 | 声卡拔出、确认 endpoint 消失、同一 ID/名称/配置连续两次重现后开启独立新会话，`replug` PASS |
| 磁盘临界保护 | 专用测试卷 `disk-full` PASS，证明 critical 保留线上提前 fail-closed |
| 瞬时真实 ENOSPC | 可丢弃 VHDX 上制造真实 ENOSPC，kill/reboot 后释放空间并 seal/inspect，`abrupt-enospc` PASS（当前模式待实现） |
| 整机断电 | 阶段 1 录制至少 1h 后真实断电；重启后 `recover` PASS，严格 `inspect` 复核 PASS |
| 原始证据 | plan + report + telemetry + protocol + stderr + recording + 安装包全部归档，生成并校验 `qualification-evidence.sha256` |
| 安装包 | CI 从真实 NSIS 安装目录运行验收启动器；下载后核对 `SHA256SUMS.txt` |

任意一项 `FAIL`、`INCOMPLETE`、`WARN` 或 `NOT_IMPLEMENTED` 都不允许以“验收通过”结单。例如削波 WARN 需调整硬件增益后重测。

## 11. 已知边界

- 当前 Windows 基线是 WASAPI exclusive 开流，失败后才允许显式改用系统混音；不是 ASIO。需要 ASIO-only 的声卡不属于本门禁覆盖范围。独占成功仍不能单凭元数据宣称 bit-perfect，时钟与 ENOB 仍需硬件测量。
- 工具可证明驱动交给应用的样本格式和最终 WAV 编码，不能仅凭 WASAPI 元数据证明声卡 ADC 的真实 ENOB。模拟前端、噪声底和失真仍需专业测量。
- 标准 RIFF/WAV 容器有约 4 GiB 上限；整轨超过该边界时会自动切换为 RF64，五分钟分段、单句和预览仍保持普通 RIFF。RF64 的目标文件系统及播放器、标注、上传等下游兼容性必须按实际交付链路验收，FAT32 不能保存大于 4 GiB 的单文件。
- 进程强杀/恢复的无硬件回归由 `npm run test:crash-recovery` 执行；真实断电必须按第 9 节在可丢弃的 Windows 测试机上执行并归档，不能用无硬件回归代替。
