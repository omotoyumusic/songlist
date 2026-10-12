import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed" });

  const adminUid = Deno.env.get("SONGLIST_ADMIN_UID");
  const githubToken = Deno.env.get("GITHUB_TOKEN");
  const repository = Deno.env.get("GITHUB_REPOSITORY");
  const branch = Deno.env.get("GITHUB_BRANCH") || "main";
  const filePath = Deno.env.get("GITHUB_FILE_PATH") || "data/songs.json";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  let supabaseApiKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!supabaseApiKey) {
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
      supabaseApiKey = keys.default || Object.values(keys)[0] || "";
    } catch (_) {
      supabaseApiKey = "";
    }
  }
  if (!adminUid || !githubToken || !repository || !supabaseUrl || !supabaseApiKey) {
    return reply(500, { error: "The GitHub sync function is not fully configured." });
  }

  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Sign in before saving changes." });

  const authClient = createClient(supabaseUrl, supabaseApiKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData.user) return reply(401, { error: "The sign-in session is invalid." });
  if (authData.user.id !== adminUid) return reply(403, { error: "This account cannot edit the song list." });

  let songs: unknown;
  try {
    const body = await request.json();
    songs = body.songs;
  } catch (_) {
    return reply(400, { error: "The request body must be JSON." });
  }
  if (!Array.isArray(songs) || songs.length > 10000) {
    return reply(400, { error: "A song list with at most 10,000 entries is required." });
  }

  const contents = JSON.stringify(songs, null, 2) + "\n";
  if (new TextEncoder().encode(contents).byteLength > 5_000_000) {
    return reply(413, { error: "The song list is too large." });
  }
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || repository.split("/").length !== 2) {
    return reply(500, { error: "GITHUB_REPOSITORY must be owner/repository." });
  }

  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${githubToken}`,
    "Content-Type": "application/json",
    "User-Agent": "songlist-github-sync",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let sha: string | undefined;
  const current = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
  if (current.ok) {
    const currentFile = await current.json();
    sha = currentFile.sha;
  } else if (current.status !== 404) {
    const details = await current.text();
    return reply(502, { error: "GitHub could not read the current song list.", details: details.slice(0, 500) });
  }

  const bytes = new TextEncoder().encode(contents);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const update: Record<string, unknown> = {
    message: "Update song list",
    content: btoa(binary),
    branch,
  };
  if (sha) update.sha = sha;

  const saved = await fetch(apiUrl, { method: "PUT", headers, body: JSON.stringify(update) });
  const result = await saved.json().catch(() => ({}));
  if (!saved.ok) {
    return reply(502, { error: "GitHub could not save the song list.", details: result.message || "" });
  }
  return reply(200, { saved: true, commit: result.commit?.sha || "" });
});
