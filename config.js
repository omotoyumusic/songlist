window.SONGLIST_CONFIG = {
  // Public browser settings. Never place a Supabase secret/service-role key here.
  supabaseUrl: "https://sdbukpfvgmgsuuhwebvu.supabase.co",
  supabaseAnonKey: "sb_publishable_Ktmkr8lGdZQoO5n_wG95Tg_0aBVMFuU",
  adminUserId: "299972cc-a630-4bf1-a6b8-69983d4d6d15",

  // Use the public raw URL to the GitHub data/songs.json file after first deploy.
  songsDataUrl: "https://raw.githubusercontent.com/omotoyumusic/songlist/main/data/songs.json",
  githubSyncReady: true,

  // The GitHub token stays in Supabase Edge Function secrets, never in this file.
  syncFunctionName: "songlist-github-sync"
};
