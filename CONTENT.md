# 内容维护

## 源码与部署

本仓库的 `source` 分支保存 Hexo 源码、文章、草稿、主题和测试；`main` 分支保存生成的静态站点。日常修改在 `source` 分支提交，运行 `npm ci`、`npm test` 和 `npm run build` 检查后，通过 `npm run deploy` 发布到 `main`。

`node_modules/`、`public/`、`artifacts/`、`.history/` 和运行缓存由本地生成，不纳入源码提交。

主题以完整文件纳入源码版本控制，保留各自的许可证。原嵌套 Git 元数据备份在本机 `artifacts/theme-git-backup-20261114/`。

首页保留最近 10 篇文章。四个栏目自动生成，不需要手写栏目页面。未指定 `content_type` 的新文章默认归入随笔；技术与小说请使用对应模板。

文章按 YAML 中的 `content_type` 存放在 `source/_posts/` 的子目录：

```text
source/_posts/
  essay/   # content_type: essay（随笔）
  tech/    # content_type: tech（技术文章）
  novel/   # content_type: novel（小说）
```

Hexo 会读取这些子目录，构建和部署命令保持不变。永久链接使用 `:year/:month/:day/:name/`，其中 `:name` 只取文件名，因此移动目录不会改变已有文章地址。文件名应在所有子目录间保持唯一，避免同日文章的地址冲突。

新建时通过 Hexo 原生 `--path` 指定目录，如下所示。目录仅用于整理文件，网站栏目仍由 `content_type` 决定；修改类型时，请同步移动文件。省略 `--path` 的旧命令仍能正常生成文章，但文件会放在 `_posts` 根目录，不会自动归档。

## 随笔

```powershell
npx hexo new essay 20261028-153000 --path essay/20261028-153000.md
```

文件名用于生成稳定链接，可以用日期时间命名，不必写标题。需要标题时再在文章开头的 YAML 中添加 `title: 标题`。省略、留空或只填空白均视作无标题；正文页不会显示文件名。首页、搜索、归档和 RSS 使用正文前 30 个 Unicode 字符作为链接文字，空正文使用发布日期。

随笔页按时间倒序，每页 10 条。默认展示全文；希望截断长文时，在正文中插入 `<!--more-->`，其后内容仅在详情页出现。图片、链接和代码块正常使用 Markdown 编写。

## 技术文章

```powershell
npx hexo new tech 单点登录实践 --path tech/单点登录实践.md
```

保留 `content_type: tech` 并填写 `title`、`date`、`tags`。栏目摘要取 `<!--more-->` 之前的文字；没有分隔符时取正文前 140 字。详情页按正文标题自动生成可折叠目录。技术页的搜索只查技术文章，原归档搜索仍查询所有文章。

## 连载小说

在 `source/_data/novels.yml` 中登记作品；列表顺序就是作品展示顺序：

```yaml
- id: twelve-pieces
  title: 十二新作
  intro: ""
  status: 连载中
```

`id` 是唯一的小写英文或数字标识，可含连字符，决定目录地址 `/novels/twelve-pieces/`。缺省状态为“连载中”，简介为空时不显示。

```powershell
npx hexo new novel 第三章 --path novel/第三章.md
```

章节需要 `content_type: novel`、`novel_id: twelve-pieces`、`novel_section: chapter`，以及同书不重复的数字 `chapter_order`。顺序可以从 0（序章）开始，也可以用小数插入番外；它不受文章发布日期影响。创建后务必修改模板中的章节序号。

角色、势力等设定使用同一 `novel_id`，将 `novel_section` 改为 `lore` 并去掉 `chapter_order`。设定单独列在目录中，按发布日期正序排列，不参与上一章／下一章。

已有文章的文件名和日期应保持不变；修改这些值会影响旧链接。标题、标签和原分类可以照常维护。`source/_drafts` 中的草稿不会因栏目改造而发布。

草稿仍可使用 `npx hexo publish 文件名` 发布，再根据 `content_type` 将生成的文章移入对应子目录；移动时保留文件名和日期。

## 项目展示

项目列表在每次 Hexo 构建时自动同步 `PMAT77` 的公开原创仓库，排除 fork、归档仓库和博客自身，并按最近代码推送时间倒序排列。`npm run build`、`npx hexo generate` 和启动预览服务时均会同步；更新 README 后重新构建并发布即可更新网站。

在根目录 `_config.yml` 中可修改账号或排除更多仓库：

```yaml
github_projects:
  enable: true
  username: PMAT77
  exclude:
    - PMAT77
```

保留封面卡片布局。默认使用仓库名称和简介，没有封面时显示项目名占位封面。点击卡片进入 `/projects/仓库名/`，展示语言、Star、更新时间和 README；详情页保留 GitHub 原仓库入口。README 的相对图片、文档链接和页内目录会自动处理，外部图片仍从原服务加载；没有 README 时显示简介和 GitHub 入口。项目不混入首页文章、归档、搜索或 RSS。

`source/_data/projects.yml` 仅用于按仓库地址覆盖标题或封面；不需要列出全部仓库，保持 `[]` 即可自动展示。示例：

```yaml
- github: https://github.com/PMAT77/bubble-shark-panel
  title: BubbleSharkPanel
  cover: /images/projects/project-name.webp
```

`title` 和 `cover` 均可省略。将封面放在 `source/images/projects/`，建议使用 16:9 截图；也支持完整 HTTPS 图片地址。设置 `github_projects.enable: false` 后，仅按 `projects.yml` 的顺序展示手工项目，仍生成站内详情页和 GitHub 入口。

同步成功后会更新 `data/github-projects.json`。请将这个公开数据快照随源码一起提交，以便其他机器在离线时也能构建。网络失败、超时或限流时会输出警告并复用快照；没有快照时使用手工项目或空状态，继续生成文章。单次请求超时 8 秒，整个网络同步最多 20 秒。

运行环境需要 Node.js 20.3 或以上。公开仓库无需 Token；需要提高请求额度时，可在构建环境设置 `GITHUB_TOKEN`，它只用于请求头，不会写入快照或网页。不要将 Token 填入 YAML 或提交到仓库。

## 语音朗读

详情页可以在正文上方显示朗读播放器。音频由本机 GPT-SoVITS 克隆音色离线生成，构建只读取生成结果，不需要显卡，也不需要联网。

首次使用先按 `tools/tts/README.md` 安装 GPT-SoVITS 和 ffmpeg，准备 3～10 秒参考音频，再复制配置：

```powershell
Copy-Item tools/tts/config.example.json tools/tts/config.json
```

在 `voice` 段填写 `refAudio`（参考音频路径）、`promptText`（参考音频里说出的原文）和音色名，然后生成：

```powershell
npm run tts:serve        # 启动接口并生成全部待更新音频
npm run tts              # 接口已在运行时直接生成
npm run tts -- --dry-run # 只查看计划
npm run tts -- --only 514路
```

音频写在 `source/audio/`，清单写在 `tools/tts/manifest.json`，两者都不提交。构建时 `source/audio/` 复制进 `public/audio/`，随 `npm run deploy` 一起发布。

音频按正文与音色指纹增量生成：正文、参考音频、逐字文本、语言或语速变化时才重新合成。正文清洗后少于 60 字的文章跳过。`npm run tts -- --force` 会重做全部选中文章，并清理已删除文章、或已关闭朗读的文章留下的旧文件。

单篇关闭朗读，在 YAML 中写 `audio: false`。删除清单会关闭全站播放器。没有清单、音频缺失或清单损坏时，构建照常完成，只是不显示播放器。

## 本地检查

```powershell
npm test
npm run build
npm run server
```

当前站点地址带 `/PMAT77/` 前缀，本地预览也从这个路径进入。导航、图片、搜索及分页会自动适配站点根路径，不需要在内容字段中手动添加 `/PMAT77`。

构建使用 `--force` 重新输出资源，确保修改 SCSS 分文件后不会沿用旧 CSS。
