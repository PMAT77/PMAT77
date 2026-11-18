# 语音朗读生成器

## 简介

这个工具把文章转成朗读音频，供博客详情页的播放器使用。它离线运行，只在本机执行，不参与网站构建。

流程分为四步：读取 `source/_posts` 下的文章，清洗成适合朗读的纯文本，调用 GPT-SoVITS 的 HTTP 接口克隆音色，最后用 ffmpeg 把 WAV 转成 MP3。输出目录是 `source/audio/`，Hexo 构建时自动复制到 `public/audio/`，再通过部署脚本上传到 GitHub Pages。

生成过程按文章增量执行。正文没有改动、音色没有更换的文章会跳过，只重新合成有变化的文章。站点构建只读取生成结果，因此部署、构建都不需要 GPU，也不需要联网。

## 环境准备

### GPT-SoVITS

本机的 GPT-SoVITS 需要能通过命令行启动 `api_v2.py`。Windows 上有两种安装方式，选一种即可。

整合包最省事。从 [GPT-SoVITS 官方发布页](https://github.com/RVC-Boss/GPT-SoVITS/releases) 下载 Windows 整合包，解压到不含空格的路径，例如 `D:\Tools\GPT-SoVITS`。确认目录下存在 `runtime\python.exe` 与 `api_v2.py`。若整合包缺少 `api_v2.py`，从仓库根目录复制该文件进来。

源码安装适合想升级模型或微调音色的情况：

```powershell
conda create -n GPTSoVits python=3.10
conda activate GPTSoVits
pwsh -F install.ps1 --Device CU126 --Source HF-Mirror
```

安装完成后，把 `gptSovits.python` 改成本环境的 `python.exe` 绝对路径。8 GB 显存可以运行 v2 与 v2Pro 模型；开启并行推理或换更大模型时先观察显存占用。

### ffmpeg

接口只返回 WAV，MP3 由 ffmpeg 转码。安装并确认命令可用：

```powershell
winget install Gyan.FFmpeg
ffmpeg -version
```

如果不想单独安装，可以把 `ffmpeg` 配置成 GPT-SoVITS 目录里自带的 `ffmpeg.exe` 绝对路径。

### 参考音频

零样本克隆只需要一段 3～10 秒的干净人声，不需要训练模型。

选择安静环境下的单人说话片段，不要有背景音乐、混响或第二个人声。格式用 wav 或 mp3 均可。参考音频和逐字文本要严格对应：`promptText` 写参考音频里实际说出的内容，多一个字或少一个字都会明显影响相似度。

把文件放进 `tools/tts/ref/`，该目录已被 git 忽略，避免音色样本随仓库公开。

### 微调权重（可选）

零样本不满意时，可以在 GPT-SoVITS WebUI 里用几分钟素材训练，得到两个文件：GPT 模型的 `.ckpt` 和 SoVITS 模型的 `.pth`。把它们放进 `tools/tts/weights/`（同样被 git 忽略），再填 `voice.gptWeights` 与 `voice.sovitsWeights`，工具会在启动后通过 `/set_gpt_weights`、`/set_sovits_weights` 把权重热加载进接口，其余流程不变。

两个前提：

- 权重的模型版本要匹配。v2ProPlus 的微调权重只能加载到 `tts_infer.yaml` 里 `version: v2ProPlus`（或 v5 系列对应版本）的接口上，版本不符时接口可能不报错但输出静音。
- 文件名不影响识别。GPT-SoVITS 的 SoVITS 权重是“2 字节版本头 + zip”，版本头（`06` 是 v2ProPlus）决定加载哪套网络，不要用普通 `torch.load` 读取，也不要在前面补 `PK`，否则会被当成 v2 处理。

权重文件较大（本例约 330 MB），仓库只记录路径，不提交二进制文件。

## 配置

复制示例配置，再按本机路径修改：

```powershell
Copy-Item tools/tts/config.example.json tools/tts/config.json
```

配置文件同样被 git 忽略，只保留在本机。字段说明：

| 字段 | 作用 |
| --- | --- |
| `api.baseUrl` | GPT-SoVITS 接口地址，默认 `http://127.0.0.1:9880` |
| `api.timeoutMs` | 单次请求超时，长文分块后一般够用 |
| `api.retries` | 网络错误和 5xx 的重试次数，400 类错误不重试 |
| `gptSovits.dir` | GPT-SoVITS 根目录，`--serve` 时在其下启动接口 |
| `gptSovits.python` | 相对于 `dir` 的 Python 路径，整合包为 `runtime/python.exe` |
| `gptSovits.config` | 模型配置文件，默认 `GPT_SoVITS/configs/tts_infer.yaml` |
| `gptSovits.stopOnExit` | 生成结束后是否关闭由本工具启动的接口 |
| `gptSovits.g2pwDir` | G2PW 多音字词表目录，默认 `GPT_SoVITS/text/g2pw` |
| `gptSovits.polyphonicFile` | 要同步的词表文件名，默认 `polyphonic-fix.rep` |
| `voice.refAudio` | 参考音频路径，相对仓库根目录或绝对路径 |
| `voice.refAudios` | 多段参考音频路径数组，第一段为主参考，最多 3 段；留空时用 `refAudio` |
| `voice.promptText` | 参考音频的逐字文本，留空会明显降低相似度 |
| `voice.promptLang` | 参考音频语言，中文为 `zh` |
| `voice.textLang` | 朗读文本语言，中文为 `zh` |
| `voice.speed` | 语速倍数，`1` 为原速 |
| `voice.parallelInfer` | 并行推理，显存紧张时保持 `false` |
| `voice.gptWeights` | 可选的 GPT 微调权重 `.ckpt`，留空用底模 |
| `voice.sovitsWeights` | 可选的 SoVITS 微调权重 `.pth`，留空用底模 |
| `voice.tuning` | 采样与切分参数，见下文「调参与试听」 |
| `audio.bitrateKbps` | MP3 码率，默认 48，单声道足够 |
| `audio.maxChunkChars` | 单次请求的最大字数，超长文章按句切块 |
| `audio.chunkGapMs` | 块与块之间的静音间隔 |
| `audio.paragraphGapMs` | 段落之间的静音间隔，默认 400 毫秒 |
| `ffmpeg` | ffmpeg 命令或可执行文件路径 |

若想换成微调后的模型，改 `gptSovits.config` 指向的 `tts_infer.yaml`，其余调用方式不变。

## 使用

### 查看生成计划

先跑一次试运行，确认扫描到的文章、跳过原因和预估时长：

```powershell
npm run tts -- --dry-run
```

试运行不启动服务，也不调用接口。正文清洗后少于 60 字的文章会跳过，例如空文章或只有标题的随笔。

### 生成音频

先启动接口再生成。两种启动方式选一种：

```powershell
npm run tts:serve   # 由工具启动 GPT-SoVITS，生成结束后默认保留服务
npm run tts         # 接口已在运行时直接生成
```

生成日志会列出每篇的音频文件、时长、体积和耗时。单篇失败不会中断整批任务，结束时汇总失败清单，退出码为 1。

每生成一篇就会写入清单，中途按 Ctrl+C 可以安全退出，下次运行只补做剩下的文章。

调试音色时可以只处理一部分文章：

```powershell
npm run tts -- --only 514路
npm run tts -- --only tech/
```

### 重新生成

`--force` 表示不信任现有结果，即使正文没变也重新合成：

```powershell
npm run tts -- --force
```

文章已删除、写了 `audio: false`、或正文短于 60 字时，清单里的旧条目与音频会在每次运行时自动清理，不需要 `--force`。

切换音色不需要 `--force`。音色指纹包含参考音频、逐字文本、语言、语速和音色名，任意一项变化都会让全部选中文章重新生成。

## 调参与试听

### 参数怎么影响朗读

`voice.tuning` 里的参数直接发给 `/tts`，决定发音的随机程度与分句方式：

| 参数 | 默认 | 调大之后 |
| --- | --- | --- |
| `temperature` | `1` | 语调起伏更大，也更容易抖 |
| `topK` | `15` | 选词更发散，可能冒出奇怪读音 |
| `topP` | `1` | 同上，一般和 `topK` 一起调 |
| `repetitionPenalty` | `1.35` | 更积极打断复读，过大可能吞字 |
| `seed` | `-1` | `-1` 表示每次随机，固定数字可复现同一段 |
| `textSplitMethod` | `cut5` | `cut2` 按中文句号切，`cut0` 不切 |
| `fragmentInterval` | `0.3` | 分句之间的静音秒数，调大更像聊天 |
| `sampleSteps` | `0` | 只对 v3、v5 生效；`0` 用服务端默认 |
| `cfgRate` | `0` | 只对 v3、v5 生效；`0` 用服务端默认 |

`audio.paragraphGapMs` 控制段落之间的静音。分块边界尽量落在段落上，所以长文会自然多出几处换段停顿；短文只有一段时不起作用。

`voice.refAudios` 可以一次给 2～3 段同一音色的参考音频，第一段作为主参考，其余作为辅助。每段仍需满足 3～10 秒、单人、干净人声的要求，工具会用 ffprobe 检查时长，超出范围只警告。

### 试听对比

不想凭感觉调参时，用试听工具一次生成 8 组对比：

```powershell
npm run tts:tune -- --serve
```

它会从 `source/_posts/essay/514路.md` 取一段约 220 字，按 8 个变体各生成一条 96 kbps 的 MP3，写到 `artifacts/tune/`。用浏览器打开 `artifacts/tune/index.html` 即可逐条试听；试听文件不进 `public/`，不会随站点部署。

只跑其中一组：

```powershell
npm run tts:tune -- --variant temp-06
npm run tts:tune -- --chars 400
npm run tts:tune -- --dry-run
```

选好之后，把对应的参数写进 `tools/tts/config.json` 的 `voice.tuning`，再全量生成一次。调参属于音色指纹的一部分，改完会自动让所有文章失效，不需要 `--force`。

## 多音字与文本替换

### 替换朗读文本

正文里的专有名词、缩写或符号，可以在朗读时替换成更顺口的写法，页面显示不受影响。词条写在 `tools/tts/lexicon.json`，全局生效，长词优先：

```json
{
  "PMAT77": "P M A T 七十七",
  "GPT-SoVITS": "GPT 索维茨"
}
```

单篇文章要额外处理时，在 front-matter 里写 `audio_lexicon`，同名键会覆盖全局：

```yaml
audio_lexicon:
  甘雨: "甘雨"
```

### 教模型读多音字

G2PW 决定多音字读音。词条写在 `tools/tts/pronunciation.json`，拼音个数必须与字数一致，声调用数字表示：

```json
{
  "重庆": ["chong2", "qing4"],
  "银行": ["yin2", "hang2"]
}
```

同步进 GPT-SoVITS 的词表：

```powershell
npm run tts:pronounce -- --dry-run
npm run tts:pronounce -- --restart
```

第一次写入会把原词表备份为 `.bak`，并清掉 `polyphonic.md5`、`polyphonic.pickle`，让 G2PW 下次启动时重建缓存。词表在模块导入时加载，所以必须重启接口才生效；不加 `--restart` 时按提示手动重启。

## 试 v5 模型

v5 系列（`v5turbo`、`v5dev`）在高相似度和韵律上更强，但仍建议先调 `voice.tuning` 与参考音频。想对比时，用仓库里的 `tools/tts/tts_infer.v5.yaml`：

1. 复制到 GPT-SoVITS 根目录，或把其中 `custom` 段覆盖进现有的 `tts_infer.yaml`。
2. 保持 `voice.gptWeights`、`voice.sovitsWeights` 为空，用官方 v5 预训练权重（v2ProPlus 的微调权重不能混用）。
3. 启动接口后先 `npm run tts -- --only 514路 --force` 试听，再决定是否全量。

工具会读 SoVITS 权重文件头的两个字节判断版本，与 `tts_infer.yaml` 的 `custom.version` 不一致时在启动阶段给出警告。



文章 `source/_posts/essay/514路.md` 对应音频 `source/audio/essay/514路.mp3`。清单写在 `tools/tts/manifest.json`，记录每篇的音频路径、时长、大小和内容指纹。

`source/audio/` 与清单一并忽略版本控制。它们只在本机存在，构建时复制进 `public/audio/`，随 `npm run deploy` 一起发布。换一台机器构建时，没有音频文章就不显示播放器，构建照常完成。

发布流程与平时一致：

```powershell
npm test
npm run build
npm run deploy
```

构建日志里出现 `Generated: js/audio.js`，说明播放器脚本已产出。详情页 HTML 中出现 `class="post-audio"`，说明这篇文章挂上了音频。

## 单篇控制

在文章开头的 YAML 里加一行即可关闭朗读：

```yaml
audio: false
```

删除 `tools/tts/manifest.json` 会关闭全站播放器。构建不会因此失败，只是把所有文章按没有音频处理。

## 故障处理

**找不到 GPT-SoVITS 的 Python。** 检查 `gptSovits.python` 是否相对 `gptSovits.dir` 存在；源码安装时填 conda 环境的 `python.exe` 绝对路径。

**接口未启动。** 报错信息会给出完整启动命令。也可以手动在 GPT-SoVITS 目录执行：

```powershell
runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

**接口返回 400。** 常见原因是 `ref_audio_path` 不存在、`prompt_text` 与参考音频不匹配，或模型配置指向的预训练权重缺失。报错正文会带出服务端的 `detail` 字段，按提示逐项核对。

**显存不足。** 关闭其他占用显卡的程序，保持 `parallelInfer: false`、`batchSize: 1`，或换用更小的模型版本。

**生成的音频只有一秒或接近静音。** 通常是权重版本与接口配置不匹配。用 GPT-SoVITS 自带的 Python 执行 `get_sovits_version_from_path_fast(权重路径)`，确认返回值里的版本与 `tts_infer.yaml` 的 `version` 一致；不一致就改配置或换对应版本的权重，然后重新加载权重。

**调参后音频没变化。** 先跑 `npm run tts -- --dry-run`，确认待生成数量不为 0。改 `voice.tuning`、`refAudios` 或 `audio.paragraphGapMs` 都会改变音色指纹，正常情况下会自动重做全部文章。播放器右下角的倍速只是 `playbackRate`，不改音频文件，也不影响模型语速。

**段落之间听不出停顿。** 段落停顿只插在分块边界上，短片只有一块时不会出现。想让句间更松可以调大 `voice.tuning.fragmentInterval`，想整体更慢可以调 `voice.speed`（会触发全量重生成）。

**找不到 ffmpeg。** 命令不在 PATH 时，把 `ffmpeg` 改成 `ffmpeg.exe` 的绝对路径。

**播放器不出现。** 依次确认三件事：`tools/tts/manifest.json` 存在；对应 MP3 在 `source/audio/` 下；文章没有写 `audio: false`。然后重新 `npm run build`。

**提示另一个进程正在运行。** 生成过程用 `tools/tts/.lock` 防止并发。确认没有任务在跑后，删除该文件再重试。

**停止后台接口。** 浏览器打开 `http://127.0.0.1:9880/control?command=exit`，或直接关闭由 `--serve` 启动的控制台窗口。

## 已知限制

音频按整篇生成，播放器只能按时间拖动，不做逐句高亮。需要跟读时，可以后续再输出 SRT 字幕。

语感和停顿不自然时，按这个顺序排查：换一段同音色的说话参考音频（清唱、唱歌或带背景音乐的素材效果明显更差），再调 `voice.tuning` 的 `fragmentInterval` 与 `repetitionPenalty`，最后才考虑换 v5 模型。多音字读错用 `pronunciation.json` 修正，专有名词读法用 `lexicon.json` 替换。

零样本克隆的上限取决于参考音频。想要更高的相似度，可以在 GPT-SoVITS WebUI 里用 1 分钟以上素材做微调训练，把产物路径填进 `voice.gptWeights` 和 `voice.sovitsWeights` 即可，本工具无需改动。微调模型对参考音频更宽容，但仍建议用同一音色的 3～10 秒片段，效果更稳。

生成耗时大致与正文长度成正比，首次请求还要加载模型。31 篇文章全部生成建议安排在空闲时段。

音频不进版本库，因此 GitHub Actions 等远程构建环境不会自动带上朗读。若改用远程构建，需要额外准备音频产物。
