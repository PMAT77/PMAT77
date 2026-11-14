const { url_for } = require('hexo-util');

hexo.extend.generator.register("searchJson", function (locals) {
  const posts = locals.posts.sort("-date").data;
  const searchJson = posts.map((post) => ({
    title: post.title,
    tags: post.tags ? post.tags.data.map((tag) => tag.name).join(", ") : "",
    url: url_for.call(hexo, post.path),
    date: post.date.toISOString(),
  }));

  return [
    { path: "search.json", data: JSON.stringify(searchJson, null, 2) },
    { path: "tech-search.json", data: JSON.stringify(searchJson.filter((entry, index) => posts[index].content_type === 'tech'), null, 2) },
  ];
});
