/* Repo Manager — UI logic (no framework, plain JS) */
(() => {
  "use strict";

  const { t } = window.i18n;

  // Keep in sync with Settings::default() in src-tauri/src/config.rs.
  const DEFAULT_SETTINGS = {
    language: "system",
    motion: "system",
    autoUpdate: true,
    autoFetchMinutes: 0,
    fetchOnStart: false,
    pullParallel: 4,
    scanDepth: 1,
    terminal: "auto",
    editor: "code",
  };

  // ------------------------------------------------------------ backend
  const TAURI = window.__TAURI__;
  const backend = TAURI
    ? {
        invoke: (cmd, args) => TAURI.core.invoke(cmd, args),
        listen: (ev, cb) => TAURI.event.listen(ev, (e) => cb(e.payload)),
        win: TAURI.window.getCurrentWindow(),
      }
    : createMockBackend();

  const invoke = backend.invoke;

  // ------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const I = {
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
    folderGit: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="2"/><path d="M8 13h2M14 13h2"/>',
    pull: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
    branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M6 8.5v7M18 9.5c0 4.5-9 3-11.3 6.6"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    fetch: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    cloud: '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    tools: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
    gift: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  const ic = (name, cls = "ic") => `<svg class="${cls}" viewBox="0 0 24 24">${I[name]}</svg>`;

  function timeAgo(sec) {
    if (!sec) return "";
    const d = Math.max(0, Date.now() / 1000 - sec);
    if (d < 60) return t("time.now");
    const rtf = new Intl.RelativeTimeFormat(window.i18n.lang, { numeric: "auto", style: "short" });
    if (d < 3600) return rtf.format(-Math.floor(d / 60), "minute");
    if (d < 86400) return rtf.format(-Math.floor(d / 3600), "hour");
    if (d < 86400 * 30) return rtf.format(-Math.floor(d / 86400), "day");
    if (d < 86400 * 365) return rtf.format(-Math.floor(d / (86400 * 30)), "month");
    return rtf.format(-Math.floor(d / (86400 * 365)), "year");
  }

  // ------------------------------------------------------------ state
  const state = {
    roots: [],
    current: null,
    repos: [],
    counts: {},
    filter: "",
    busy: new Set(),
    expanded: new Set(),
    scanToken: 0,
    empty: null,
    settings: { ...DEFAULT_SETTINGS },
    settingsTab: "general",
    info: { version: "", build: "", channel: "", installed: false, repoUrl: "" },
    update: { status: "idle", info: null, progress: null, notified: false },
  };

  const els = {
    roots: $("#roots"),
    sel: $("#selIndicator"),
    rows: $("#rows"),
    rootName: $("#rootName"),
    rootPath: $("#rootPath"),
    search: $("#search"),
    pullAll: $("#pullAll"),
    refresh: $("#refresh"),
    addForm: $("#addForm"),
    addUrl: $("#addUrl"),
    addBtn: $("#addBtn"),
    addProgress: $("#addProgress"),
    status: $("#statusText"),
    updatePill: $("#updatePill"),
    scrim: $("#scrim"),
    modal: $("#modal"),
    pop: $("#popover"),
    toasts: $("#toasts"),
  };

  // ------------------------------------------------------------ toasts
  function toast(title, msg = "", kind = "info", ms = 3800) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    const icon = kind === "ok" ? "check" : kind === "err" ? "alert" : "info";
    el.innerHTML = `${ic(icon)}<div><b>${esc(title)}</b>${msg ? `<span>${esc(msg)}</span>` : ""}</div>`;
    els.toasts.appendChild(el);
    const kill = () => {
      el.classList.add("out");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    };
    const timer = setTimeout(kill, kind === "err" ? ms + 3000 : ms);
    el.addEventListener("click", () => { clearTimeout(timer); kill(); });
    while (els.toasts.children.length > 4) els.toasts.firstChild.remove();
  }

  let statusTimer;
  function setStatus(text, sticky = false) {
    els.status.textContent = text;
    clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(() => (els.status.textContent = ""), 6000);
  }

  function scanStatus() {
    const behind = state.repos.filter((r) => r.behind > 0).length;
    setStatus(t("scan.count", state.repos.length, behind), true);
  }

  // ------------------------------------------------------------ sidebar
  function renderRoots() {
    els.roots.querySelectorAll(".root-item").forEach((n) => n.remove());
    state.roots.forEach((r, i) => {
      const b = document.createElement("button");
      b.className = "root-item" + (r.path === state.current ? " active" : "") + (r.exists ? "" : " missing");
      b.style.animationDelay = `${i * 40}ms`;
      b.title = r.path;
      b.dataset.path = r.path;
      const c = state.counts[r.path];
      b.innerHTML = `${ic("folder")}<span class="names"><span class="name">${esc(r.name)}</span><span class="sub">${esc(r.path)}</span></span>
        <span class="count">${c ?? ""}</span>
        <span class="rm" title="${esc(t("root.remove"))}">${ic("x")}</span>
        <i class="live"></i>`;
      b.addEventListener("click", (e) => {
        if (e.target.closest(".rm")) return removeRoot(r);
        selectRoot(r.path);
      });
      els.roots.appendChild(b);
    });
    requestAnimationFrame(moveIndicator);
  }

  function moveIndicator() {
    const a = els.roots.querySelector(".root-item.active");
    if (!a) return els.sel.classList.remove("on");
    els.sel.style.transform = `translateY(${a.offsetTop}px)`;
    els.sel.style.height = `${a.offsetHeight}px`;
    els.sel.classList.add("on");
  }

  async function loadRoots() {
    const s = await invoke("get_roots");
    state.roots = s.roots;
    const pick = s.lastRoot && s.roots.some((r) => r.path === s.lastRoot) ? s.lastRoot : s.roots[0]?.path;
    renderRoots();
    if (pick) await selectRoot(pick, true);
    else showEmpty("noRoot");
  }

  async function addRoot() {
    try {
      const p = await invoke("pick_root");
      if (!p) return;
      const s = await invoke("add_root", { path: p });
      state.roots = s.roots;
      renderRoots();
      selectRoot(p, true);
      toast(t("root.added"), p, "ok");
    } catch (e) {
      toast(t("root.addFail"), String(e), "err");
    }
  }

  async function removeRoot(r) {
    const s = await invoke("remove_root", { path: r.path });
    state.roots = s.roots;
    delete state.counts[r.path];
    if (state.current === r.path) {
      state.current = null;
      renderRoots();
      if (s.roots[0]) selectRoot(s.roots[0].path, true);
      else showEmpty("noRoot");
    } else renderRoots();
    toast(t("root.removed"), r.name);
  }

  async function selectRoot(path, force = false) {
    if (path === state.current && !force) return;
    closePopover();
    state.current = path;
    els.roots.querySelectorAll(".root-item").forEach((n) => n.classList.toggle("active", n.dataset.path === path));
    moveIndicator();
    const r = state.roots.find((x) => x.path === path);
    els.rootName.textContent = r ? r.name : path;
    els.rootPath.textContent = path;
    invoke("set_last_root", { path }).catch(() => {});
    await scan();
  }

  // ------------------------------------------------------------ scanning
  async function scan({ quiet = false } = {}) {
    const token = ++state.scanToken;
    const path = state.current;
    if (!path) return;
    if (!quiet) await crossfade(() => renderSkeleton());
    try {
      const repos = await invoke("scan_root", { path });
      if (token !== state.scanToken) return;
      state.repos = repos;
      state.counts[path] = repos.length;
      const cnt = els.roots.querySelector(`.root-item[data-path="${CSS.escape(path)}"] .count`);
      if (cnt) cnt.textContent = repos.length;
      if (quiet) renderRows(false);
      else await crossfade(() => renderRows(true));
      scanStatus();
    } catch (e) {
      if (token !== state.scanToken) return;
      state.repos = [];
      showEmpty("error", String(e));
    }
  }

  async function crossfade(fn) {
    els.rows.classList.add("leaving");
    await sleep(150);
    fn();
    els.rows.scrollTop = 0;
    els.rows.classList.remove("leaving");
  }

  function renderSkeleton() {
    state.empty = null;
    els.rows.innerHTML = Array.from({ length: 5 }, (_, i) => `
      <div class="row skel" style="--i:${i}">
        <div class="repo"><div class="repo-ic"></div><div class="repo-main" style="width:60%"><div class="sk" style="width:70%"></div><div class="sk" style="width:45%;height:9px"></div></div></div>
        <div class="desc"><div class="sk" style="width:${60 + ((i * 17) % 30)}%"></div></div>
        <div class="actions"><div class="sk" style="width:120px;height:20px"></div></div>
      </div>`).join("");
  }

  function showEmpty(kind, extra = "") {
    state.empty = [kind, extra];
    const map = {
      noRoot: ["folder", t("empty.noRoot.h"), t("empty.noRoot.p")],
      noRepo: ["folderGit", t("empty.noRepo.h"), t("empty.noRepo.p")],
      noMatch: ["search", t("empty.noMatch.h"), t("empty.noMatch.p", state.filter)],
      error: ["alert", t("empty.error.h"), extra],
    };
    const [i, h, p] = map[kind];
    els.rows.innerHTML = `<div class="empty-state"><div class="big">${ic(i)}</div><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`;
    if (kind === "noRoot") {
      els.rootName.textContent = "Repo Manager";
      els.rootPath.textContent = "";
      setStatus("", true);
    }
  }

  function visibleRepos() {
    const f = state.filter.trim().toLowerCase();
    if (!f) return state.repos;
    return state.repos.filter((r) =>
      [r.name, r.description, r.branch].some((x) => (x || "").toLowerCase().includes(f)));
  }

  function renderRows(animate = true) {
    const list = visibleRepos();
    if (!state.repos.length) return showEmpty("noRepo");
    if (!list.length) return showEmpty("noMatch");
    state.empty = null;
    els.rows.innerHTML = "";
    list.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.path = r.path;
      if (animate) row.style.setProperty("--i", Math.min(i, 18));
      else row.style.animation = "none";
      row.innerHTML = rowHTML(r);
      els.rows.appendChild(row);
    });
    requestAnimationFrame(measureAll);
  }

  // ---- "see": expand or collapse the full description inside the row
  function measureDesc(row) {
    const d = row.querySelector(".desc-text");
    if (!d) return;
    const open = state.expanded.has(row.dataset.path);
    row.classList.toggle("expanded", open);
    if (open) d.style.maxHeight = "none";
    const more = open || d.scrollHeight > d.clientHeight + 2;
    row.classList.toggle("has-more", more);
    const b = row.querySelector(".see");
    b.disabled = !more;
    b.title = more ? (open ? t("see.less") : t("see.more")) : t("see.none");
  }
  function measureAll() { els.rows.querySelectorAll(".row:not(.skel)").forEach(measureDesc); }

  function toggleDesc(row, r) {
    const d = row.querySelector(".desc-text");
    const b = row.querySelector(".see");
    const open = !state.expanded.has(r.path);
    open ? state.expanded.add(r.path) : state.expanded.delete(r.path);
    const from = d.getBoundingClientRect().height;
    d.style.maxHeight = `${from}px`;
    void d.offsetHeight;
    row.classList.toggle("expanded", open);
    b.textContent = open ? t("see.close") : t("see.open");
    b.title = open ? t("see.less") : t("see.more");
    if (open) {
      d.style.maxHeight = `${d.scrollHeight}px`;
      d.addEventListener("transitionend", function done(e) {
        if (e.propertyName !== "max-height") return;
        d.removeEventListener("transitionend", done);
        if (state.expanded.has(r.path)) d.style.maxHeight = "none";
      });
    } else {
      d.style.maxHeight = "";
    }
  }

  function nameHTML(r) {
    const cut = r.group ? r.name.lastIndexOf("/") : -1;
    if (cut <= 0) return esc(r.name);
    return `<span class="grp">${esc(r.name.slice(0, cut + 1))}</span>${esc(r.name.slice(cut + 1))}`;
  }

  function rowHTML(r) {
    const chips = [];
    if (r.error) chips.push(`<span class="chip err" title="${esc(r.error)}">${ic("alert")}${esc(t("chip.error"))}</span>`);
    else {
      chips.push(`<span class="chip branch" title="${esc(r.upstream ? `${r.branch} → ${r.upstream}` : r.branch)}">${ic("branch")}<span>${esc(r.branch || "—")}</span></span>`);
      if (r.behind) chips.push(`<span class="chip behind" title="${esc(t("chip.behind", r.behind))}">${ic("down")}${r.behind}</span>`);
      if (r.ahead) chips.push(`<span class="chip ahead" title="${esc(t("chip.ahead", r.ahead))}">${ic("up")}${r.ahead}</span>`);
      if (r.changes) chips.push(`<span class="chip dirty" title="${esc(t("chip.dirty", r.changes))}">${ic("dot")}${r.changes}</span>`);
      if (r.lastCommit) chips.push(`<span class="chip time" title="${esc(r.lastCommit.subject)} — ${esc(r.lastCommit.author)}">${esc(timeAgo(r.lastCommit.time))}</span>`);
    }
    const desc = r.description || (r.lastCommit ? r.lastCommit.subject : "");
    const busy = state.busy.has(r.path);
    return `
      <div class="repo">
        <div class="repo-ic${r.isRoot ? " root" : ""}">${ic("folder")}</div>
        <div class="repo-main">
          <div class="repo-name"><span>${nameHTML(r)}</span>${r.isRoot ? `<span class="tag">${esc(t("tag.root"))}</span>` : ""}</div>
          <div class="meta">${chips.join("")}</div>
        </div>
      </div>
      <div class="desc">
        <span class="desc-text${desc ? "" : " empty"}">${esc(desc || t("desc.none"))}</span>
        <button class="see" data-act="see">${esc(state.expanded.has(r.path) ? t("see.close") : t("see.open"))}</button>
      </div>
      <div class="actions">
        <button class="act pull${busy ? " busy" : ""}" data-act="pull" title="${esc(t("act.pull"))}">${ic("pull")}${r.behind ? `<span class="badge">${r.behind}</span>` : ""}</button>
        <button class="act branch" data-act="branch" title="${esc(t("act.branch"))}">${ic("branch")}</button>
        <button class="act open" data-act="open" title="${esc(t("act.open"))}">${ic("open")}</button>
        <button class="act folder" data-act="folder" title="${esc(t("act.folder"))}">${ic("folder")}</button>
      </div>`;
  }

  function repoByPath(p) { return state.repos.find((r) => r.path === p); }
  function rowEl(p) { return els.rows.querySelector(`.row[data-path="${CSS.escape(p)}"]`); }

  function updateRepo(info, flash) {
    const i = state.repos.findIndex((r) => r.path === info.path);
    if (i >= 0) state.repos[i] = info;
    const el = rowEl(info.path);
    if (!el) return;
    el.innerHTML = rowHTML(info);
    measureDesc(el);
    if (flash) {
      el.style.animation = "";
      el.classList.remove("flash-ok", "flash-err");
      void el.offsetWidth;
      el.classList.add(flash === "err" ? "flash-err" : "flash-ok");
    }
  }

  function setActState(path, act, cls, ms = 1400) {
    const b = rowEl(path)?.querySelector(`.act.${act}`);
    if (!b) return;
    b.classList.remove("busy", "ok", "bad");
    if (cls) b.classList.add(cls);
    if (cls === "ok" || cls === "bad") {
      b.innerHTML = ic(cls === "ok" ? "check" : "alert");
      setTimeout(() => {
        const r = repoByPath(path);
        const nb = rowEl(path)?.querySelector(`.act.${act}`);
        if (r && nb) {
          nb.classList.remove("ok", "bad");
          nb.innerHTML = ic(act) + (act === "pull" && r.behind ? `<span class="badge">${r.behind}</span>` : "");
        }
      }, ms);
    }
  }

  // ------------------------------------------------------------ actions
  async function pullOne(r) {
    if (state.busy.has(r.path)) return;
    state.busy.add(r.path);
    setActState(r.path, "pull", "busy");
    try {
      const res = await invoke("pull", { path: r.path, isRoot: r.isRoot });
      state.busy.delete(r.path);
      applyPullResult(res, true);
    } catch (e) {
      state.busy.delete(r.path);
      setActState(r.path, "pull", "bad");
      toast(r.name, String(e), "err");
    }
  }

  function applyPullResult(res, notify) {
    const ok = res.status !== "error";
    updateRepo(res.repo, ok ? (res.status === "updated" ? "ok" : null) : "err");
    setActState(res.repo.path, "pull", ok ? "ok" : "bad");
    if (!notify) return;
    if (res.status === "updated") toast(res.repo.name, res.message, "ok");
    else if (res.status === "uptodate") setStatus(t("pull.uptodate", res.repo.name));
    else toast(t("pull.failed", res.repo.name), res.message, "err");
  }

  async function pullAll() {
    const list = visibleRepos().filter((r) => !state.busy.has(r.path));
    if (!list.length) return;
    els.pullAll.classList.add("busy");
    els.pullAll.disabled = true;
    list.forEach((r) => { state.busy.add(r.path); setActState(r.path, "pull", "busy"); });
    let done = 0;
    setStatus(t("pull.progress", 0, list.length), true);
    const un = await backend.listen("pull-progress", (res) => {
      if (!list.some((r) => r.path === res.repo.path)) return;
      state.busy.delete(res.repo.path);
      done++;
      setStatus(t("pull.progress", done, list.length), true);
      applyPullResult(res, false);
      if (res.status === "error") toast(t("pull.failed", res.repo.name), res.message, "err");
    });
    try {
      const s = await invoke("pull_all", { repos: list.map((r) => [r.path, r.isRoot]) });
      const parts = [];
      if (s.updated) parts.push(t("pullAll.updated", s.updated));
      if (s.uptodate) parts.push(t("pullAll.uptodate", s.uptodate));
      if (s.failed) parts.push(t("pullAll.failed", s.failed));
      toast(t("pullAll.done"), parts.join(" · "), s.failed ? "err" : "ok");
      setStatus(parts.join(" · "));
    } catch (e) {
      toast(t("pullAll.fail"), String(e), "err");
    } finally {
      un && un();
      list.forEach((r) => state.busy.delete(r.path));
      els.pullAll.classList.remove("busy");
      els.pullAll.disabled = false;
    }
  }

  async function refresh({ auto = false } = {}) {
    if (!state.current || els.refresh.disabled) return;
    els.refresh.disabled = true;
    els.refresh.classList.add("busy");
    if (!auto) setStatus(t("refresh.status"), true);
    const behindBefore = new Map(state.repos.map((r) => [r.path, r.behind]));
    try {
      const list = [...state.repos];
      let i = 0;
      const worker = async () => {
        while (i < list.length) {
          const r = list[i++];
          try { updateRepo(await invoke("fetch", { path: r.path, isRoot: r.isRoot })); }
          catch { /* offline or no remote: the row keeps its last state */ }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      await scan({ quiet: true });
      if (auto) {
        const grew = state.repos.filter((r) => r.behind > (behindBefore.get(r.path) ?? 0)).length;
        if (grew) toast(t("autoFetch.found", grew), "", "info", 6000);
      }
    } finally {
      els.refresh.disabled = false;
      els.refresh.classList.remove("busy");
    }
  }

  let autoFetchTimer = null;
  function scheduleAutoFetch() {
    clearInterval(autoFetchTimer);
    const min = state.settings.autoFetchMinutes;
    if (!min) return;
    autoFetchTimer = setInterval(() => {
      if (popFor || els.addForm.classList.contains("cloning") || state.busy.size) return;
      refresh({ auto: true });
    }, min * 60_000);
  }

  // ------------------------------------------------------------ popover
  let popFor = null;
  function openPopover(anchor, html, onClick) {
    const p = els.pop;
    p.innerHTML = html;
    p.classList.add("open");
    const a = anchor.getBoundingClientRect();
    const w = p.offsetWidth, h = p.offsetHeight;
    const left = Math.min(window.innerWidth - w - 10, a.right - w + 4);
    let top = a.bottom + 6;
    if (top + h > window.innerHeight - 40) {
      top = Math.max(10, a.top - h - 6);
      p.style.transformOrigin = "bottom right";
    } else p.style.transformOrigin = "top right";
    p.style.left = `${Math.max(10, left)}px`;
    p.style.top = `${top}px`;
    popFor = anchor;
    p.onclick = (e) => {
      const it = e.target.closest(".pop-item");
      if (it) { closePopover(); onClick(it.dataset); }
    };
  }
  function closePopover() { els.pop.classList.remove("open"); popFor = null; }

  async function branchMenu(btn, r) {
    if (popFor === btn) return closePopover();
    openPopover(btn, `<div class="pop-head">${esc(t("pop.loading"))}</div>`, () => {});
    try {
      const b = await invoke("list_branches", { path: r.path });
      if (popFor !== btn) return;
      let html = `<button class="pop-item" data-k="fetch">${ic("fetch")}<span class="lbl">${esc(t("pop.fetch"))}</span></button><div class="pop-sep"></div>`;
      html += `<div class="pop-head">${esc(t("pop.local"))}</div>`;
      html += b.local.map((n) => `<button class="pop-item mono${n === b.current ? " current" : ""}" data-k="co" data-b="${esc(n)}" ${n === b.current ? "disabled" : ""}>${ic(n === b.current ? "check" : "branch")}<span class="lbl">${esc(n)}</span></button>`).join("") || `<div class="pop-head">—</div>`;
      if (b.remote.length) {
        html += `<div class="pop-sep"></div><div class="pop-head">${esc(t("pop.remote"))}</div>`;
        html += b.remote.map((n) => `<button class="pop-item mono" data-k="co" data-b="${esc(n)}">${ic("cloud")}<span class="lbl">${esc(n)}</span></button>`).join("");
      }
      openPopover(btn, html, async (d) => {
        if (d.k === "fetch") {
          setActState(r.path, "branch", "busy");
          try { updateRepo(await invoke("fetch", { path: r.path, isRoot: r.isRoot }), "ok"); setActState(r.path, "branch", "ok"); }
          catch (e) { setActState(r.path, "branch", "bad"); toast(t("fetch.failed", r.name), String(e), "err"); }
        } else if (d.k === "co") {
          try {
            const info = await invoke("checkout", { path: r.path, branch: d.b, isRoot: r.isRoot });
            updateRepo(info, "ok");
            toast(r.name, t("checkout.ok", info.branch), "ok");
          } catch (e) {
            updateRepo(repoByPath(r.path), "err");
            toast(t("checkout.fail", r.name), String(e), "err");
          }
        }
      });
    } catch (e) {
      closePopover();
      toast(r.name, String(e), "err");
    }
  }

  function openMenu(btn, r) {
    if (popFor === btn) return closePopover();
    const html = `
      <button class="pop-item" data-k="term">${ic("terminal")}<span class="lbl">${esc(t("open.term"))}</span></button>
      <button class="pop-item" data-k="code">${ic("code")}<span class="lbl">${esc(t("open.code"))}</span></button>
      <button class="pop-item" data-k="web" ${r.remoteUrl ? "" : "disabled"}>${ic("globe")}<span class="lbl">${esc(t("open.web"))}</span></button>
      <div class="pop-sep"></div>
      <button class="pop-item" data-k="readme">${ic("info")}<span class="lbl">${esc(t("open.readme"))}</span></button>`;
    openPopover(btn, html, async (d) => {
      try {
        if (d.k === "term") await invoke("open_terminal", { path: r.path });
        if (d.k === "code") await invoke("open_editor", { path: r.path });
        if (d.k === "web") await invoke("open_remote", { remote: r.remoteUrl });
        if (d.k === "readme") showDetails(repoByPath(r.path) || r);
      } catch (e) { toast(t("open.fail"), String(e), "err"); }
    });
  }

  // ------------------------------------------------------------ modal
  function openModal(html, kind = "") {
    els.modal.className = `modal open${kind ? ` ${kind}` : ""}`;
    els.modal.innerHTML = html;
    els.scrim.classList.add("open");
    $(".modal-close", els.modal)?.focus();
  }
  function closeModal() {
    els.scrim.classList.remove("open");
    els.modal.classList.remove("open");
  }
  const modalKind = () => (els.modal.classList.contains("open") ? (els.modal.classList.contains("settings") ? "settings" : "details") : null);

  async function showDetails(r) {
    const chips = $(`.row[data-path="${CSS.escape(r.path)}"] .meta`, els.rows)?.innerHTML || "";
    const commit = r.lastCommit
      ? `<div class="commit-card">${ic("clock")}<code>${esc(r.lastCommit.hash)}</code><span class="s">${esc(r.lastCommit.subject)}</span><span>${esc(r.lastCommit.author)} · ${esc(timeAgo(r.lastCommit.time))}</span></div>`
      : "";
    openModal(`
      <div class="modal-head">
        <div class="repo-ic${r.isRoot ? " root" : ""}">${ic("folder")}</div>
        <div class="modal-title">
          <h2>${esc(r.name)}</h2>
          <div class="meta">${chips}</div>
          <div class="path">${esc(r.path)}${r.remoteUrl ? `<br>${esc(r.remoteUrl)}` : ""}</div>
        </div>
        <button class="modal-close" data-close title="${esc(t("modal.close"))}">${ic("x")}</button>
      </div>
      <div class="modal-body">${commit}<div class="md" id="mdBody"><div class="sk" style="width:60%"></div><br><div class="sk" style="width:90%"></div><br><div class="sk" style="width:75%"></div></div></div>
      <div class="modal-foot">
        <button class="btn small" data-m="folder">${ic("folder")}<span>${esc(t("modal.folder"))}</span></button>
        <button class="btn small" data-m="term">${ic("terminal")}<span>${esc(t("modal.term"))}</span></button>
        <button class="btn small primary" data-m="pull">${ic("pull")}<span>${esc(t("modal.pull"))}</span></button>
      </div>`);
    els.modal.onclick = (e) => {
      if (e.target.closest("[data-close]")) return closeModal();
      const m = e.target.closest("[data-m]")?.dataset.m;
      if (m === "folder") invoke("open_folder", { path: r.path }).catch((x) => toast(t("open.fail"), String(x), "err"));
      if (m === "term") invoke("open_terminal", { path: r.path }).catch((x) => toast(t("open.fail"), String(x), "err"));
      if (m === "pull") { closeModal(); pullOne(repoByPath(r.path) || r); }
    };
    els.modal.onchange = els.modal.oninput = null;
    try {
      const text = await invoke("read_readme", { path: r.path });
      const body = $("#mdBody");
      if (!body) return;
      body.innerHTML = text
        ? renderMarkdown(text)
        : `<p class="muted">${esc(t("modal.noReadme"))}${r.description ? `<br><br>${esc(r.description)}` : ""}</p>`;
    } catch (e) {
      $("#mdBody") && ($("#mdBody").innerHTML = `<p class="muted">${esc(String(e))}</p>`);
    }
  }

  // Minimal, safe markdown → HTML (escape first, then format).
  function renderMarkdown(src) {
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let para = [], list = null, code = null, quote = [];
    const inline = (s) => esc(s)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a title="$2">$1</a>');
    const flushP = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
    const flushL = () => { if (list) out.push(`<${list.t}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.t}>`); list = null; };
    const flushQ = () => { if (quote.length) out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`); quote = []; };
    const flush = () => { flushP(); flushL(); flushQ(); };
    let inComment = false;
    for (const raw of lines) {
      if (code) {
        if (/^\s*(```|~~~)/.test(raw)) { out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = null; }
        else code.push(raw);
        continue;
      }
      if (inComment) { if (raw.includes("-->")) inComment = false; continue; }
      const l = raw.trim();
      if (l.startsWith("<!--")) { inComment = !l.includes("-->"); continue; }
      if (/^(```|~~~)/.test(l)) { flush(); code = []; continue; }
      if (!l) { flush(); continue; }
      let m;
      if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*$/))) { flush(); const n = Math.min(4, m[1].length); out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
      if (/^([-*_])(\s*\1){2,}$/.test(l)) { flush(); out.push("<hr>"); continue; }
      if (l.startsWith("<")) { continue; } // raw HTML is skipped
      if ((m = l.match(/^>\s?(.*)/))) { flushP(); flushL(); quote.push(m[1]); continue; }
      if ((m = raw.match(/^\s*([-*+]|\d+[.)])\s+(.*)/))) {
        flushP(); flushQ();
        const tag = /\d/.test(m[1]) ? "ol" : "ul";
        if (!list || list.t !== tag) { flushL(); list = { t: tag, items: [] }; }
        list.items.push(m[2].replace(/^\[( |x)\]\s*/i, (_, x) => (x.trim() ? "☑ " : "☐ ")));
        continue;
      }
      if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1] += " " + l; continue; }
      flushL(); flushQ();
      para.push(l);
    }
    if (code) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    flush();
    return out.join("\n");
  }

  // ------------------------------------------------------------ settings
  const EDITORS = [["code", "VS Code"], ["cursor", "Cursor"], ["codium", "VSCodium"], ["zed", "Zed"]];
  const TERMINALS = () => [
    ["auto", t("set.terminal.auto")],
    ["wt", "Windows Terminal"],
    ["pwsh", "PowerShell 7"],
    ["powershell", "Windows PowerShell"],
    ["cmd", t("set.terminal.cmd")],
  ];
  const TABS = () => [
    ["general", "sliders", t("set.general")],
    ["git", "branch", t("set.git")],
    ["tools", "tools", t("set.tools")],
    ["updates", "gift", t("set.updates")],
    ["about", "info", t("set.about")],
  ];

  function applySettings(prev = {}) {
    const s = state.settings;
    document.documentElement.dataset.motion = s.motion;
    if (s.language !== prev.language) {
      const lang = window.i18n.set(s.language);
      invoke("set_ui_lang", { lang }).catch(() => {});
      if (prev.language !== undefined) rerenderAll();
    }
    if (s.autoFetchMinutes !== prev.autoFetchMinutes) scheduleAutoFetch();
    if (s.autoUpdate !== prev.autoUpdate) scheduleUpdateChecks();
    if (prev.scanDepth !== undefined && s.scanDepth !== prev.scanDepth) scan();
  }

  function rerenderAll() {
    renderRoots();
    if (state.empty) showEmpty(...state.empty);
    else if (state.repos.length) renderRows(false);
    if (state.current) scanStatus();
    renderUpdatePill();
    if (modalKind() === "settings") renderSettings();
    else if (modalKind() === "details") closeModal();
  }

  async function saveSetting(key, value) {
    const prev = { ...state.settings };
    state.settings = { ...prev, [key]: value };
    try {
      state.settings = { ...DEFAULT_SETTINGS, ...(await invoke("set_settings", { settings: state.settings })) };
    } catch (e) {
      state.settings = prev;
      toast(t("set.saveFail"), String(e), "err");
    }
    applySettings(prev);
    if (modalKind() === "settings") renderSettings();
  }

  const segment = (key, opts) => `<div class="seg" role="radiogroup">${opts.map(([v, l]) =>
    `<button type="button" role="radio" aria-checked="${String(state.settings[key]) === String(v)}" class="${String(state.settings[key]) === String(v) ? "on" : ""}" data-key="${key}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</div>`;
  const toggle = (key) => `<button type="button" class="switch${state.settings[key] ? " on" : ""}" role="switch" aria-checked="${!!state.settings[key]}" data-key="${key}" data-toggle><i></i></button>`;
  const select = (key, opts, value = state.settings[key]) => `<span class="select"><select data-key="${key}">${opts.map(([v, l]) =>
    `<option value="${esc(v)}"${String(value) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>${ic("down")}</span>`;
  const setRow = (label, desc, control) => `<div class="set-row"><div class="set-lbl"><b>${esc(label)}</b>${desc ? `<span>${esc(desc)}</span>` : ""}</div><div class="set-ctl">${control}</div></div>`;

  function updateStatusHTML() {
    const u = state.update;
    const map = {
      idle: "",
      checking: t("upd.checking"),
      none: t("upd.none"),
      error: t("upd.checkFail"),
      available: u.info ? t("upd.available", u.info.version) : "",
      downloading: t("upd.downloading", u.progress),
      installing: t("upd.installing"),
    };
    const cls = u.status === "available" ? "new" : u.status === "error" ? "err" : u.status === "none" ? "ok" : "";
    return `<span class="upd-status ${cls}">${esc(map[u.status] || "")}</span>`;
  }

  function settingsPane(tab) {
    const s = state.settings;
    if (tab === "general") {
      return setRow(t("set.language"), t("set.language.d"), segment("language", [["system", t("set.lang.system")], ["tr", "Türkçe"], ["en", "English"]]))
        + setRow(t("set.motion"), t("set.motion.d"), segment("motion", [["system", t("set.motion.system")], ["full", t("set.motion.full")], ["reduced", t("set.motion.reduced")]]));
    }
    if (tab === "git") {
      const fetchOpts = [[0, t("set.autoFetch.off")], ...[5, 15, 30, 60].map((n) => [n, t("set.autoFetch.min", n)])];
      return setRow(t("set.parallel"), t("set.parallel.d"),
          `<div class="stepper"><button type="button" data-step="-1" ${s.pullParallel <= 1 ? "disabled" : ""}>${ic("minus")}</button><output>${s.pullParallel}</output><button type="button" data-step="1" ${s.pullParallel >= 8 ? "disabled" : ""}>${ic("plus")}</button></div>`)
        + setRow(t("set.autoFetch"), t("set.autoFetch.d"), select("autoFetchMinutes", fetchOpts))
        + setRow(t("set.fetchOnStart"), t("set.fetchOnStart.d"), toggle("fetchOnStart"))
        + setRow(t("set.depth"), t("set.depth.d"), segment("scanDepth", [[1, t("set.depth.1")], [2, t("set.depth.2")]]));
    }
    if (tab === "tools") {
      const preset = EDITORS.some(([v]) => v === s.editor);
      const editorSel = select("editorPreset", [...EDITORS, ["custom", t("set.editor.custom")]], preset ? s.editor : "custom");
      const custom = preset ? "" : `<input class="text-in" data-key="editor" value="${esc(s.editor)}" placeholder="${esc(t("set.editor.customPh"))}" spellcheck="false">`;
      return setRow(t("set.terminal"), t("set.terminal.d"), select("terminal", TERMINALS()))
        + setRow(t("set.editor"), t("set.editor.d"), `<div class="ctl-col">${editorSel}${custom}</div>`);
    }
    if (tab === "updates") {
      const u = state.update;
      const canAct = u.status === "available";
      const actBtn = canAct
        ? `<button class="btn small primary" data-upd="install">${ic(state.info.installed ? "pull" : "globe")}<span>${esc(state.info.installed ? t("upd.install") : t("upd.download"))}</span></button>`
        : "";
      const busy = u.status === "checking" || u.status === "downloading" || u.status === "installing";
      return setRow(t("set.autoUpdate"), t("set.autoUpdate.d"), toggle("autoUpdate"))
        + `<div class="set-row upd-row"><div class="set-lbl"><b>v${esc(state.info.version)}</b>${updateStatusHTML()}</div><div class="set-ctl">${actBtn}<button class="btn small" data-upd="check" ${busy ? "disabled" : ""}>${ic("pull", `ic${u.status === "checking" ? " spinning" : ""}`)}<span>${esc(t("set.checkNow"))}</span></button></div></div>`
        + (state.info.installed ? "" : `<p class="set-note">${esc(t("set.portableNote"))}</p>`);
    }
    return `<div class="about">
        <img src="logo.svg" alt="" class="about-logo">
        <div class="about-name">Repo Manager</div>
        <dl>
          <dt>${esc(t("set.version"))}</dt><dd><code>v${esc(state.info.version)}</code> <b class="channel">${esc(state.info.channel)}</b></dd>
          <dt>${esc(t("set.build"))}</dt><dd><code>${esc(state.info.build)}</code></dd>
          <dt>${esc(t("set.license"))}</dt><dd>GPL-3.0</dd>
        </dl>
        <button class="btn small" data-link="repo">${ic("globe")}<span>${esc(t("set.source"))}</span></button>
      </div>`;
  }

  function renderSettings() {
    const tab = state.settingsTab;
    const nav = TABS().map(([k, icon, label]) =>
      `<button type="button" class="set-tab${k === tab ? " on" : ""}" data-tab="${k}">${ic(icon)}<span>${esc(label)}</span></button>`).join("");
    const html = `
      <div class="modal-head set-head">
        <div class="set-badge">${ic("sliders")}</div>
        <div class="modal-title"><h2>${esc(t("set.title"))}</h2></div>
        <button class="modal-close" data-close title="${esc(t("modal.close"))}">${ic("x")}</button>
      </div>
      <div class="set-body">
        <nav class="set-nav">${nav}</nav>
        <section class="set-pane" data-pane="${tab}">${settingsPane(tab)}</section>
      </div>`;
    if (modalKind() === "settings") {
      const pane = $(".set-pane", els.modal);
      const nav2 = $(".set-nav", els.modal);
      $(".set-head h2", els.modal).textContent = t("set.title");
      nav2.innerHTML = nav;
      const switched = pane.dataset.pane !== tab;
      pane.dataset.pane = tab;
      pane.innerHTML = settingsPane(tab);
      if (switched) { pane.classList.remove("swap"); void pane.offsetWidth; pane.classList.add("swap"); }
    } else {
      openModal(html, "settings");
    }
    els.modal.onclick = onSettingsClick;
    els.modal.onchange = onSettingsChange;
    els.modal.oninput = null;
  }

  function openSettings() {
    closePopover();
    renderSettings();
  }

  function onSettingsClick(e) {
    if (e.target.closest("[data-close]")) return closeModal();
    const tab = e.target.closest("[data-tab]");
    if (tab) { state.settingsTab = tab.dataset.tab; return renderSettings(); }
    const seg = e.target.closest(".seg [data-v]");
    if (seg) {
      const key = seg.dataset.key;
      const v = typeof DEFAULT_SETTINGS[key] === "number" ? Number(seg.dataset.v) : seg.dataset.v;
      if (state.settings[key] !== v) saveSetting(key, v);
      return;
    }
    const sw = e.target.closest("[data-toggle]");
    if (sw) return saveSetting(sw.dataset.key, !state.settings[sw.dataset.key]);
    const step = e.target.closest("[data-step]");
    if (step) {
      const n = Math.min(8, Math.max(1, state.settings.pullParallel + Number(step.dataset.step)));
      if (n !== state.settings.pullParallel) saveSetting("pullParallel", n);
      return;
    }
    const upd = e.target.closest("[data-upd]");
    if (upd) return upd.dataset.upd === "check" ? checkUpdate({ silent: false }) : installUpdate();
    if (e.target.closest("[data-link='repo']") && state.info.repoUrl) {
      invoke("open_remote", { remote: state.info.repoUrl }).catch((x) => toast(t("open.fail"), String(x), "err"));
    }
  }

  function onSettingsChange(e) {
    const el = e.target;
    const key = el.dataset.key;
    if (!key) return;
    if (key === "editorPreset") {
      if (el.value === "custom") {
        const ctl = el.closest(".ctl-col");
        if (!$(".text-in", ctl)) {
          ctl.insertAdjacentHTML("beforeend", `<input class="text-in" data-key="editor" value="" placeholder="${esc(t("set.editor.customPh"))}" spellcheck="false">`);
        }
        $(".text-in", ctl).focus();
      } else saveSetting("editor", el.value);
      return;
    }
    if (key === "editor") {
      const v = el.value.trim();
      if (v && v !== state.settings.editor) saveSetting("editor", v);
      return;
    }
    const v = typeof DEFAULT_SETTINGS[key] === "number" ? Number(el.value) : el.value;
    saveSetting(key, v);
  }

  // ------------------------------------------------------------ updates
  function setUpdate(patch) {
    Object.assign(state.update, patch);
    renderUpdatePill();
    if (modalKind() === "settings" && state.settingsTab === "updates") renderSettings();
  }

  function renderUpdatePill() {
    const u = state.update;
    const show = ["available", "downloading", "installing"].includes(u.status) && u.info;
    els.updatePill.hidden = !show;
    if (!show) return;
    els.updatePill.classList.toggle("working", u.status !== "available");
    els.updatePill.disabled = u.status !== "available";
    const label = u.status === "available"
      ? `${t("upd.available", u.info.version)} · ${state.info.installed ? t("upd.install") : t("upd.download")}`
      : u.status === "downloading" ? t("upd.downloading", u.progress) : t("upd.installing");
    els.updatePill.innerHTML = `${ic(u.status === "available" ? "gift" : "pull", `ic${u.status === "available" ? "" : " spinning"}`)}<span>${esc(label)}</span>`;
  }

  async function checkUpdate({ silent }) {
    if (["checking", "downloading", "installing"].includes(state.update.status)) return;
    setUpdate({ status: "checking" });
    try {
      const info = await invoke("check_update");
      if (info) {
        setUpdate({ status: "available", info });
        if (silent && !state.update.notified) {
          state.update.notified = true;
          toast(t("upd.toast", info.version), state.info.installed ? t("upd.toastInstalled") : t("upd.toastPortable"), "info", 8000);
        }
      } else setUpdate({ status: "none", info: null });
    } catch (e) {
      setUpdate({ status: silent ? "idle" : "error" });
      if (!silent) toast(t("upd.checkFail"), String(e), "err");
    }
  }

  async function installUpdate() {
    if (state.update.status !== "available") return;
    if (!state.info.installed) {
      invoke("open_remote", { remote: `${state.info.repoUrl}/releases/latest` }).catch((x) => toast(t("open.fail"), String(x), "err"));
      return;
    }
    setUpdate({ status: "downloading", progress: null });
    const un = await backend.listen("update-progress", (p) => {
      const pct = p.total ? Math.min(100, Math.round((p.downloaded / p.total) * 100)) : null;
      if (pct === 100) setUpdate({ status: "installing" });
      else if (pct !== state.update.progress) setUpdate({ progress: pct });
    });
    try {
      await invoke("install_update");
      setUpdate({ status: "installing" });
    } catch (e) {
      setUpdate({ status: "available" });
      toast(t("upd.installFail"), String(e), "err");
    } finally {
      un && un();
    }
  }

  let updateTimer = null;
  let firstCheck = null;
  function scheduleUpdateChecks() {
    clearInterval(updateTimer);
    clearTimeout(firstCheck);
    if (!state.settings.autoUpdate) return;
    firstCheck = setTimeout(() => checkUpdate({ silent: true }), 8000);
    updateTimer = setInterval(() => checkUpdate({ silent: true }), 12 * 3600_000);
  }

  // ------------------------------------------------------------ clone
  let cloneId = 0;
  async function cloneRepo(e) {
    e.preventDefault();
    const url = els.addUrl.value.trim();
    if (!url) { els.addUrl.focus(); return; }
    if (!state.current) { toast(t("clone.noRoot"), "", "err"); return; }
    const id = String(++cloneId);
    els.addForm.classList.add("cloning");
    els.addBtn.disabled = true;
    els.addUrl.readOnly = true;
    els.addProgress.style.width = "4%";
    const phases = { "Counting objects": [0, 10], "Compressing objects": [10, 20], "Receiving objects": [20, 85], "Resolving deltas": [85, 97], "Updating files": [97, 100] };
    const un = await backend.listen("clone-progress", (p) => {
      if (p.id !== id) return;
      const [a, b] = phases[p.phase] || [0, 5];
      const pct = a + ((b - a) * (p.percent ?? 0)) / 100;
      els.addProgress.style.width = `${Math.max(4, pct)}%`;
      setStatus(`${p.phase}${p.percent != null ? ` ${p.percent}%` : ""}`, true);
    });
    try {
      const info = await invoke("clone_repo", { root: state.current, url, id });
      els.addProgress.style.width = "100%";
      els.addUrl.value = "";
      toast(t("clone.ok"), info.name, "ok");
      setStatus(t("clone.okStatus", info.name));
      await scan({ quiet: true });
      const row = rowEl(info.path);
      if (row) { row.scrollIntoView({ block: "nearest", behavior: "smooth" }); row.classList.add("flash-ok"); }
    } catch (err) {
      toast(t("clone.fail"), String(err), "err");
      setStatus("");
    } finally {
      un && un();
      await sleep(400);
      els.addForm.classList.remove("cloning");
      els.addProgress.style.width = "0";
      els.addBtn.disabled = false;
      els.addUrl.readOnly = false;
    }
  }

  // ------------------------------------------------------------ events
  els.rows.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const r = repoByPath(btn.closest(".row").dataset.path);
    if (!r) return;
    switch (btn.dataset.act) {
      case "pull": return pullOne(r);
      case "branch": return branchMenu(btn, r);
      case "open": return openMenu(btn, r);
      case "folder": return invoke("open_folder", { path: r.path }).catch((x) => toast(t("open.fail"), String(x), "err"));
      case "see": return toggleDesc(btn.closest(".row"), r);
    }
  });
  els.rows.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".row");
    if (row && !e.target.closest("button")) { const r = repoByPath(row.dataset.path); r && showDetails(r); }
  });

  $("#addRoot").addEventListener("click", addRoot);
  $("#openSettings").addEventListener("click", openSettings);
  els.pullAll.addEventListener("click", pullAll);
  els.refresh.addEventListener("click", () => refresh());
  els.updatePill.addEventListener("click", installUpdate);
  els.addForm.addEventListener("submit", cloneRepo);
  els.scrim.addEventListener("click", closeModal);
  els.search.addEventListener("input", () => { state.filter = els.search.value; renderRows(false); });
  els.rows.addEventListener("scroll", closePopover, { passive: true });
  let resizeT;
  window.addEventListener("resize", () => {
    closePopover(); moveIndicator();
    clearTimeout(resizeT); resizeT = setTimeout(measureAll, 120);
  });
  document.addEventListener("mousedown", (e) => {
    if (popFor && !els.pop.contains(e.target) && !popFor.contains(e.target)) closePopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (els.modal.classList.contains("open")) return closeModal();
      if (popFor) return closePopover();
      if (document.activeElement === els.search && els.search.value) { els.search.value = ""; state.filter = ""; renderRows(false); }
      document.activeElement?.blur();
    }
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (e.key === "/" && !typing) { e.preventDefault(); els.search.focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); modalKind() === "settings" ? closeModal() : openSettings(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") { e.preventDefault(); refresh(); }
    if (e.key === "F5") { e.preventDefault(); scan(); }
  });
  document.addEventListener("contextmenu", (e) => { if (!e.target.closest("input, .md, .path")) e.preventDefault(); });

  $("#winMin").addEventListener("click", () => backend.win.minimize());
  $("#winMax").addEventListener("click", () => backend.win.toggleMaximize());
  $("#winClose").addEventListener("click", () => backend.win.close());

  // ------------------------------------------------------------ boot
  (async () => {
    try {
      state.info = { ...state.info, ...(await invoke("app_info")) };
      $("#buildHash").textContent = state.info.build;
      $("#version").textContent = `v${state.info.version}`;
      $("#channel").textContent = state.info.channel;
    } catch {}
    try { state.settings = { ...DEFAULT_SETTINGS, ...(await invoke("get_settings")) }; } catch {}
    applySettings();
    requestAnimationFrame(() => backend.win.show().catch?.(() => {}));
    try { await loadRoots(); }
    catch (e) { showEmpty("error", String(e)); }
    if (state.settings.fetchOnStart && state.repos.length) refresh({ auto: true });
  })();

  // ------------------------------------------------------------ mock (browser preview)
  function createMockBackend() {
    const now = Date.now() / 1000;
    const mk = (name, extra = {}) => ({
      name, path: `C:\\Source Codes\\${name}`, isRoot: false, group: null, branch: "main", upstream: "origin/main",
      ahead: 0, behind: 0, changes: 0, detached: false, description: "", hasReadme: true,
      lastCommit: { hash: Math.random().toString(16).slice(2, 9), subject: "Small fixes", author: "dev", time: now - 3600 * 30 },
      remoteUrl: `git@site.example:team/${name.toLowerCase()}.git`, error: null, ...extra,
    });
    const repos = [
      mk("Source Codes", { isRoot: true, path: "C:\\Source Codes", description: "The main repo that holds every project." }),
      mk("Lorem", { description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Every module of the app uses this library: data models, settings and logging live here.\n\nVersion 2 brought a plugin system; the old APIs stay until the next major version.\n\n• Light, no dependencies\n• Windows and Linux", behind: 3 }),
      mk("Ipsum", { description: "REST API server and database migrations.", branch: "develop", upstream: "origin/develop", changes: 2 }),
      mk("Et", { description: "UI components for the desktop client.", ahead: 1 }),
      mk("Tu", { description: "", lastCommit: { hash: "a1b2c3d", subject: "Initial commit", author: "dev", time: now - 86400 * 40 } }),
      mk("tools/Variat", { group: "tools", path: "C:\\Source Codes\\tools\\Variat", description: "Build scripts, CI configuration and helpers.", behind: 12 }),
      mk("Por", { description: "Documentation site (static).", upstream: null }),
    ];
    let settings = { ...DEFAULT_SETTINGS };
    const params = new URLSearchParams(location.search);
    if (params.get("lang")) settings.language = params.get("lang");
    if (params.get("depth")) settings.scanDepth = Number(params.get("depth"));
    // Headless screenshots: CSS transitions run on wall-clock time, so finish them at once.
    if (params.has("shot")) {
      const st = document.createElement("style");
      st.textContent = "*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}.orb{animation:none!important}";
      document.head.appendChild(st);
    }
    if (params.get("settings")) {
      setTimeout(() => { state.settingsTab = params.get("settings"); openSettings(); }, 1200);
    }
    const handlers = {};
    const emit = (ev, p) => (handlers[ev] || []).forEach((h) => h(p));
    const api = {
      app_info: () => ({ version: "0.3.0", build: "31abcf", channel: "alpha", installed: true, repoUrl: "https://github.com/zearkreast/repo-manager" }),
      get_settings: () => ({ ...settings }),
      set_settings: ({ settings: s }) => (settings = { ...settings, ...s }),
      set_ui_lang: () => null,
      check_update: async () => { await sleep(700); return { version: "0.3.1", currentVersion: "0.3.0", notes: null, date: null }; },
      install_update: async () => {
        for (let d = 0; d <= 10; d++) { await sleep(180); emit("update-progress", { downloaded: d * 100, total: 1000 }); }
        throw new Error("mock: restart skipped");
      },
      get_roots: () => ({ roots: [{ path: "C:\\Source Codes", name: "Source Codes", exists: true }, { path: "D:\\Projects", name: "Projects", exists: true }], lastRoot: "C:\\Source Codes" }),
      set_last_root: () => null,
      scan_root: async ({ path }) => {
        await sleep(450);
        const list = settings.scanDepth > 1 ? repos : repos.filter((r) => !r.group);
        return path.startsWith("D") ? list.slice(1, 3).map((r) => ({ ...r, path: r.path.replace("C:\\Source Codes", "D:\\Projects") })) : list;
      },
      pull: async ({ path }) => {
        await sleep(900);
        const r = repos.find((x) => x.path === path) || repos[0];
        if (r.name === "Por") return { status: "error", commits: 0, message: "This branch has no upstream", repo: r };
        const n = r.behind; r.behind = 0;
        return n ? { status: "updated", commits: n, message: `Pulled ${n} new commits`, repo: { ...r } } : { status: "uptodate", commits: 0, message: "Already up to date", repo: { ...r } };
      },
      pull_all: async ({ repos: list }) => {
        const s = { updated: 0, uptodate: 0, failed: 0 };
        await Promise.all(list.map(async ([p], i) => { await sleep(300 + i * 220); const res = await api.pull({ path: p }); s[res.status === "error" ? "failed" : res.status]++; emit("pull-progress", res); }));
        return s;
      },
      fetch: async ({ path }) => { await sleep(300); return { ...repos.find((x) => x.path === path) }; },
      list_branches: async () => { await sleep(150); return { current: "main", local: ["main", "develop"], remote: ["origin/feature/new-theme", "origin/release-0.2"] }; },
      checkout: async ({ path, branch }) => { const r = repos.find((x) => x.path === path); r.branch = branch.replace(/^origin\//, ""); return { ...r }; },
      read_readme: async () => "# Lorem\n\nLorem ipsum dolor sit amet, **consectetur** adipiscing elit. Install with `npm i lorem`.\n\n## Setup\n\n```bash\ngit clone git@site.example:team/lorem.git\ncd lorem\n```\n\n- Fast\n- Light\n- [Docs](https://site.example)\n\n> Note: this is an alpha.",
      clone_repo: async ({ url, id }) => {
        for (const [ph, n] of [["Counting objects", 100], ["Receiving objects", 30], ["Receiving objects", 70], ["Receiving objects", 100], ["Resolving deltas", 100]]) { await sleep(300); emit("clone-progress", { id, phase: ph, percent: n }); }
        const name = url.replace(/\.git$/, "").split(/[/:]/).pop();
        const r = mk(name, { description: "A freshly cloned repo." }); repos.push(r); return r;
      },
      pick_root: async () => null,
      add_root: () => api.get_roots(),
      remove_root: () => api.get_roots(),
      open_folder: () => null, open_terminal: () => null, open_editor: () => null, open_remote: () => null,
    };
    return {
      invoke: async (cmd, args) => { const f = api[cmd]; if (!f) throw new Error(`mock: ${cmd}`); return f(args || {}); },
      listen: async (ev, cb) => { (handlers[ev] ||= []).push(cb); return () => { handlers[ev] = handlers[ev].filter((h) => h !== cb); }; },
      win: { minimize() {}, toggleMaximize() {}, close() {}, show: async () => {} },
    };
  }
})();
