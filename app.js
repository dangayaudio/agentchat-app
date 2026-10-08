/* AgentChat – app điện thoại (PWA, không cần build). Chạy ở 2 nơi:
   - GitHub Pages (link cố định): địa chỉ máy chủ = link đường hầm đọc từ link.json (Dev Tunnels: cố định;
     cloudflared: đổi mỗi lần máy IT mở chat);
   - chính máy chủ chat (http://127.0.0.1:8770/): gọi cùng nguồn.
   Đăng nhập mã NV + mã kích hoạt → token lưu trên máy (localStorage). */
"use strict";
const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) { /* chế độ riêng tư */ } },
};
const FINAL = ["closed", "transferred"];
let base = null;
let token = store.get("at_token");
let me = null;
try { me = JSON.parse(store.get("at_me") || "null"); } catch (_) { me = null; }
let sid = null, lastId = 0, pollTimer = null, statusTimer = null, pending = [], sending = false, sessionStatus = "open";

/* ---------- máy chủ ---------- */
async function resolveBase(force) {
  if (base && !force) return base;
  if (/\.github\.io$/.test(location.hostname)) {
    // link tạm: raw.githubusercontent (cập nhật ngay khi máy IT đẩy) → link.json trên Pages (chờ Pages build ~1 phút)
    const owner = location.hostname.split(".")[0], repo = location.pathname.split("/")[1];
    const t = "?t=" + Date.now();
    base = null;
    for (const u of [`https://raw.githubusercontent.com/${owner}/${repo}/main/link.json${t}`, "link.json" + t]) {
      try {
        const j = await (await fetch(u, { cache: "no-store" })).json();
        if (j.api) { base = String(j.api).replace(/\/$/, ""); break; }
      } catch (_) { /* thử nguồn sau */ }
    }
    if (base) store.set("at_base", base);
    else base = store.get("at_base");
    if (!base) throw new Error("Chưa lấy được địa chỉ máy chủ IT – thử lại sau");
  } else {
    base = location.origin;
  }
  return base;
}

async function api(path, opt = {}, retry = true) {
  const b = await resolveBase(false);
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (/\.devtunnels\.ms$/.test(new URL(b).hostname)) headers["X-Tunnel-Skip-AntiPhishing-Page"] = "true";
  let body;
  if (opt.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opt.json); }
  let r;
  try {
    r = await fetch(b + path, { method: opt.method || (body ? "POST" : "GET"), headers, body });
  } catch (e) {
    // máy IT mở lại chat → link đường hầm đổi: đọc link.json mới rồi thử lại 1 lần
    if (retry) { await resolveBase(true); return api(path, opt, false); }
    setConn("off");
    throw new Error("Mất kết nối tới máy chủ IT");
  }
  if (r.status >= 500 && retry) { await resolveBase(true); return api(path, opt, false); }
  if (r.status === 401 && token) { logout(); throw new Error("Phiên đăng nhập hết hạn – đăng nhập lại"); }
  let data = null;
  try { data = await r.json(); } catch (_) { /* rỗng */ }
  if (!r.ok) throw new Error((data && data.detail) || "Lỗi " + r.status);
  return data;
}
const mediaUrl = (u) => base + u + "?t=" + encodeURIComponent(token || "");

/* ---------- tiện ích ---------- */
function show(view) {
  for (const v of ["login", "list", "chat"]) $("#v-" + v).hidden = v !== view;
  clearTimeout(pollTimer);
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 4000);
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function when(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) + " " + hm;
}
function setConn(state, title) {
  for (const d of [$("#dot"), $("#dot2")]) { d.className = "dot " + (state || ""); d.title = title || ""; }
}

/* ---------- đăng nhập ---------- */
$("#f-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter || $("#f-login button");
  btn.disabled = true; $("#l-err").textContent = "";
  try {
    const r = await api("/api/v1/login", { json: { code: $("#l-code").value.trim(), activation: $("#l-act").value.trim(),
                                                   device: navigator.userAgent.slice(0, 100) } });
    token = r.token; me = r.user;
    store.set("at_token", token); store.set("at_me", JSON.stringify(me));
    openList();
  } catch (err) { $("#l-err").textContent = err.message; }
  btn.disabled = false;
});
function logout() {
  token = null; me = null; store.set("at_token", null); store.set("at_me", null);
  $("#menu").hidden = true; show("login");
}
$("#b-logout").onclick = logout;
$("#b-menu").onclick = () => ($("#menu").hidden = !$("#menu").hidden);

/* ---------- trạng thái bot ---------- */
async function checkStatus() {
  clearTimeout(statusTimer);
  try {
    const s = await api("/api/v1/status");
    const paused = s.paused_until && s.paused_until * 1000 > Date.now();
    setConn(!s.online ? "off" : paused ? "busy" : "on", !s.online ? "Bot chưa sẵn sàng" : paused ? "Bot tạm nghỉ" : "Bot đang hoạt động");
    const b = $("#banner");
    b.hidden = s.online && !paused;
    b.textContent = !s.online ? "Bot chưa sẵn sàng – tin của anh/chị vẫn được lưu, IT sẽ xem." :
      "Bot tạm nghỉ (hết hạn mức xử lý) tới " + new Date(s.paused_until * 1000).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) + ".";
  } catch (e) {
    setConn("off", e.message);
    $("#banner").hidden = false; $("#banner").textContent = "Không kết nối được máy chủ IT (máy IT tắt / mất mạng).";
  }
  statusTimer = setTimeout(checkStatus, 30000);
}

/* ---------- danh sách phiếu ---------- */
async function openList() {
  show("list");
  $("#me").textContent = me ? `${me.code} - ${me.name}${me.store ? " · " + me.store : ""}` : "";
  checkStatus();
  try {
    const r = await api("/api/v1/sessions");
    const el = $("#list");
    el.innerHTML = r.sessions.length ? "" : '<div class="empty">Chưa có phiếu nào.<br>Bấm <b>+ Hỏi IT</b> để bắt đầu.</div>';
    for (const s of r.sessions) {
      const b = document.createElement("button");
      b.className = "item";
      b.innerHTML = `<div class="t">${esc(s.title || "(hình)")}</div>
        <div class="m"><span>${esc(s.id)} · ${esc(when(s.updated))}</span><span class="badge ${esc(s.status)}">${esc(s.status_vi)}</span></div>`;
      b.onclick = () => openChat(s.id);
      el.appendChild(b);
    }
  } catch (e) { toast(e.message); }
}
$("#b-new").onclick = () => openChat(null);
$("#b-back").onclick = () => openList();

/* ---------- chat ---------- */
function openChat(id) {
  sid = id; lastId = 0; sessionStatus = "open";
  $("#msgs").innerHTML = id ? "" : '<div class="note">Mô tả vấn đề cần hỗ trợ (kèm hình lỗi nếu có). Bot IT sẽ trả lời ngay.</div>';
  $("#c-title").textContent = id || "Phiếu mới";
  $("#c-sub").textContent = id ? "" : "Gửi tin đầu tiên để tạo phiếu";
  $("#typing").hidden = true;
  setComposer();
  show("chat");
  if (id) poll();
}
function setComposer() {
  $("#text").placeholder = FINAL.includes(sessionStatus) ? "Phiếu đã xong – gửi tin để tạo phiếu mới…" : "Nhập nội dung cần hỗ trợ…";
}
function renderMessage(m) {
  if (m.role === "system") {
    const n = document.createElement("div");
    n.className = "note"; n.textContent = m.text;
    return n;
  }
  const d = document.createElement("div");
  d.className = "msg " + m.role;
  if (m.role === "operator") { const w = document.createElement("span"); w.className = "who"; w.textContent = "IT"; d.appendChild(w); }
  for (const im of m.images || []) {
    const img = document.createElement("img");
    img.loading = "lazy"; img.src = mediaUrl(im.url); img.alt = "Hình " + im.n;
    img.onclick = () => { $("#viewer img").src = img.src; $("#viewer").hidden = false; };
    d.appendChild(img);
  }
  if (m.text) d.appendChild(document.createTextNode(m.text));
  const t = document.createElement("span"); t.className = "time"; t.textContent = when(m.created);
  d.appendChild(t);
  return d;
}
async function poll() {
  clearTimeout(pollTimer);
  if (!sid || $("#v-chat").hidden) return;
  let busy = false;
  try {
    const r = await api(`/api/v1/sessions/${encodeURIComponent(sid)}?after=${lastId}`);
    const box = $("#msgs");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    for (const m of r.messages) { box.appendChild(renderMessage(m)); lastId = Math.max(lastId, m.id); }
    if (r.messages.length && (atBottom || r.messages.some((m) => m.role === "user"))) box.scrollTop = box.scrollHeight;
    sessionStatus = r.session.status;
    $("#c-title").textContent = r.session.title || r.session.id;
    $("#c-sub").textContent = `${r.session.id} · ${r.session.status_vi}`;
    busy = r.working || r.queued;
    $("#typing").hidden = !busy;
    setComposer();
    setConn("on");
  } catch (e) { setConn("off", e.message); }
  if (!document.hidden) pollTimer = setTimeout(poll, busy ? 2000 : 6000);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (!$("#v-chat").hidden) poll();
  else if (!$("#v-list").hidden) openList();
});

/* gửi hình: thu nhỏ trên máy (cạnh dài ≤ 2000px, JPEG) – đỡ tốn 3G, chữ trên hình vẫn đọc được */
async function compress(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const s = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  } finally { URL.revokeObjectURL(url); }
}
$("#file").addEventListener("change", async (e) => {
  for (const f of [...e.target.files].slice(0, 6 - pending.length)) {
    try { pending.push(await compress(f)); } catch (_) { toast("Không đọc được hình " + f.name); }
  }
  e.target.value = "";
  renderThumbs();
});
function renderThumbs() {
  const el = $("#thumbs");
  el.innerHTML = "";
  pending.forEach((src, i) => {
    const w = document.createElement("div");
    w.innerHTML = `<img src="${src}" alt=""><button type="button" aria-label="Bỏ hình">×</button>`;
    w.querySelector("button").onclick = () => { pending.splice(i, 1); renderThumbs(); };
    el.appendChild(w);
  });
}
const ta = $("#text");
ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; });
$("#f-send").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = ta.value.trim();
  if (sending || (!text && !pending.length)) return;
  sending = true; $("#b-send").disabled = true;
  try {
    const r = await api("/api/v1/messages", { json: { session_id: sid, text, images: pending.map((d) => ({ data: d, type: "image/jpeg" })) } });
    ta.value = ""; ta.style.height = "auto"; pending = []; renderThumbs();
    if (r.session_id !== sid) {          // phiếu mới (lần đầu / phiếu cũ đã xong)
      sid = r.session_id; lastId = 0; $("#msgs").innerHTML = "";
    }
    $("#typing").hidden = false;
    poll();
  } catch (err) { toast(err.message); }
  sending = false; $("#b-send").disabled = false;
});
ta.addEventListener("keydown", (e) => {     // máy tính: Enter gửi, Shift+Enter xuống dòng
  if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); $("#f-send").requestSubmit(); }
});
$("#viewer").onclick = () => ($("#viewer").hidden = true);

/* ---------- khởi động ---------- */
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
$("#ios-tip").hidden = !(ios && !standalone);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
if (token) openList(); else show("login");
