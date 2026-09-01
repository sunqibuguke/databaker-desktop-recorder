# DataBaker 桌面音频采集

Electron + React + TypeScript 桌面操作台，配套 Rust 原生录音引擎。当前版本面向本地可落地的逐句朗读采集：持续写入一条母音频，每次录制只保存整数样本边界，确认后导出独立 WAV。

## 当前可用能力

- 启动进入「录制」中心，可新建录制、筛选历史录制、打开目录或重新导出。
- 保存位置会跨重启记忆并绑定目录/卷身份；外置盘暂时离线时仍显示原路径，重连后可直接刷新。位置记录损坏时不会静默切换空目录，必须由操作员重新选择。
- 损坏快照、身份冲突或只剩音频目录的录制不会从历史列表静默消失；界面会标记「需要检查」并允许打开原目录，同时禁止未经身份确认的恢复和导出。
- 导入 UTF-8 CSV / TSV / TXT，标准三列为“序号 / 句子正文 / 标签（备注）”；兼容历史 `id,text` 两列和普通逐行 TXT。
- 枚举系统识别的麦克风与外置声卡输入，可选择设备、采样率和输入通道。
- 本次试运行的新任务统一交付 `48 kHz / 16-bit PCM / Mono`；声卡驱动可以用 `i16` / `i24` / `i32` / `f32` 输入，转换后的母带、试听切片与最终导出保持同一 Mono WAV 交付格式。
- Windows 使用 CPAL 的 ASIO + WASAPI 双后端：专业声卡优先走厂商 ASIO 驱动，普通麦克风和通用 USB 设备保留 WASAPI；输入回调会申请 MMCSS 实时优先级，并对驱动包位置做连续性校验。
- 新建或恢复一次录制后会先按任务规则执行约 3 秒的环境噪声检测，再在正式录句前提供 10 秒输入试听。输入试听允许明确跳过，并且与环境检测互不替代；同一次应用启动、相同采集配置不重复提示。
- 录制中始终可停止：未检测到语音时取消当前句，已有语音但尾静音不足时可强制完成并进入试听确认。
- 声卡驱动只要上报输入不连续，本句 attempt 就标记为「需重录」并禁止交付；能够估算缺帧时仍会插入静音保持持续母音频时间轴，界面按自动续录规则继续采集后续句子。
- 可配置每句前后的连续静音时长（0.2–5.0 秒，默认 1.0 秒）；Rust 引擎对“可开始”与“可完成”双向门控。
- 主界面和独立领读窗口同步显示黄（检测中）、绿（就绪）、红（录制中）、蓝（尾静音达标）。领读窗口优先打开在外接显示器。
- 右侧栏将“检测”和“设置”分开：检测只调整判定方式、静音阈值和时长；设置管理确认后连续录制、标签变化暂停、录制保护与提示。侧栏设置只影响当前任务，顶部“应用设置”管理以后新任务的默认值。
- Rust 端提取 PCM min/max 包络，WebGL 以固定媒体时间轴渲染实时波形，并显示 Peak / RMS 和写盘状态。
- 每句支持开始、结束、试听、手动确认、重录、跳过；重录后只需处理“试听本次重录 / 使用本次重录 / 保留原录音”，不向采录人员展开历史录音或技术记录。底层 attempt 仍追加保留，用于异常恢复和交付校验。
- 业务事件先同步写入带序号的 JSONL journal，再原子替换快照；启动时可从最新持久化事件重建状态。
- 母轨默认每 5 分钟封存为一个不再修改的 WAV 段；最后活动段始终连续写入，约每 10 秒按“先同步音频、再同步 WAV 头”做一次昂贵 checkpoint，避免每秒 `FlushFileBuffers`；廉价的磁盘余量检查仍每秒执行，不会被频繁完成短句推迟。异常断电默认按 15 秒尾差验收，可配置上限为 30 秒。
- 异常启动可自动修复落后/超前的 WAV 头和不完整尾帧；队列溢出、写盘故障或磁盘余量进入安全线后 fail-closed，不再伪造连续时间轴。
- 一键导出整轨 `full-track.wav`、每句已确认录音的 WAV bundle、`metadata.json` 和 `metadata.csv`。
- 恢复、离线封存和导出都同时绑定录制目录与持久化任务 ID，目录被替换或多份元数据身份冲突时 fail-closed。
- 同时保存操作打点 `recording_started_sample`、首次有效语音 `content_started_sample` 和实际切片起点 `start_sample`，便于后续根据一线规则选择业务时间戳。
- 快捷键：`Space` 开始/结束/确认，`R` 重录，`P` 试听，`S` 跳过，方向键切句。

## 开发运行

需要 Node.js 22.12+、npm，以及 Rust stable。中国大陆网络可使用 RsProxy 安装 Rust，并在项目的 `.cargo/config.toml` 中使用 sparse 镜像。

```bash
export RUSTUP_DIST_SERVER=https://rsproxy.cn
export RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

npm install
npm run dev
```

可直接导入 `examples/script.tsv` 体验完整流程。环境检测完成后，先完成或明确跳过 10 秒输入试听，再按空格录制第一句。

macOS 只用于开发：`npm run dev` 会在点击「启用录音」后走 Electron `getUserMedia`，把系统麦克风 PCM 喂给引擎，用来看电平、环境检测和逐句流程。这不是 Windows 独占/共享采集。正式采集只打 Windows 包。若要临时回到 CoreAudio sidecar，启动前设 `DATABAKER_DEV_WEB_CAPTURE=0`。

`npm run dev` 会跳过激活页和机器码采集，直接进入录制台。`npm run dev:unlocked` 与它相同。生产安装包不要设置 `DATABAKER_LICENSE_DISABLED`。

## 离线授权

新安装默认只显示激活页：本机机器码 + 复制 + 授权码输入。授权过期、换机或系统时间回拨也会回到同一页。

工位操作员把机器码发给项目经理。项目经理使用独立注册机签发绑定该机器的授权码。注册机是原生小工具，不依赖 Electron。

本机打开窗口：

```bash
npm run license:issuer
```

打出可分发文件（Mac 本地得到 macOS 可执行文件，Windows 得到 `.exe`）：

```bash
npm run package:issuer
```

产物在 `release/issuer/`，会把 `tools/license-issuer/keys/license-2026a.pem` 一并放进同一目录，打开后自动签发。Windows exe 走 GitHub Actions 工作流 `License Issuer`：私钥不进 git，必须在仓库 secret 配置 `DATABAKER_LICENSE_PRIVATE_KEY`（PEM 全文），否则打包会失败。

技术支持也可用命令行：

```bash
npm run license:issue -- --machine A7K2-9M3P-Q4WX --days 365
./release/issuer/DataBaker-License-Issuer --machine A7K2-9M3P-Q4WX --days 365
./release/issuer/DataBaker-License-Issuer --clear-local
```

窗口底部可以清空本机采集软件已激活的授权（`userData/license.json` 及其损坏备份）。请先退出采集软件。可用 `--license-file` 或 `DATABAKER_LICENSE_FILE` 指定文件。

私钥默认放在 `tools/license-issuer/keys/license-2026a.pem`，不进 git，也不打进采集安装包。注册机打包会复制到程序旁并自动使用，窗口里不用选私钥，也不再要口令。

## 验证与打包

```bash
npm test
npm run build
npm run package:dir
```

Windows 安装包应在 Windows x64 构建机上执行 `npm run package`。Rust sidecar 必须在目标平台编译，不能把 macOS 二进制直接打入 Windows 安装包。

### Sentry 错误与日志

主进程和所有 renderer 都会初始化 `@sentry/electron`。生产包默认上报未捕获异常、原生崩溃、renderer 退出、录音引擎离线，以及 `warn` / `error` 和关键录制生命周期日志；不会采集截图或默认个人信息。发送前会过滤本地路径、录制任务 ID、脚本内容和常见密钥字段。

- `SENTRY_DSN`：可覆盖内置的公开 DSN；设置为空字符串可关闭上报。
- `DATABAKER_SENTRY_DISABLED=1`：在本地运行时临时关闭 Sentry。
- `SENTRY_ENVIRONMENT`：可覆盖默认的 `development` / `production` 环境名。
- `.env.sentry-build-plugin`：Wizard 创建的本地 source map 上传 token 文件，已加入 `.gitignore`，不能提交。
- GitHub Actions：在仓库 secret 中配置 `SENTRY_AUTH_TOKEN`，Windows 打包时会上传 renderer、main 和 preload 的 source map；安装包不会包含应用自身的 `.map` 文件。没有 token 时，本地构建仍会成功，但会跳过上传。

### Windows 外置声卡生产验收

源码环境可直接枚举引擎识别的声卡：

```bash
npm run acceptance:audio -- --mode inventory
```

正常短录和长稳会先执行环境噪声检测与 10 秒输入试听，再真实执行一次句子开始、停止、确认和导出。噪声检测缺失、报错或 `passed=false`，期望/选择/实际后端不一致，ASIO 请求/实际缓冲区缺失，或 `input_discontinuity_count != 0` 都直接 FAIL。生产资格计划必须在 `target.noise_threshold_dbfs` 固定噪声阈值（`-96` 至 `-40` dBFS），采集 run 的 `--noise-threshold-dbfs` 必须与计划值精确一致且不得高于 `-40 dBFS`；10 秒输入试听必须恰好覆盖 `sample_rate * 10` 个样本。生产资格采集 run 还必须用 `--expected-capture-backend`（ASIO 同时用 `--expected-capture-buffer-frames`，默认 512）独立声明期望；`--skip-noise-check` 仅用于调试，不具备生产验收或资格证据效力。

Windows 安装包会把验收工具、启动器和文档放在 `resources/acceptance/`。工具覆盖 16/24/32-bit 短录、2–8 小时长稳、USB 拔出、专用测试卷磁盘保护，以及 `power-cut` → 重启 → `recover` 的真实断电两阶段门禁。生产 `power-cut` 只有在至少 1 小时样本已 committed、文件仍增长、尾差在预算内且 `overflow_samples=0` 时，才会把该零溢出事实写入 nonce armed 证据并提示断电；资格汇总会在 phase-1 报告、独立证据、会话内证据和 armed telemetry 之间交叉验证。`recover` 必须显式传入独立的 `--phase1-report`，并与会话内证据逐字段一致，同时匹配同一主机的新 boot、恢复前非终态和 `no_op=false`；正常 stopped 任务、仅杀进程、修改单份证据或丢失 armed committed 音频都不能 PASS。它还会严格检查 WAV 头部/EOF、分段编号、完整帧、物理样本水位、导出 status/metadata/CSV 一致性、overflow/fault marker 和引擎退出。显式的 `--test-only-power-cut` 短时回归只会生成 `TEST_ONLY_PASS` / `production_eligible=false`，不具备生产验收资格。Windows CI 还会静默安装实际 NSIS 产物、从安装目录运行验收启动器，并与安装包一起发布 `SHA256SUMS.txt`。完整命令和 PASS/FAIL 标准见 [Windows 外置声卡生产验收](doc/Windows外置声卡生产验收.md)。

当前交付仍属于小范围试运行，正式工位资格不是本版上线门槛；USB 物理插口也不会被绑定或比较。现场边界与回退条件见 [受控试运行说明](doc/受控试运行说明.md)。

### 推荐采集参数

- 本次受控试运行默认：`48,000 Hz / 16-bit PCM / Mono`。
- 驱动可用更高精度样本格式时，可选 `i24` / `i32` / `f32` 作为实际输入；本版交付仍为 16-bit PCM。
- 多输入声卡会显示“输入 1、输入 2…”；软件从所选硬件通道采集并交付单声道 WAV。

驱动输入格式选项列出当前设备在所选后端、采样率和输入通道下真正能开的样本类型（`i16` / `i24` / `i32` / `f32`）。它只描述驱动如何把数据交给软件，不会改变本次试运行的 `48 kHz / 16-bit PCM / Mono` 交付规格；引擎会在写入母带前完成格式转换。Focusrite 等专业声卡优先使用厂商 ASIO 驱动，默认请求 512 帧缓冲区；ASIO 开流失败会明确报错，不会静默降级到 WASAPI/WDM。普通麦克风和未提供 ASIO 的 USB 设备继续使用 WASAPI 兼容路径。任务会分开记录后端、请求/实际缓冲区、驱动输入格式与交付 WAV 编码。Windows 验收工具按有效数字精度判定输入门槛（整数 `n` bit 按 `n`，`f32=24`，`f64=53`）。该数字样本精度不等于声卡 ADC ENOB，后者仍需根据硬件规格和专业测量归档。

当前 Windows 采用 ASIO + WASAPI 双后端：专业声卡走 ASIO，WASAPI 保留给系统麦克风和普通 USB 设备。Focusrite 的 WASAPI/WDM 端点会被正式录制门禁拦截，必须选择 `Focusrite USB ASIO`。

## 录制数据

一份「录制」对应一个独立、可搬运的本地目录：

```text
<recording>/
├── audio/
│   └── segments/
│       ├── master-000001.wav
│       ├── master-000002.wav
│       └── …
├── metadata/events.jsonl
├── metadata/items.snapshot.json
├── metadata/session.lock
├── preview/*.wav
├── script/normalized.json
├── session.json
└── export/
├── full-track.wav
├── sentences/
│   └── <六位顺序>-<item-id>.wav
    ├── metadata.csv
    └── metadata.json
```

当前代码已实现第一版的核心数据安全基线：分段母轨、物理 EOF 恢复、事件重放、会话独占锁、磁盘余量保护、故障数据禁止常规交付，以及 Renderer/引擎异常恢复。本版仅按《受控试运行说明》小范围使用；若后续升级为正式工位资格版本，仍需通过真实 Windows 声卡的长稳、断电、拔设备、磁盘写满和强杀故障注入门禁。

### 本地存储策略

当前不引入 IndexedDB、JSON 数据库或 SQLite。每个录制目录中的 `items.snapshot.json` 是可替换的当前状态投影，`events.jsonl` 保留最新的完整持久化事件（写入新事件时短暂为旧+新两条），启动时以 journal 序号校验并修复落后快照。分段音频、快照、journal 和导出文件一起构成可搬运、可人工检查的完整数据单元。历史录制页直接扫描已授权保存目录，并把数据库式索引视为可选缓存，而不是事实源。

当单个保存位置达到数千份录制，或需要全文搜索、标签、跨录制统计和分页时，再加入 SQLite 作为可从录制目录重建的索引。即使未来增加索引，录制目录格式仍保持独立可恢复。
