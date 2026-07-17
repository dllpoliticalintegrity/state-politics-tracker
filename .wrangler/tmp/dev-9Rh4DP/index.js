var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// shared/seo.ts
var STATIC_ROUTES = {
  "/": {
    title: "State Politics Tracker \u2014 Money & Polling in 2026 Statewide Races",
    description: "Follow the money and polling in 2026 statewide races across the country \u2014 governor on down. Campaign-finance data from state disclosure agencies, polling averages, and outside spending.",
    h1: "State Politics Tracker \u2014 Follow the Money in Your State",
    body: `
      <p>State Politics Tracker is a public-interest dashboard for 2026 statewide races. We pull primary-source campaign-finance filings from each state's disclosure agency, surface outside spending, and aggregate public polling for every statewide race on the ballot \u2014 governor, attorney general, and the rest of the row offices \u2014 so you can see how money and momentum are moving, state by state.</p>
      <p>Texas and California are tracked on separate sites: <a href="https://texaspoliticstracker.com">texaspoliticstracker.com</a> covers the 2026 Texas Governor's race.</p>
    `
  }
};
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(escapeHtml, "escapeHtml");
function buildSsrBlock(meta) {
  return `<div id="ssr-content" style="display:none" aria-hidden="true">
    <h1>${escapeHtml(meta.h1)}</h1>
    ${meta.body.trim()}
  </div>`;
}
__name(buildSsrBlock, "buildSsrBlock");
function rewriteHtml(html, meta, canonical) {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  let out = html;
  out = out.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);
  if (/<meta\s+name=["']description["'][^>]*>/i.test(out)) {
    out = out.replace(
      /<meta\s+name=["']description["'][^>]*>/i,
      `<meta name="description" content="${description}">`
    );
  } else {
    out = out.replace(
      /<\/head>/i,
      `  <meta name="description" content="${description}">
</head>`
    );
  }
  out = out.replace(
    /<meta\s+property=["']og:title["'][^>]*>/i,
    `<meta property="og:title" content="${title}">`
  );
  out = out.replace(
    /<meta\s+name=["']twitter:title["'][^>]*>/i,
    `<meta name="twitter:title" content="${title}">`
  );
  out = out.replace(
    /<meta\s+property=["']og:description["'][^>]*>/i,
    `<meta property="og:description" content="${description}">`
  );
  out = out.replace(
    /<meta\s+name=["']twitter:description["'][^>]*>/i,
    `<meta name="twitter:description" content="${description}">`
  );
  if (!/<link\s+rel=["']canonical["']/i.test(out)) {
    out = out.replace(
      /<\/head>/i,
      `  <meta property="og:url" content="${canonical}">
  <link rel="canonical" href="${canonical}">
</head>`
    );
  }
  out = out.replace(
    /<div\s+id=["']root["']\s*><\/div>/i,
    `${buildSsrBlock(meta)}
    <div id="root"></div>`
  );
  return out;
}
__name(rewriteHtml, "rewriteHtml");
function isAssetPath(pathname) {
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = pathname.slice(dot + 1).toLowerCase();
  return ext.length > 0 && ext !== "html" && ext !== "htm";
}
__name(isAssetPath, "isAssetPath");
async function applySeoRewrite(request, response) {
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("text/html")) return response;
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const meta = STATIC_ROUTES[pathname];
  if (!meta) return response;
  const canonical = `${url.origin}${pathname}`;
  const html = await response.text();
  const rewritten = rewriteHtml(html, meta, canonical);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
__name(applySeoRewrite, "applySeoRewrite");
var SITEMAP_PATHS = [
  { path: "/", priority: "1.0", changefreq: "daily" }
];
function sitemapResponse(origin) {
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const urls = SITEMAP_PATHS.map(
    ({ path, priority, changefreq }) => `  <url>
    <loc>${origin}${path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400"
    }
  });
}
__name(sitemapResponse, "sitemapResponse");

// worker/index.ts
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/sitemap.xml") return sitemapResponse(url.origin);
    const response = await env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return response;
    if (isAssetPath(url.pathname)) return response;
    return applySeoRewrite(request, response);
  }
};

// ../../root/.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../root/.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-AKOKsY/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../root/.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-AKOKsY/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
