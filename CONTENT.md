# 内容维护

## 源码与部署

本仓库的 `source` 分支保存 Hexo 源码、文章、草稿、主题和测试；`main` 分支保存生成的静态站点。日常修改在 `source` 分支提交，运行 `npm ci`、`npm test` 和 `npm run build` 检查后，通过 `npm run deploy` 发布到 `main`。

`node_modules/`、`public/`、`artifacts/`、`.history/` 和运行缓存由本地生成，不纳入源码提交。

主题以完整文件纳入源码版本控制，保留各自的许可证。原嵌套 Git 元数据备份在本机 `artifacts/theme-git-backup-20261114/`。

首页保留最近 10 篇文章。四个栏目自动生成，不需要手写栏目页面。未指定 `content_type` 的新文章默认归入随笔；技术与小说请使用对应模板。

## 随笔

```powershell
npx hexo new essay 20261028-153000
```

文件名用于生成稳定链接，可以用日期时间命名，不必写标题。需要标题时再在文章开头的 YAML 中添加 `title: 标题`。省略、留空或只填空白均视作无标题；正文页不会显示文件名。首页、搜索、归档和 RSS 使用正文前 30 个 Unicode 字符作为链接文字，空正文使用发布日期。

随笔页按时间倒序，每页 10 条。默认展示全文；希望截断长文时，在正文中插入 `<!--more-->`，其后内容仅在详情页出现。图片、链接和代码块正常使用 Markdown 编写。

## 技术文章

```powershell
npx hexo new tech 单点登录实践
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
npx hexo new novel 第三章
```

章节需要 `content_type: novel`、`novel_id: twelve-pieces`、`novel_section: chapter`，以及同书不重复的数字 `chapter_order`。顺序可以从 0（序章）开始，也可以用小数插入番外；它不受文章发布日期影响。创建后务必修改模板中的章节序号。

角色、势力等设定使用同一 `novel_id`，将 `novel_section` 改为 `lore` 并去掉 `chapter_order`。设定单独列在目录中，按发布日期正序排列，不参与上一章／下一章。

已有文章的文件名和日期应保持不变；修改这些值会影响旧链接。标题、标签和原分类可以照常维护。`source/_drafts` 中的草稿不会因栏目改造而发布。

## 项目展示

编辑 `source/_data/projects.yml`。没有资料时保留 `[]`；准备好资料后，换成项目列表：

```yaml
- title: 项目名称
  cover: /images/projects/project-name.webp
  github: https://github.com/用户名/仓库名
```

将图片放在 `source/images/projects/`，建议使用 16:9 截图。也支持完整 HTTPS 图片地址。列表顺序就是展示顺序；每项需要标题、封面和 HTTPS GitHub 仓库链接，不生成站内详情页，也不混入首页文章列表。

## 本地检查

```powershell
npm test
npm run build
npm run server
```

当前站点地址带 `/PMAT77/` 前缀，本地预览也从这个路径进入。导航、图片、搜索及分页会自动适配站点根路径，不需要在内容字段中手动添加 `/PMAT77`。

构建使用 `--force` 重新输出资源，确保修改 SCSS 分文件后不会沿用旧 CSS。
