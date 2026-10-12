window.SONGLIST_CONFIG = {
  // Public browser settings. Never place a Supabase secret/service-role key here.
  supabaseUrl: "",
  supabaseAnonKey: "",
  adminUserId: "",

  // Use the public raw URL to the GitHub data/songs.json file after first deploy.
  songsDataUrl: "",
  githubSyncReady: false,

  // The GitHub token stays in Supabase Edge Function secrets, never in this file.
  syncFunctionName: "songlist-github-sync"
};
