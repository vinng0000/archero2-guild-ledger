/*
  Guild Ledger (Archero 2 guild tracker)
  Copyright (c) 2026 the Guild Ledger author. All rights reserved.
  Not licensed for copying, modification or reuse.

  Site runtime: the page is shared with the claude.ai version, which gets storage, viewer
  permissions and Claude from claude.ai. On a plain website this file provides the same three
  things instead: records in this browser's localStorage, every visitor as an officer, and
  Claude through the officer's own Anthropic API key.
*/
"use strict";
(() => {
  const STORE_KEY = "guild-ledger:db:v2";
  const SETTINGS_KEY = "guild-ledger:settings";
  const MODEL = "claude-haiku-5-5"; // the page names the model per call; this is the fallback

  /* ---------- db: a small document store with live collection snapshots ---------- */
  let store = {};
  try { store = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { /* private mode: start empty */ }
  const listeners = new Set();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const notify = () => listeners.forEach((fn) => fn());
  const persist = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
    catch { throw Object.assign(new Error("This browser's storage is full or blocked."), { code: "quota_exceeded" }); }
    notify();
  };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  const docSnap = (path) => ({ id: path.split("/").pop(), exists: path in store, data: () => clone(store[path]) });
  const colSnap = (col) => {
    const depth = col.split("/").length + 1;
    const docs = Object.keys(store).filter((p) => p.startsWith(col + "/") && p.split("/").length === depth).sort().map(docSnap);
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false } };
  };
  const docRef = (path) => ({
    id: path.split("/").pop(), path,
    get: async () => docSnap(path),
    set: async (data) => { store[path] = clone(data); persist(); },
    update: async (data) => { store[path] = { ...(store[path] ?? {}), ...clone(data) }; persist(); },
    delete: async () => { delete store[path]; persist(); },
  });
  const colRef = (col) => ({
    path: col,
    doc: (id) => docRef(`${col}/${id ?? newId()}`),
    get: async () => colSnap(col),
    onSnapshot: (next) => {
      const fn = () => next(colSnap(col));
      listeners.add(fn); queueMicrotask(fn);
      return () => listeners.delete(fn);
    },
  });
  const db = Object.freeze({ collection: colRef, doc: docRef });
  // Another tab saved: show its records here too.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORE_KEY) return;
    try { store = JSON.parse(e.newValue || "{}"); } catch { return; }
    notify();
  });

  /* ---------- user: whoever uses this browser runs it ---------- */
  const user = Object.freeze({ can: async () => true, canEdit: async () => true, isOwner: async () => true, id: async () => null });

  /* ---------- sample: Claude through the officer's API key ---------- */
  const apiKey = () => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}").apiKey || ""; } catch { return ""; } };
  let client = null, clientKey = null;
  async function anthropic() {
    const key = apiKey();
    if (!key) throw { code: "not_granted", detail: "Add your Anthropic API key in Settings first." };
    if (!client || clientKey !== key) {
      const { default: Anthropic } = await import("./vendor/anthropic-sdk.mjs");
      // The key belongs to the officer using this browser; requests go straight from here to Anthropic.
      client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
      clientKey = key;
    }
    return client;
  }
  const base64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  /** API failures in the shape the page expects from claude.ai, with a site-specific message in `detail`. */
  function toPageError(e) {
    if (e?.code) return e;
    const status = e?.status, msg = e?.error?.error?.message ?? e?.message ?? String(e);
    if (e?.name === "APIUserAbortError" || e?.name === "AbortError") return { code: "cancelled" };
    if (status === 401) return { code: "not_granted", detail: "Anthropic rejected the API key. Check it in Settings." };
    if (status === 403 || status === 404) return { code: "not_granted", detail: "This API key can't use the Claude models this page needs (Haiku 5.5 and Opus 5.5). Check the key's workspace in the Claude Console." };
    if (status === 429) return { code: "rate_limited", detail: "Anthropic's rate limit was hit. Wait a minute, then press Try again." };
    if (status === 400 && /credit balance/i.test(msg)) return { code: "not_granted", detail: "The API account is out of credit. Add credit in the Claude Console." };
    if (status === 413) return { code: "image_rejected", detail: "These frames were too large to send." };
    if (status >= 500) return { code: "upstream_error", detail: "Anthropic is busy right now. Press Try again in a moment." };
    if (status == null) return { code: "network", detail: "Couldn't reach Anthropic. Check your connection." };
    return { code: "upstream_error", detail: msg };
  }
  /** One Claude call; resolves like claude.ai's sample(): { text, truncated, modelApplied }. */
  async function ask(prompt, opts = {}) {
    const c = await anthropic();
    const model = opts.model || MODEL;
    const content = [];
    for (const img of opts.images ?? []) content.push({ type: "image", source: { type: "base64", media_type: img.type || "image/jpeg", data: await base64(img) } });
    content.push({ type: "text", text: `${prompt}\n\nReply with only the JSON object, no other text.` });
    let res;
    try {
      res = await c.messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: opts.modelTier === "complex" ? "medium" : "low" },
        messages: [{ role: "user", content }],
      }, { signal: opts.signal });
    } catch (e) { throw toPageError(e); }
    if (res.stop_reason === "refusal") throw { code: "refused" };
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return { text, truncated: res.stop_reason === "max_tokens", modelApplied: opts.model ? model : undefined, modelTierApplied: "default" };
  }
  async function json(prompt, opts) {
    const { text, truncated } = await ask(prompt, opts);
    if (truncated) throw { code: "invalid_json", detail: "The answer was cut off. Press Try again." };
    const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try { return JSON.parse(body); } catch { throw { code: "invalid_json" }; }
  }
  const sample = Object.freeze(Object.assign((...a) => ask(...a), { json, limits: async () => ({ images: { maxCount: 6 } }) }));

  window.claude = Object.freeze({ use: async (name) => ({ db, user, sample })[name] ?? null });
})();
