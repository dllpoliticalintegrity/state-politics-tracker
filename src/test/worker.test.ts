import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../worker/index";

const env = {
  ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
};
const get = (u: string) => worker.fetch(new Request(u), env);

describe("worker routing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => new Response("[]", { status: 200 }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("generates the per-state sitemap instead of hitting assets", async () => {
    const body = await (await get("https://ohiopoliticstracker.com/sitemap.xml")).text();
    expect(body).toContain("<urlset");
    expect(body).not.toBe("asset");
  });

  it("generates robots.txt", async () => {
    const body = await (await get("https://michiganpoliticstracker.com/robots.txt")).text();
    expect(body).not.toBe("asset");
  });

  it("serves real assets straight from the binding", async () => {
    const res = await get("https://michiganpoliticstracker.com/assets/index-abc.js");
    expect(await res.text()).toBe("asset");
  });

  it("redirects www to the apex", async () => {
    const res = await get("https://www.statepoliticstracker.com/governor");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://statepoliticstracker.com/governor");
  });

  it("redirects the hub's www to the apex", async () => {
    const res = await get("https://www.statepoliticstracker.com/mi");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://statepoliticstracker.com/mi");
  });

  it("serves each dedicated Worker's own sitemap", async () => {
    const res = await worker.fetch(new Request("https://michiganpoliticstracker.com/sitemap.xml"), { ...env, SITE_STATE: "mi" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<loc>https://michiganpoliticstracker.com/governor</loc>");
  });
});
