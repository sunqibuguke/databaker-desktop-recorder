# 外部设备 WAV 切分脚本

## 用途

使用 DataBaker 导出的 `timestamps.json`，将另一台设备录制的整段 WAV 自动切成多个逐句 WAV。脚本不会生成 ZIP。

> 请使用 `timestamps.json`，不要使用 `status-full-track.json` 或 `status-timestamps-json.json`。

## 基本用法

```bash
python scripts/cut_external_wav.py \
  "另一台设备录制的.wav" \
  "timestamps.json" \
  -o "切分结果"
```

脚本会在“切分结果”文件夹中直接生成多个 WAV。

## 录音开始时间不一致

默认假设两台设备同时开始录音。如果外部设备比 DataBaker 早开始 2.35 秒，使用：

```bash
python scripts/cut_external_wav.py \
  "另一台设备录制的.wav" \
  "timestamps.json" \
  -o "切分结果" \
  --offset-seconds 2.35
```

建议录音开始时在两台设备上同时录下一次拍手或提示音，用该声音确定时间差。

## 注意事项

- 需要 Python 3，不需要安装额外 Python 库。
- 输入音频需为未压缩 PCM WAV。
- 如果输出目录已有同名文件，脚本会停止；确定需覆盖时可加 `--overwrite`。
- 查看全部参数：`python scripts/cut_external_wav.py --help`。
