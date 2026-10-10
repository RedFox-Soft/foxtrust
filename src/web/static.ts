import { dirname, join } from "node:path";

/**
 * Static files of the admin panel and the site, by a fixed list (spec 011 research R3): each
 * service's own stylesheet, Beer CSS (package `beercss`, MIT) and its icon fonts, all served from
 * the service's own origin.
 */

const BEER_DIR = dirname(Bun.resolveSync("beercss/dist/cdn/beer.min.css", import.meta.dir));
const BEER_CDN_FALLBACK = /,url\(https:\/\/cdn\.jsdelivr\.net\/[^)]*\) format\("woff2"\)/g;

/**
 * Beer's stylesheet without the CDN fallbacks of its @font-face rules: the CSP allows fonts from the
 * service's own origin only, and the local font is listed first anyway.
 */
export async function beerStylesheet(): Promise<string> {
  const css = (await Bun.file(join(BEER_DIR, "beer.min.css")).text()).replace(BEER_CDN_FALLBACK, "");
  if (/url\(https?:/.test(css)) throw new Error("beercss: the stylesheet still refers to another origin; check BEER_CDN_FALLBACK after an update");
  return css;
}

const headers = (type: string) => ({ "Content-Type": type, "Cache-Control": "max-age=86400", "X-Content-Type-Options": "nosniff" });

/** Serves `GET` of the fixed list; `own` maps the service's stylesheet path (e.g. /static/site.css) to its file. */
export function createStatic(own: Record<string, string>) {
  const beerCss = beerStylesheet();
  const files: Record<string, { path: string; type: string }> = {
    "/static/beercss/material-symbols-outlined.woff2": { path: join(BEER_DIR, "material-symbols-outlined.woff2"), type: "font/woff2" },
    "/static/beercss/material-symbols-subset.woff2": { path: join(BEER_DIR, "material-symbols-subset.woff2"), type: "font/woff2" },
  };
  for (const [path, file] of Object.entries(own)) files[path] = { path: file, type: "text/css; charset=utf-8" };

  return {
    /** The answer for a static path, or null when the path is not one. */
    async serve(path: string): Promise<Response | null> {
      if (path === "/static/beercss/beer.min.css") return new Response(await beerCss, { headers: headers("text/css; charset=utf-8") });
      const file = files[path];
      return file ? new Response(Bun.file(file.path), { headers: headers(file.type) }) : null;
    },
  };
}
