const TYPEHAUS_PUBLIC_SITE_URL = "https://cetrinkhakuna3-prog.github.io/typehaus";
const currentPageName = window.location.pathname.split("/").pop() || "index.html";
const hostedRecoveryUrl = `${TYPEHAUS_PUBLIC_SITE_URL}/${currentPageName}`;
const isLocalPreview =
  window.location.protocol === "file:" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "localhost";

window.AUTH_CONFIG = {
  supabaseUrl: "https://piivygeapqvhjuppxhuy.supabase.co",
  supabaseAnonKey: "sb_publishable_Mt7Of9hnsKpY8zczoTQtyg_zgGwqCyP",
  publicSiteUrl: TYPEHAUS_PUBLIC_SITE_URL,
  redirectTo: isLocalPreview ? hostedRecoveryUrl : window.location.origin + window.location.pathname,
  adminEmails: "cetrinkhakuna3@gmail.com"
};
