const { stripHTML, unescapeHTML } = require('hexo-util');
const { parse } = require('hexo-front-matter');
const { projectsFor } = require('./github-projects.cjs');

const sections = { essay: 'essays', novel: 'novels', tech: 'tech' };

function plainText(html = '') {
  return unescapeHTML(stripHTML(String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>|<br\s*\/?\s*>/gi, ' ')))
    .replace(/\s+/g, ' ').trim();
}

function preparePosts(posts) {
  for (const post of posts) {
    post.has_more = Boolean(post.content?.includes('<span id="more"></span>'));
    post.content_type ||= 'essay';
    if (!sections[post.content_type]) {
      throw new Error(`${post.source}: content_type 必须是 essay、novel 或 tech`);
    }
    const original = post.raw ? parse(post.raw) : post;
    const title = String(original.title || '').trim();
    post.untitled_essay = post.content_type === 'essay' && !title;
    if (post.untitled_essay) {
      const text = plainText(post.content);
      post.title = Array.from(text).slice(0, 30).join('') || post.date.format('YYYY-MM-DD');
    } else if (!title) {
      throw new Error(`${post.source}: 小说和技术文章需要填写 title`);
    } else {
      post.title = title;
    }
  }
}

function booksFor(posts, definitions = []) {
  if (!Array.isArray(definitions)) throw new Error('novels.yml 必须是作品列表');
  const ids = new Set();
  const books = definitions.map(book => {
    if (!book || typeof book.title !== 'string' || !book.title.trim() || typeof book.id !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(book.id) || ids.has(book.id)) {
      throw new Error('novels.yml: 每部作品需要 title 和唯一的小写英文 id');
    }
    ids.add(book.id);
    return { ...book, status: book.status || '连载中', path: `novels/${book.id}/`, chapters: [], lore: [] };
  });
  for (const post of posts.filter(post => post.content_type === 'novel')) {
    const book = books.find(book => book.id === post.novel_id);
    if (!book) throw new Error(`${post.source}: novel_id 没有对应的作品`);
    if (!['chapter', 'lore'].includes(post.novel_section)) {
      throw new Error(`${post.source}: novel_section 必须是 chapter 或 lore`);
    }
    if (post.novel_section === 'chapter') {
      if (typeof post.chapter_order !== 'number' || !Number.isFinite(post.chapter_order) || post.chapter_order < 0) {
        throw new Error(`${post.source}: chapter_order 需要填写非负数字`);
      }
      if (book.chapters.some(chapter => chapter.chapter_order === post.chapter_order)) {
        throw new Error(`${post.source}: 同一作品的 chapter_order 不能重复`);
      }
      book.chapters.push(post);
    } else {
      book.lore.push(post);
    }
  }
  for (const book of books) {
    book.chapters.sort((a, b) => a.chapter_order - b.chapter_order);
    book.lore.sort((a, b) => a.date - b.date);
    book.first = book.chapters[0];
    book.latest = book.chapters.at(-1);
    book.updated = [...book.chapters, ...book.lore].sort((a, b) => b.date - a.date)[0]?.date;
  }
  return books;
}

function collectionPages(posts, data = {}, projects = projectsFor(data.projects)) {
  const books = booksFor(posts, data.novels);
  const routes = [];
  for (const [type, section, title] of [['essay', 'essays', '随笔'], ['tech', 'tech', '技术文章']]) {
    const entries = posts.filter(post => post.content_type === type).sort((a, b) => b.date - a.date);
    const count = Math.max(1, Math.ceil(entries.length / 10));
    for (let number = 1; number <= count; number++) {
      const pagePath = n => n === 1 ? `${section}/` : `${section}/page/${n}/`;
      routes.push({
        path: `${pagePath(number)}index.html`, layout: 'collection',
        data: { title, section, entries: entries.slice((number - 1) * 10, number * 10),
          pagination: { number, count, prev: number > 1 ? pagePath(number - 1) : null,
            next: number < count ? pagePath(number + 1) : null } }
      });
    }
  }
  routes.push({ path: 'novels/index.html', layout: 'collection', data: { title: '连载小说', section: 'novels', books } });
  for (const book of books) {
    routes.push({ path: `${book.path}index.html`, layout: 'collection', data: { title: book.title, section: 'novels', book } });
  }
  routes.push({ path: 'projects/index.html', layout: 'collection', data: { title: '项目展示', section: 'projects', projects } });
  for (const project of projects) {
    routes.push({ path: `${project.path}index.html`, layout: 'project',
      data: { title: project.title, section: 'projects', project } });
  }
  return routes;
}

module.exports = { sections, plainText, preparePosts, booksFor, projectsFor, collectionPages };
