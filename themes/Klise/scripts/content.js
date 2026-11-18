const content = require('../lib/content.cjs');
const { loadProjects } = require('../lib/github-projects.cjs');

// Run after Hexo renders Markdown, before any generator (including feeds/search).
hexo.extend.filter.register('before_generate', function () {
  this.locals.invalidate();
  const posts = this.locals.get('posts').toArray();
  content.preparePosts(posts);
  content.booksFor(posts, this.locals.get('data').novels);
  // Hexo refreshes its locals from Warehouse before running generators.
  return Promise.all(posts.map(post => post.save()));
}, 20);

hexo.extend.generator.register('contentCollections', async function (locals) {
  const projects = await loadProjects({ baseDir: this.base_dir, config: this.config.github_projects,
    overrides: locals.data.projects, log: this.log });
  return content.collectionPages(locals.posts.toArray(), locals.data, projects);
});

hexo.extend.helper.register('article_summary', function (post) {
  const text = content.plainText(post.excerpt || post.content);
  const characters = Array.from(text);
  return characters.slice(0, 140).join('') + (characters.length > 140 ? '…' : '');
});

hexo.extend.helper.register('section_active', function (url, path, page) {
  const section = page.section || content.sections[page.content_type];
  const route = url.replace(/^\/+|\/+$/g, '');
  return route ? section === route || path.startsWith(`${route}/`) : path === 'index.html' || path === '';
});

hexo.extend.helper.register('novel_navigation', function (post) {
  const book = content.booksFor(this.site.posts.toArray(), this.site.data.novels)
    .find(book => book.id === post.novel_id);
  if (!book) return null;
  const index = book.chapters.findIndex(chapter => chapter.path === post.path);
  return { book, prev: index > 0 ? book.chapters[index - 1] : null,
    next: index >= 0 ? book.chapters[index + 1] : null };
});
