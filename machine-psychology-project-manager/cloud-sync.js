(function () {
  "use strict";

  const TABLE = "project_manager_states";
  const SAVE_DELAY_MS = 1200;
  let client = null;
  let session = null;
  let app = null;
  let revision = 0;
  let dirty = false;
  let initialized = false;
  let saveTimer = null;
  let saveInFlight = null;
  let accessDenied = false;

  const byId = (id) => document.getElementById(id);

  function setStatus(message, tone = "neutral") {
    const status = byId("cloud-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function setGate(mode, message = "") {
    const gate = byId("auth-gate");
    const title = byId("auth-title");
    const detail = byId("auth-detail");
    const signIn = byId("cloud-sign-in");
    if (!gate || !title || !detail || !signIn) return;

    gate.hidden = mode === "open";
    signIn.hidden = mode === "checking" || mode === "denied" || mode === "error";
    title.textContent = {
      checking: "Checking secure access…",
      signedOut: "Sign in to your project manager",
      denied: "Access is limited to the project owner",
      error: "Cloud sync needs attention"
    }[mode] || "Sign in to your project manager";
    detail.textContent = message || {
      checking: "Your saved project state will load automatically.",
      signedOut: "Use the authorized Google account to load and update project progress from any device.",
      denied: "This Google account is not authorized.",
      error: "The project remains safely stored in this browser until cloud sync is restored."
    }[mode] || "";
  }

  function setSignedInControls(user) {
    byId("cloud-user").textContent = user?.email || "Signed in";
    byId("cloud-save-now").hidden = !user;
    byId("cloud-load-now").hidden = !user;
    byId("cloud-sign-out").hidden = !user;
  }

  function setConflictVisible(visible) {
    const conflict = byId("cloud-conflict");
    if (conflict) conflict.hidden = !visible;
  }

  function formatSavedTime(value) {
    const date = value ? new Date(value) : new Date();
    return `Saved ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  function normalizeRpcRow(data) {
    if (Array.isArray(data)) return data[0] || null;
    return data || null;
  }

  function isConflict(error) {
    return error?.code === "40001" || /revision_conflict/i.test(error?.message || "");
  }

  async function verifyAccess() {
    const { data, error } = await client.rpc("project_manager_access_status");
    if (error) throw error;
    return data === true;
  }

  async function loadCloud(options = {}) {
    if (!session) return;
    const { discardLocal = false } = options;

    if (dirty && !discardLocal) {
      const confirmed = window.confirm("Load the cloud copy and discard unsaved changes on this device?");
      if (!confirmed) return;
    }

    setStatus("Loading cloud progress…", "working");
    const { data, error } = await client
      .from(TABLE)
      .select("state, revision, updated_at")
      .eq("user_id", session.user.id)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      revision = 0;
      await saveNow({ force: true });
      return;
    }

    revision = Number(data.revision) || 0;
    dirty = false;
    setConflictVisible(false);
    app.setState(data.state || {});
    setStatus(formatSavedTime(data.updated_at), "ok");
  }

  async function saveNow(options = {}) {
    if (!session || !app) return;
    const { force = false } = options;

    if (saveInFlight) {
      await saveInFlight;
      if (!dirty && !force) return;
    }

    clearTimeout(saveTimer);
    saveTimer = null;
    setStatus("Saving…", "working");

    const stateAtStart = app.getState();
    saveInFlight = client
      .rpc("save_project_manager_state", {
        p_state: stateAtStart,
        p_expected_revision: force || revision === 0 ? null : revision
      })
      .then(({ data, error }) => {
        if (error) throw error;
        const row = normalizeRpcRow(data);
        revision = Number(row?.revision) || revision + 1;
        dirty = JSON.stringify(app.getState()) !== JSON.stringify(stateAtStart);
        setConflictVisible(false);
        setStatus(formatSavedTime(row?.updated_at), "ok");
      })
      .catch((error) => {
        if (isConflict(error)) {
          dirty = true;
          setConflictVisible(true);
          setStatus("A newer cloud copy exists", "warning");
          return;
        }
        dirty = true;
        setStatus(navigator.onLine ? "Cloud save failed" : "Offline · changes kept locally", "error");
        console.error("Cloud save failed", error);
      })
      .finally(() => {
        saveInFlight = null;
        if (dirty && session && (byId("cloud-conflict")?.hidden ?? true)) {
          queueSave();
        }
      });

    await saveInFlight;
  }

  function queueSave() {
    if (!initialized || !session || accessDenied) return;
    dirty = true;
    setStatus(navigator.onLine ? "Unsaved changes" : "Offline · changes kept locally", "warning");
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void saveNow(), SAVE_DELAY_MS);
  }

  async function handleSession(nextSession) {
    session = nextSession;

    if (!session) {
      revision = 0;
      dirty = false;
      setSignedInControls(null);
      if (accessDenied) {
        setStatus("Unauthorized account", "error");
        setGate("denied");
      } else {
        setStatus("Sign in required", "warning");
        setGate("signedOut");
      }
      return;
    }

    accessDenied = false;
    setGate("checking");
    setStatus("Verifying access…", "working");
    setSignedInControls(session.user);

    try {
      const allowed = await verifyAccess();
      if (!allowed) {
        accessDenied = true;
        setSignedInControls(null);
        setStatus("Unauthorized account", "error");
        setGate("denied");
        await client.auth.signOut({ scope: "local" });
        return;
      }
      setGate("open");
      await loadCloud({ discardLocal: true });
    } catch (error) {
      console.error("Cloud initialization failed", error);
      setStatus("Cloud connection failed", "error");
      setGate("error", "The secure database could not be reached. Refresh the page or try again shortly.");
    }
  }

  async function signIn() {
    setGate("checking", "Opening Google sign-in…");
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo }
    });
    if (error) {
      console.error("Sign-in failed", error);
      setGate("error", "Google sign-in could not start. Please try again.");
    }
  }

  async function signOut() {
    if (dirty) await saveNow();
    accessDenied = false;
    await client.auth.signOut({ scope: "local" });
  }

  async function initialize(appAdapter) {
    app = appAdapter;
    const config = window.MACHINE_PSYCHOLOGY_SUPABASE;
    const library = window.supabase;

    byId("cloud-sign-in")?.addEventListener("click", () => void signIn());
    byId("cloud-sign-out")?.addEventListener("click", () => void signOut());
    byId("cloud-save-now")?.addEventListener("click", () => void saveNow());
    byId("cloud-load-now")?.addEventListener("click", () => void loadCloud());
    byId("cloud-use-device")?.addEventListener("click", () => void saveNow({ force: true }));
    byId("cloud-use-cloud")?.addEventListener("click", () => void loadCloud({ discardLocal: true }));

    if (!library || !config || config.url.includes("__") || config.publishableKey.includes("__")) {
      setStatus("Cloud sync not configured", "error");
      setGate("error", "The new Supabase project has not been connected yet.");
      return;
    }

    client = library.createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    initialized = true;

    const { data, error } = await client.auth.getSession();
    if (error) {
      setGate("error", "The saved sign-in session could not be checked.");
      return;
    }

    client.auth.onAuthStateChange((_event, nextSession) => {
      window.setTimeout(() => void handleSession(nextSession), 0);
    });

    window.addEventListener("online", () => {
      if (dirty) queueSave();
      else if (session) void loadCloud({ discardLocal: true });
    });
    window.addEventListener("offline", () => setStatus("Offline · changes kept locally", "warning"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && session && !dirty) {
        void loadCloud({ discardLocal: true });
      }
    });

    await handleSession(data.session);
  }

  window.CloudSync = Object.freeze({ initialize, queueSave, saveNow, loadCloud });
})();
