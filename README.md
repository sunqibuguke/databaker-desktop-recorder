# DataBaker 桌面音频采集

Electron + React + TypeScript 桌面操作台，配套 Rust 原生录音引擎。当前版本面向本地可落地的逐句朗读采集：持续写入一条母音频，每次录制只保存整数样本边界，确认后导出独立 WAV。

## 当前可用能力

- 启动进入「录制」中心，可新建录制、筛选历史录制、打开目录或重新导出。
- 导入 UTF-8 CSV / TSV / TXT，标准三列为“序号 / 句子正文 / 标签（备注）”；兼容历史 `id,text` 两列和普通逐行 TXT。
- 枚举系统识别的麦克风与外置声卡输入，可选择设备、采样率和输入通道。
- 可设置 16-bit PCM、24-bit PCM（默认）或 32-bit Float，母带、试听切片与最终导出保持同一 Mono WAV 格式。
- Windows 使用系统音频驱动链路（CPAL/WASAPI）；常见 USB 声卡只要能在 Windows 输入设备中识别即可使用。
- 新建或恢复一次录制后会自动执行一次约 3 秒的环境噪声检测；通过后，本次录制期间的所有句子和重录都不再重复检测。每句的句首/句尾静音门控仍保留。
- 录制中始终可停止：未检测到语音时取消当前句，已有语音但尾静音不足时可强制完成并进入试听确认。
- 可配置每句前后的连续静音时长（0.2–5.0 秒，默认 1.0 秒）；Rust 引擎对“可开始”与“可完成”双向门控。
- 主界面和独立领读窗口同步显示黄（检测中）、绿（就绪）、红（录制中）、蓝（尾静音达标）。领读窗口优先打开在外接显示器。
- Rust 端提取 PCM min/max 包络，WebGL 以固定媒体时间轴渲染实时波形，并显示 Peak / RMS 和写盘状态。
- 每句支持开始、结束、试听、手动确认、重录、跳过；历史 attempt 不覆盖。
- 业务事件先同步写入带序号的 JSONL journal，再原子替换快照；启动时可从最新持久化事件重建状态。
- 母轨默认每 5 分钟封存为一个不再修改的 WAV 段；最后活动段始终连续写入，约每 10 秒按“先同步音频、再同步 WAV 头”做一次昂贵 checkpoint，避免每秒 `FlushFileBuffers`；廉价的磁盘余量检查仍每秒执行，不会被频繁完成短句推迟。异常断电默认按 15 秒尾差验收，可配置上限为 30 秒。
- 异常启动可自动修复落后/超前的 WAV 头和不完整尾帧；队列溢出、写盘故障或磁盘余量进入安全线后 fail-closed，不再伪造连续时间轴。
- 一键导出整轨 `full-track.wav`、选中 attempt 的单句 WAV bundle、`metadata.json` 和 `metadata.csv`。
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

可直接导入 `examples/script.tsv` 体验完整流程。环境检测通过后，按空格录制第一句。

## 验证与打包

```bash
npm test
npm run build
npm run package:dir
```

Windows 安装包应在 Windows x64 构建机上执行 `npm run package`。Rust sidecar 必须在目标平台编译，不能把 macOS 二进制直接打入 Windows 安装包。

### Windows 外置声卡生产验收

源码环境可直接枚举引擎识别的声卡：

```bash
npm run acceptance:audio -- --mode inventory
```

Windows 安装包会把验收工具、启动器和文档放在 `resources/acceptance/`。工具覆盖 16/24/32-bit 短录、2–8 小时长稳、USB 拔出、专用测试卷磁盘保护，以及 `power-cut` → 重启 → `recover` 的真实断电两阶段门禁。生产 `power-cut` 只有在至少 1 小时样本已 committed、文件仍增长且尾差在预算内时才会落盘 nonce 证据并提示断电。`recover` 必须显式传入独立的 `--phase1-report`，并与会话内证据逐字段一致，同时匹配同一主机的新 boot、恢复前非终态和 `no_op=false`；正常 stopped 任务、仅杀进程、修改单份证据或丢失 armed committed 音频都不能 PASS。它还会严格检查 WAV 头部/EOF、分段编号、完整帧、物理样本水位、导出 status/metadata/CSV 一致性、overflow/fault marker 和引擎退出。显式的 `--test-only-power-cut` 短时回归只会生成 `TEST_ONLY_PASS` / `production_eligible=false`，不具备生产验收资格。Windows CI 还会静默安装实际 NSIS 产物、从安装目录运行验收启动器，并与安装包一起发布 `SHA256SUMS.txt`。完整命令和 PASS/FAIL 标准见 [Windows 外置声卡生产验收](doc/Windows外置声卡生产验收.md)。

### 推荐采集参数

- 常规高清语音数据：`48,000 Hz / 24-bit PCM / Mono`。
- 后期处理链路需要较大余量时：`48,000 Hz / 32-bit Float / Mono`。
- 多输入声卡会显示“输入 1、输入 2…”；软件从所选硬件通道采集并交付单声道 WAV。

位深选项控制实际写入 WAV 的编码，不是只写入元数据。硬件输入会优先使用驱动暴露的高精度采样格式，再转换为所选交付格式。如果声卡只提供低精度输入，选择更高交付位深不会凭空增加硬件有效精度。Windows shared mode 下，候选客户端格式还会受 `GetMixFormat` 有效精度上限约束；不会把 Windows 音频引擎接受格式转换误当成声卡精度升级。Windows 验收工具会分别记录输入样本格式与交付 WAV 位深，并按有效数字精度判定输入门槛（整数 `n` bit 按 `n`，`f32=24`，`f64=53`）。该数字样本精度不等于声卡 ADC ENOB，后者仍需根据硬件规格和专业测量归档。

当前 Windows 基线是 WASAPI，覆盖无需厂商 SDK 的部署场景。仅提供 ASIO、且不提供可用 Windows 输入端点的特殊声卡不在当前基线内，应作为单独的驱动兼容项目验证。

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

当前代码已实现第一版的核心数据安全基线：分段母轨、物理 EOF 恢复、事件重放、会话独占锁、磁盘余量保护、故障数据禁止常规交付，以及 Renderer/引擎异常恢复。正式面向客户采集前仍必须通过 Windows WASAPI + 真实 USB 声卡的长稳、断电、拔设备、磁盘写满和强杀故障注入门禁；未通过时不应宣称生产发布就绪。

### 本地存储策略

当前不引入 IndexedDB、JSON 数据库或 SQLite。每个录制目录中的 `items.snapshot.json` 是可替换的当前状态投影，`events.jsonl` 保留最新的完整持久化事件（写入新事件时短暂为旧+新两条），启动时以 journal 序号校验并修复落后快照。分段音频、快照、journal 和导出文件一起构成可搬运、可人工检查的完整数据单元。历史录制页直接扫描已授权保存目录，并把数据库式索引视为可选缓存，而不是事实源。

当单个保存位置达到数千份录制，或需要全文搜索、标签、跨录制统计和分页时，再加入 SQLite 作为可从录制目录重建的索引。即使未来增加索引，录制目录格式仍保持独立可恢复。
