const fs = require('node:fs/promises');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

const window = new JSDOM('').window;
const purify = createDOMPurify(window);
const repoName = /^(?!\.{1,2}$)[a-z0-9._-]+$/i;
const ownerName = /^[a-z0-9-]+$/i;

function repository(github) {
  let url;
  try { url = new URL(github); } catch { /* Report the field below. */ }
  const parts = url?.pathname.replace(/\/$/, '').split('/').slice(1);
  if (!url || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
      url.username || url.password || url.search || url.hash || parts.length !== 2 ||
      !ownerName.test(parts[0]) || !repoName.test(parts[1])) {
    throw new Error('projects.yml: github 需要有效的 HTTPS GitHub 仓库链接');
  }
  return { name: parts[1], full_name: parts.join('/'), github: `https://github.com/${parts.join('/')}` };
}

function projectsFor(projects = []) {
  if (!Array.isArray(projects)) throw new Error('projects.yml 必须是项目列表');
  const names = new Set();
  return projects.map(project => {
    const repo = repository(project?.github);
    if (names.has(repo.name.toLowerCase())) throw new Error(`projects.yml: 项目名称 ${repo.name} 重复，会生成相同的详情地址`);
    names.add(repo.name.toLowerCase());
    if ((project.title != null && (typeof project.title !== 'string' || !project.title.trim())) ||
        (project.cover != null && (typeof project.cover !== 'string' ||
          !/^(?:\/(?!\/)|https?:\/\/)/i.test(project.cover) || /[\\\s]/.test(project.cover)))) {
      throw new Error('projects.yml: title 需要非空文字，cover 需要站内绝对路径或 HTTP(S) 图片地址');
    }
    return { ...repo, title: project.title?.trim() || repo.name, cover: project.cover || '',
      description: '', language: '', stars: 0, pushed_at: null, readme: null,
      path: `projects/${repo.name}/` };
  });
}

function readmeHtml(html, project) {
  const fragment = purify.sanitize(html, {
    USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
    FORBID_ATTR: ['style', 'srcset']
  });
  const ref = encodeURIComponent(project.default_branch || 'HEAD');
  const file = (project.readme?.path || 'README.md').split('/').map(encodeURIComponent).join('/');
  const blobRoot = `${project.github}/blob/${ref}/`;
  const rawRoot = `https://raw.githubusercontent.com/${project.full_name}/${ref}/`;
  for (const element of fragment.querySelectorAll('[id], [name]')) {
    for (const attribute of ['id', 'name']) {
      const value = element.getAttribute(attribute);
      if (value?.startsWith('user-content-')) element.setAttribute(attribute, value.slice(13));
    }
  }
  // GitHub puts heading IDs on a trailing icon link; place them on the heading for scrolling.
  for (const group of fragment.querySelectorAll('.markdown-heading')) {
    const heading = group.querySelector('h1, h2, h3, h4, h5, h6');
    const anchor = group.querySelector('a.anchor[id]');
    if (heading && anchor && !heading.id) {
      heading.id = anchor.id;
      anchor.remove();
    }
  }
  for (const element of fragment.querySelectorAll('[href], [src], [poster]')) {
    for (const attribute of ['href', 'src', 'poster']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      if (attribute === 'href') {
        element.removeAttribute('target');
        element.removeAttribute('rel');
      }
      if (attribute === 'href' && value.startsWith('#')) {
        element.setAttribute(attribute, value.replace(/^#user-content-/, '#'));
        continue;
      }
      const root = attribute === 'href' ? blobRoot : rawRoot;
      const base = value.startsWith('/') && !value.startsWith('//') ? root : root + file;
      let url;
      try { url = new URL(value.startsWith('/') && !value.startsWith('//') ? value.slice(1) : value, base); }
      catch { element.removeAttribute(attribute); continue; }
      if (!['https:', 'http:', ...(attribute === 'href' ? ['mailto:'] : [])].includes(url.protocol)) {
        element.removeAttribute(attribute);
        continue;
      }
      element.setAttribute(attribute, url.href);
      if (attribute === 'href') {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }
  for (const input of fragment.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove();
    else input.disabled = true;
  }
  const container = window.document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

function selectedProjects(projects, config) {
  const excluded = new Set((config.exclude || []).map(name => name.toLowerCase()));
  return projects.filter(project => project.full_name?.split('/')[0].toLowerCase() === config.username.toLowerCase() &&
    repoName.test(project.name) && !project.private && !project.fork && !project.archived &&
    project.name.toLowerCase() !== config.username.toLowerCase() &&
    !excluded.has(project.name.toLowerCase()) && !excluded.has(project.full_name.toLowerCase()))
    .sort((a, b) => (Date.parse(b.pushed_at) || 0) - (Date.parse(a.pushed_at) || 0) || a.name.localeCompare(b.name));
}

async function loadProjects({ baseDir, config, overrides = [], log = console, fetchImpl = globalThis.fetch,
  requestTimeout = 8000, syncTimeout = 20000, token = process.env.GITHUB_TOKEN }) {
  const manual = projectsFor(overrides);
  if (!config?.enable) return manual;
  if (!ownerName.test(config.username || '')) throw new Error('github_projects.username 需要 GitHub 用户名');
  const cachePath = path.join(baseDir, 'data/github-projects.json');
  let cached = [];
  try {
    const snapshot = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (snapshot.username?.toLowerCase() === config.username.toLowerCase() && Array.isArray(snapshot.projects)) {
      cached = selectedProjects(snapshot.projects, config);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') log.warn('GitHub 项目缓存无法读取，将尝试在线同步。');
  }
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'PAOLOS-Hexo',
    'X-GitHub-Api-Version': '2026-03-10', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const deadline = AbortSignal.timeout(syncTimeout);
  async function request(url, html = false) {
    deadline.throwIfAborted();
    const response = await fetchImpl(url, {
      headers: { ...headers, ...(html ? { Accept: 'application/vnd.github.html+json' } : {}) },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(requestTimeout)])
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    return html ? response.text() : response.json();
  }
  let projects;
  try {
    const repos = [];
    for (let page = 1; ; page++) {
      const batch = await request(`https://api.github.com/users/${config.username}/repos?type=owner&sort=pushed&direction=desc&per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub 仓库列表格式无效');
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    projects = selectedProjects(repos, config).map(repo => ({
      ...repository(`https://github.com/${repo.full_name}`),
      description: repo.description || '', language: repo.language || '',
      stars: repo.stargazers_count || 0, pushed_at: repo.pushed_at || null,
      default_branch: repo.default_branch
    }));
    // Sequential reads keep the small portfolio within GitHub's concurrency limits.
    for (const project of projects) {
      const old = cached.find(item => item.full_name.toLowerCase() === project.full_name.toLowerCase());
      try {
        const url = `https://api.github.com/repos/${project.full_name}/readme?ref=${encodeURIComponent(project.default_branch)}`;
        const readme = await request(url);
        project.readme = readme ? { path: readme.path, sha: readme.sha } : null;
        if (readme) {
          const html = old?.readme?.sha === readme.sha && old.default_branch === project.default_branch
            ? old.readme.html : await request(url, true);
          if (html == null) throw new Error('GitHub README 在同步时发生变化');
          project.readme.html = readmeHtml(html, project);
        }
      } catch {
        project.readme = old?.readme || null;
        log.warn(`GitHub README 同步失败：${project.full_name}，使用已有内容。`);
      }
    }
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const temporary = `${cachePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ username: config.username, projects }, null, 2) + '\n');
      await fs.rename(temporary, cachePath);
    } catch {
      log.warn('GitHub 项目缓存无法保存，本次构建继续使用已获取的数据。');
    }
    log.info(`GitHub 项目同步完成：${projects.length} 个公开项目。`);
  } catch {
    projects = cached.length ? cached : selectedProjects(manual, config);
    log.warn('GitHub 项目同步失败，使用缓存或手工项目继续构建。');
  }
  return projects.map(project => {
    const custom = manual.find(item => item.full_name.toLowerCase() === project.full_name.toLowerCase());
    return { ...project, title: custom?.title || project.name, cover: custom?.cover || '',
      path: `projects/${project.name}/`,
      readme: project.readme ? { ...project.readme, html: readmeHtml(project.readme.html, project) } : null };
  });
}

module.exports = { projectsFor, readmeHtml, loadProjects };
