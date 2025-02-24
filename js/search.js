// @ts-nocheck
/*!
 * Simple-Jekyll-Search
 * Copyright 2015-2020, Christian Fei
 * Licensed under the MIT License.
 */
!(function () {
  "use strict";
  var i = {
      compile: function (r) {
        return o.template.replace(o.pattern, function (t, e) {
          var n = o.middleware(e, r[e], o.template);
          return void 0 !== n ? n : r[e] || t;
        });
      },
      setOptions: function (t) {
        (o.pattern = t.pattern || o.pattern),
          (o.template = t.template || o.template),
          "function" == typeof t.middleware && (o.middleware = t.middleware);
      },
    },
    o = {};
  (o.pattern = /\{(.*?)\}/g),
    (o.template = ""),
    (o.middleware = function () {});
  var n = function (t, e) {
      var n = e.length,
        r = t.length;
      if (n < r) return !1;
      if (r === n) return t === e;
      t: for (var i = 0, o = 0; i < r; i++) {
        for (var u = t.charCodeAt(i); o < n; )
          if (e.charCodeAt(o++) === u) continue t;
        return !1;
      }
      return !0;
    },
    e = new (function () {
      this.matches = function (t, e) {
        return n(e.toLowerCase(), t.toLowerCase());
      };
    })();
  var r = new (function () {
    this.matches = function (e, t) {
      return (
        !!e &&
        ((e = e.trim().toLowerCase()),
        (t = t.trim().toLowerCase()).split(" ").filter(function (t) {
          return 0 <= e.indexOf(t);
        }).length === t.split(" ").length)
      );
    };
  })();
  var u = {
    put: function (t) {
      if (f(t)) return p(t);
      if (
        (function (t) {
          return (
            Boolean(t) && "[object Array]" === Object.prototype.toString.call(t)
          );
        })(t)
      )
        return (function (t) {
          var e = [];
          l();
          for (var n = 0, r = t.length; n < r; n++) f(t[n]) && e.push(p(t[n]));
          return e;
        })(t);
      return undefined;
    },
    clear: l,
    search: function (t) {
      return t
        ? (function (t, e, n, r) {
            for (var i = [], o = 0; o < t.length && i.length < r.limit; o++) {
              var u = (function (t, e, n, r) {
                for (var i in t)
                  if (
                    !(function (t, e) {
                      for (
                        var n = !1, r = 0, i = (e = e || []).length;
                        r < i;
                        r++
                      ) {
                        var o = e[r];
                        !n && new RegExp(t).test(o) && (n = !0);
                      }
                      return n;
                    })(t[i], r.exclude) &&
                    n.matches(t[i], e)
                  )
                    return t;
              })(t[o], e, n, r);
              u && i.push(u);
            }
            return i;
          })(s, t, c.searchStrategy, c).sort(c.sort)
        : [];
    },
    setOptions: function (t) {
      ((c = t || {}).fuzzy = t.fuzzy || !1),
        (c.limit = t.limit || 10),
        (c.searchStrategy = t.fuzzy ? e : r),
        (c.sort = t.sort || a);
    },
  };
  function a() {
    return 0;
  }
  var s = [],
    c = {};
  function l() {
    return (s.length = 0), s;
  }
  function f(t) {
    return (
      Boolean(t) && "[object Object]" === Object.prototype.toString.call(t)
    );
  }
  function p(t) {
    return s.push(t), s;
  }
  (c.fuzzy = !1),
    (c.limit = 10),
    (c.searchStrategy = c.fuzzy ? e : r),
    (c.sort = a);
  var d = {
    load: function (t, e) {
      var n = window.XMLHttpRequest
        ? new window.XMLHttpRequest()
        : new ActiveXObject("Microsoft.XMLHTTP");
      n.open("GET", t, !0),
        (n.onreadystatechange = (function (e, n) {
          return function () {
            if (4 === e.readyState && 200 === e.status)
              try {
                n(null, JSON.parse(e.responseText));
              } catch (t) {
                n(t, null);
              }
          };
        })(n, e)),
        n.send();
    },
  };
  var h = {
    merge: function (t, e) {
      var n = {};
      for (var r in t)
        (n[r] = t[r]), "undefined" != typeof e[r] && (n[r] = e[r]);
      return n;
    },
    isJSON: function (t) {
      try {
        return t instanceof Object && JSON.parse(JSON.stringify(t)) ? !0 : !1;
      } catch (e) {
        return !1;
      }
    },
  };
  var t, m, v, w;
  function y(t) {
    u.put(t),
      m.searchInput.addEventListener("input", function (t) {
        -1 === [13, 16, 20, 37, 38, 39, 40, 91].indexOf(t.which) &&
          (g(), z(t.target.value));
      });
  }
  function g() {
    m.resultsContainer.innerHTML = "";
  }
  function O(t) {
    m.resultsContainer.innerHTML += t;
  }
  function z(t) {
    var e;
    (e = t) &&
      0 < e.length &&
      (g(),
      (function (t, e) {
        var n = t.length;
        if (0 === n) return O(m.noResultsText);
        for (var r = 0; r < n; r++) (t[r].query = e), O(i.compile(t[r]));
      })(u.search(t), t));
  }
  function S(t) {
    throw new Error("SimpleJekyllSearch --- " + t);
  }
  (t = window),
    (m = {
      searchInput: null,
      resultsContainer: null,
      json: [],
      success: Function.prototype,
      searchResultTemplate:
        '<li><a href="{url}" title="{desc}">{title}</a></li>',
      templateMiddleware: Function.prototype,
      sortMiddleware: function () {
        return 0;
      },
      noResultsText: "No results found",
      limit: 10,
      fuzzy: !1,
      exclude: [],
    }),
    (w = (function j(t) {
      if (
        !(
          (e = t) &&
          "undefined" != typeof e.required &&
          e.required instanceof Array
        )
      )
        throw new Error("-- OptionsValidator: required options missing");
      var e;
      if (!(this instanceof j)) return new j(t);
      var r = t.required;
      (this.getRequiredOptions = function () {
        return r;
      }),
        (this.validate = function (e) {
          var n = [];
          return (
            r.forEach(function (t) {
              "undefined" == typeof e[t] && n.push(t);
            }),
            n
          );
        });
    })({ required: (v = ["searchInput", "resultsContainer", "json"]) })),
    (t.SimpleJekyllSearch = function (t) {
      var n;
      0 < w.validate(t).length &&
        S("You must specify the following required options: " + v),
        (m = h.merge(m, t)),
        i.setOptions({
          template: m.searchResultTemplate,
          middleware: m.templateMiddleware,
        }),
        u.setOptions({
          fuzzy: m.fuzzy,
          limit: m.limit,
          sort: m.sortMiddleware,
        }),
        h.isJSON(m.json)
          ? y(m.json)
          : ((n = m.json),
            d.load(n, function (t, e) {
              t && S("failed to get JSON (" + n + ")"), y(e);
            }));
      var e = { search: z };
      return "function" == typeof m.success && m.success.call(e), e;
    });
})();
