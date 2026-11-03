import iconv from "npm:iconv-lite@0.6.3";
import { load } from "npm:cheerio@1.0.0-rc.12";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

// J-WID uses a session and a Windows-31J form. Never return the session cookie.
const origin = "https://www2.jasrac.or.jp";
const root = `${origin}/eJwid/`;
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const encode = (value: string) => Array.from(iconv.encode(value, "windows-31j"), (b: number) => /[A-Za-z0-9_.~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).padStart(2, "0").toUpperCase()}`).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json(405, { error: "POSTのみ利用できます。" });
  try {
    const auth = req.headers.get("Authorization") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!auth.startsWith("Bearer ") || !supabaseUrl || !anonKey) return json(401, { error: "ログインが必要です。" });
    const client = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: identity, error: authError } = await client.auth.getUser();
    if (authError || !identity.user) return json(401, { error: "ログインが必要です。" });
    const input = await req.json();
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const artist = typeof input.artist === "string" ? input.artist.trim() : "";
    const code = typeof input.code === "string" ? input.code.replace(/-/g, "") : "";
    if (!title || title.length > 100 || artist.length > 100 || (code && !/^[A-Z0-9]{8}$/.test(code))) return json(400, { error: "検索条件を確認してください。" });

    const jar = new Map<string, string>();
    async function request(url: string, options: RequestInit = {}) {
      const h = new Headers(options.headers);
      h.set("User-Agent", "Mozilla/5.0 (compatible; Songlist/1.0)");
      if (jar.size) h.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      const res = await fetch(url, { ...options, headers: h, signal: AbortSignal.timeout(12000) });
      const cookieHeaders = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
      for (const raw of cookieHeaders) {
        const pair = raw.split(";", 1)[0];
        const at = pair.indexOf("=");
        if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
      if (!res.ok) throw new Error("J-WIDから応答を取得できませんでした。");
      return iconv.decode(new Uint8Array(await res.arrayBuffer()), "windows-31j");
    }

    await request(root);
    await request(`${root}main?trxID=F00100`, { method: "POST", headers: { Referer: root, "Content-Type": "application/x-www-form-urlencoded" }, body: "" });
    const params: Record<string, string> = {
      IN_WORKS_CD: "", IN_ISWC: "", IN_WORKS_TITLE_NAME1: title, IN_WORKS_TITLE_OPTION1: "2", IN_WORKS_TITLE_TYPE1: "0",
      IN_KEN_NAME1: "", IN_KEN_NAME_JOB1: "0", IN_KEN_NAME_OPTION1: "2", IN_KEN_NAME2: "", IN_KEN_NAME_JOB2: "1", IN_KEN_NAME_OPTION2: "0",
      IN_ARTIST_NAME1: artist, IN_ARTIST_NAME_OPTION1: "2", IN_DEFAULT_SEARCH_WORKS_NAIGAI: "0", CMD_SEARCH: "",
      IN_DEFAULT_WORKS_KOUHO_MAX: "100", IN_DEFAULT_WORKS_KOUHO_SEQ: "1", RESULT_CURRENT_PAGE: "1", OLD_KENRISYA_DISPLAY_TYPE: "",
      IN_WORKS_TITLE_CONDITION: "0", IN_WORKS_TITLE_NAME2: "", IN_WORKS_TITLE_TYPE2: "0", IN_WORKS_TITLE_OPTION2: "0",
      IN_KEN_NAME_CONDITION: "0", IN_ARTIST_NAME_CONDITION: "0", IN_ARTIST_NAME2: "", IN_ARTIST_NAME_OPTION2: "0",
    };
    const body = Object.entries(params).map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
    const html = await request(`${root}main?trxID=A00401-3`, { method: "POST", headers: { Referer: `${root}main?trxID=F00100`, "Content-Type": "application/x-www-form-urlencoded" }, body });
    const $ = load(html);
    const table = $("table.search-result");
    if (!table.length) return json(502, { error: "J-WIDの検索結果を読み取れませんでした。公式サイトでもご確認ください。" });
    const candidates: Array<{ code: string; title: string; artist: string; author: string; href: string }> = [];
    table.find("tr").each((_i, row) => {
      const el = $(row);
      const text = (role: string) => el.find(`[data-role="${role}"]`).text().replace(/\s+/g, " ").trim();
      const workCode = text("result-code");
      if (!workCode || !/^[A-Z0-9-]+$/i.test(workCode)) return;
      candidates.push({ code: workCode, title: text("result-title"), artist: text("result-artist"), author: text("result-author"), href: el.find("a.btn-detail").attr("href") || "" });
    });
    if (!code) return json(200, { candidates: candidates.slice(0, 20).map(({ href: _href, ...item }) => item), truncated: candidates.length > 20 });
    const item = candidates.find((candidate) => candidate.code.replace(/-/g, "").toUpperCase() === code);
    if (!item || !item.href) return json(404, { error: "選択した作品を確認できませんでした。" });
    const detailUrl = new URL(item.href, root);
    if (detailUrl.origin !== origin || !detailUrl.pathname.startsWith("/eJwid/")) return json(502, { error: "作品詳細の取得先を確認できませんでした。" });
    const details = await request(detailUrl.toString(), { headers: { Referer: `${root}main?trxID=A00401-3` } });
    const d = load(details);
    const creatorTable = d("#tab-def .PC table.detail").first();
    const creators: { lyricists: string[]; composers: string[]; arrangers: string[] } | null = creatorTable.length
      ? { lyricists: [], composers: [], arrangers: [] } : null;
    if (creators) creatorTable.find("tr").each((_i, row) => {
      const cells = d(row).children("td");
      if (cells.length < 3) return;
      const name = cells.eq(1).text().replace(/\s+/g, " ").trim();
      const role = cells.eq(2).text().replace(/\s+/g, "").trim();
      const list = role === "作詞" ? creators.lyricists : role === "作曲" ? creators.composers : role === "編曲" || role === "公編" ? creators.arrangers : null;
      const displayName = role === "公編" ? `${name}（公表時編曲）` : name;
      if (list && name && !list.includes(displayName)) list.push(displayName);
    });
    const tabLink = d('a[href="#tab-00-07"]').first();
    const tab = d("#tab-00-07").first();
    if (!tabLink.length || !tab.length) return json(502, { error: "配信欄を読み取れませんでした。公式サイトでご確認ください。" });
    const classes = (tabLink.attr("class") || "").toLowerCase();
    const note = tab.find("dd.txt").first().text().replace(/\s+/g, " ").trim();
    let management = "不明";
    if (classes.includes("green") || note.includes("一部の著作権を管理")) management = "一部を管理";
    else if (classes.includes("purple") || note.includes("JASRACが著作権を管理")) management = "管理";
    else if (classes.includes("red") || note.includes("管理しておりません")) management = "管理外";
    else if (classes.includes("gray") || note.includes("お問い合わせ")) management = "要確認";
    return json(200, { work: { code: item.code, title: item.title, artist: item.artist, author: item.author, management, note, creators } });
  } catch (_error) {
    return json(502, { error: "J-WIDに接続できませんでした。しばらく待ってからお試しください。" });
  }
});
