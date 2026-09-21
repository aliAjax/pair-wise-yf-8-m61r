const storageKey = "zfl17-film-strip-desk";

const fallbackThumbs = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];

const maxUndoSteps = 20;

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeSegment(partial) {
  return {
    id: uid(),
    code: "",
    duration: 0,
    shift: "正常",
    damage: "完好",
    note: "",
    thumb: "",
    ...partial
  };
}

function makeReel(number, segments) {
  return { id: uid(), number: String(number || ""), segments: Array.isArray(segments) ? segments : [] };
}

function makePackage(name, reels) {
  return {
    id: uid(),
    name: name || "未命名放映包",
    reels: reels && reels.length ? reels : [makeReel("A卷")],
    undo: []
  };
}

function defaultPackages() {
  return [
    makePackage("春日试映包", [
      makeReel("A卷", [
        makeSegment({
          code: "A-001",
          duration: 18,
          shift: "正常",
          damage: "完好",
          note: "开场街景，节奏平稳，适合保留原顺序。"
        }),
        makeSegment({
          code: "A-006",
          duration: 9,
          shift: "偏红",
          damage: "轻微划痕",
          note: "人物近景左侧有划痕，试映时留意是否明显。"
        }),
        makeSegment({
          code: "A-012",
          duration: 14,
          shift: "褪色",
          damage: "接片松动",
          note: "接片位置靠近段尾，放映前建议重新压平。"
        })
      ]),
      makeReel("B卷", [
        makeSegment({
          code: "B-001",
          duration: 12,
          shift: "正常",
          damage: "需跳过",
          note: "片头定位孔段，放映时跳过。"
        })
      ])
    ])
  ];
}

function defaultFilters() {
  return { color: "all", damage: "all", keyword: "" };
}

/* ---------- 纯逻辑：迁移、校验、拆卷、合并、撤销 ---------- */

function migrateLegacy(raw) {
  // 旧版单卷数据 { reelTitle, segments }：首次打开自动迁移为单卷放映包
  const segments = (raw.segments || []).map((item) => ({
    id: item.id || uid(),
    code: String(item.code ?? ""),
    duration: Number(item.duration) || 0,
    shift: item.shift || "正常",
    damage: item.damage || "完好",
    note: item.note || "",
    thumb: item.thumb || ""
  }));
  const pkg = makePackage("默认放映包", [makeReel(raw.reelTitle || "A卷", segments)]);
  return {
    version: 2,
    packages: [pkg],
    currentPackageId: pkg.id,
    filters: defaultFilters()
  };
}

function normalizeData(raw) {
  if (!raw || typeof raw !== "object") {
    return { version: 2, packages: defaultPackages(), currentPackageId: null, filters: defaultFilters() };
  }
  if (!Array.isArray(raw.packages)) {
    // 旧单卷结构首次打开自动迁移
    return migrateLegacy(raw);
  }
  const packages = raw.packages.map((pkg) => ({
    id: pkg.id || uid(),
    name: pkg.name || "未命名放映包",
    reels: (pkg.reels || []).map((reel) => ({
      id: reel.id || uid(),
      number: String(reel.number ?? ""),
      segments: (reel.segments || []).map((item) => ({
        id: item.id || uid(),
        code: String(item.code ?? ""),
        duration: Number(item.duration) || 0,
        shift: item.shift || "正常",
        damage: item.damage || "完好",
        note: item.note || "",
        thumb: item.thumb || ""
      }))
    })),
    undo: Array.isArray(pkg.undo) ? pkg.undo : []
  }));
  if (!packages.length) packages.push(makePackage("默认放映包"));
  let currentPackageId = raw.currentPackageId;
  if (!currentPackageId || !packages.some((pkg) => pkg.id === currentPackageId)) {
    currentPackageId = packages[0].id;
  }
  return {
    version: 2,
    packages,
    currentPackageId,
    filters: { ...defaultFilters(), ...(raw.filters || {}) }
  };
}

// 检查一组片段：编号重复、时长为零、需跳过却没有备注
function inspectSegments(segments) {
  const seen = new Set();
  for (const item of segments) {
    const code = String(item.code ?? "").trim();
    if (seen.has(code)) return { ok: false, reason: `片段编号重复：${code || "（空编号）"}` };
    seen.add(code);
    if (!(Number(item.duration) > 0)) {
      return { ok: false, reason: `片段「${code || "未编号"}」时长为零，拒绝本次操作` };
    }
    if (item.damage === "需跳过" && !String(item.note ?? "").trim()) {
      return { ok: false, reason: `片段「${code || "未编号"}」标记为需跳过但缺少备注，拒绝本次操作` };
    }
  }
  return { ok: true };
}

function reelDuration(reel) {
  return reel.segments.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
}

// splitAt：在第 splitAt 段与下一段之间拆卷（1-based，splitAt 范围 1..length-1）
function splitReel(pkg, reelId, splitAt, newNumber) {
  const reelIndex = pkg.reels.findIndex((reel) => reel.id === reelId);
  const reel = pkg.reels[reelIndex];
  if (!reel) return { ok: false, reason: "找不到该片卷" };
  if (!Number.isInteger(splitAt) || splitAt < 1 || splitAt >= reel.segments.length) {
    return { ok: false, reason: "只能在相邻片段之间拆卷" };
  }
  const number = String(newNumber ?? "").trim();
  if (!number) return { ok: false, reason: "右卷必须填写新卷号" };
  if (pkg.reels.some((item) => String(item.number).trim() === number)) {
    return { ok: false, reason: `卷号「${number}」与已有片卷重复，拒绝拆卷` };
  }
  const left = reel.segments.slice(0, splitAt);
  const right = reel.segments.slice(splitAt);
  for (const part of [left, right]) {
    const check = inspectSegments(part);
    if (!check.ok) return check;
  }

  pushUndo(pkg);
  // 左卷守住原编号；右卷领取新编号，插在左卷紧后，卷序其余不变
  const rightReel = makeReel(number, right);
  reel.segments = left;
  pkg.reels.splice(reelIndex + 1, 0, rightReel);
  return { ok: true, newReelId: rightReel.id };
}

// 仅允许相邻卷合并，合并后保留左卷编号
function mergeAdjacentReels(pkg, leftReelId, rightReelId) {
  const leftIndex = pkg.reels.findIndex((reel) => reel.id === leftReelId);
  const rightIndex = pkg.reels.findIndex((reel) => reel.id === rightReelId);
  if (leftIndex < 0 || rightIndex < 0) return { ok: false, reason: "找不到要合并的片卷" };
  if (rightIndex !== leftIndex + 1) {
    return { ok: false, reason: "只能合并相邻的两卷" };
  }
  const left = pkg.reels[leftIndex];
  const right = pkg.reels[rightIndex];
  const combined = [...left.segments, ...right.segments];
  const check = inspectSegments(combined);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (reelDuration(left) <= 0 || reelDuration(right) <= 0) {
    return { ok: false, reason: "时长为零的空卷不能合并" };
  }

  pushUndo(pkg);
  left.segments = combined;
  pkg.reels.splice(rightIndex, 1);
  return { ok: true };
}

function pushUndo(pkg) {
  pkg.undo.push(serializeReels(pkg.reels));
  if (pkg.undo.length > maxUndoSteps) pkg.undo.shift();
}

function undoLast(pkg) {
  if (!pkg.undo || !pkg.undo.length) return false;
  const snapshot = pkg.undo.pop();
  pkg.reels = deserializeReels(snapshot);
  return true;
}

function serializeReels(reels) {
  return JSON.stringify(reels.map((reel) => ({
    id: reel.id,
    number: reel.number,
    segments: reel.segments.map((item) => ({ ...item }))
  })));
}

function deserializeReels(snapshot) {
  return JSON.parse(snapshot).map((reel) => ({
    id: reel.id,
    number: reel.number,
    segments: reel.segments
  }));
}

function suggestReelNumber(pkg) {
  const used = new Set(pkg.reels.map((reel) => reel.number.trim()));
  for (const code of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const candidate = `${code}卷`;
    if (!used.has(candidate)) return candidate;
  }
  let n = 1;
  while (used.has(`新卷${n}`)) n += 1;
  return `新卷${n}`;
}

/* ---------- 以下为浏览器界面层，Node 测试时不执行 ---------- */

function init() {
  let data = loadData();
  let dragged = null;

  const els = {
    packageSelect: document.querySelector("#packageSelect"),
    newPackageBtn: document.querySelector("#newPackageBtn"),
    renamePackageBtn: document.querySelector("#renamePackageBtn"),
    deletePackageBtn: document.querySelector("#deletePackageBtn"),
    undoBtn: document.querySelector("#undoBtn"),
    colorFilter: document.querySelector("#colorFilter"),
    damageFilter: document.querySelector("#damageFilter"),
    searchInput: document.querySelector("#searchInput"),
    exportBtn: document.querySelector("#exportBtn"),
    targetReel: document.querySelector("#targetReel"),
    newReelBtn: document.querySelector("#newReelBtn"),
    segmentForm: document.querySelector("#segmentForm"),
    codeInput: document.querySelector("#codeInput"),
    durationInput: document.querySelector("#durationInput"),
    shiftInput: document.querySelector("#shiftInput"),
    damageInput: document.querySelector("#damageInput"),
    thumbInput: document.querySelector("#thumbInput"),
    noteInput: document.querySelector("#noteInput"),
    reelList: document.querySelector("#reelList"),
    listTitle: document.querySelector("#listTitle"),
    listHint: document.querySelector("#listHint"),
    warningList: document.querySelector("#warningList"),
    totalDuration: document.querySelector("#totalDuration"),
    reelCount: document.querySelector("#reelCount"),
    damageCount: document.querySelector("#damageCount"),
    segmentCount: document.querySelector("#segmentCount"),
    modalBackdrop: document.querySelector("#modalBackdrop"),
    modalTitle: document.querySelector("#modalTitle"),
    modalMessage: document.querySelector("#modalMessage"),
    modalInput: document.querySelector("#modalInput"),
    modalCancel: document.querySelector("#modalCancel"),
    modalOk: document.querySelector("#modalOk"),
    toast: document.querySelector("#toast")
  };

  function loadData() {
    const saved = localStorage.getItem(storageKey);
    if (!saved) {
      const fresh = { version: 2, packages: defaultPackages(), currentPackageId: null, filters: defaultFilters() };
      fresh.currentPackageId = fresh.packages[0].id;
      return fresh;
    }
    let parsed;
    try {
      parsed = JSON.parse(saved);
    } catch {
      const fresh = { version: 2, packages: defaultPackages(), currentPackageId: null, filters: defaultFilters() };
      fresh.currentPackageId = fresh.packages[0].id;
      return fresh;
    }
    // 旧单卷数据首次打开自动迁移
    const normalized = normalizeData(parsed);
    return normalized;
  }

  function save() {
    localStorage.setItem(storageKey, JSON.stringify(data));
  }

  const currentPkg = () => data.packages.find((pkg) => pkg.id === data.currentPackageId) || data.packages[0];

  function allSegments(pkg) {
    return pkg.reels.flatMap((reel) => reel.segments);
  }

  function isFiltering() {
    return data.filters.color !== "all" || data.filters.damage !== "all" || data.filters.keyword.trim() !== "";
  }

  /* ---------- 渲染 ---------- */

  function renderPackagePicker() {
    els.packageSelect.innerHTML = data.packages
      .map((pkg) => `<option value="${pkg.id}" ${pkg.id === currentPkg().id ? "selected" : ""}>${escapeHtml(pkg.name)}</option>`)
      .join("");
  }

  function renderTargetReel() {
    const pkg = currentPkg();
    els.targetReel.innerHTML = pkg.reels
      .map((reel, index) => `<option value="${reel.id}">${index + 1}. ${escapeHtml(reel.number || "未命名卷")}</option>`)
      .join("");
  }

  function renderFilters() {
    els.colorFilter.value = data.filters.color;
    els.damageFilter.value = data.filters.damage;
    els.searchInput.value = data.filters.keyword;
  }

  function renderStats() {
    const segments = allSegments(currentPkg());
    const total = segments.reduce((sum, item) => sum + Number(item.duration), 0);
    els.totalDuration.textContent = formatDuration(total);
    els.reelCount.textContent = currentPkg().reels.length;
    els.damageCount.textContent = segments.filter((item) => item.damage !== "完好").length;
    els.segmentCount.textContent = segments.length;
  }

  function segmentMatches(item) {
    const { color, damage, keyword } = data.filters;
    const matchesColor = color === "all" || item.shift === color;
    const matchesDamage = damage === "all" || item.damage === damage;
    const matchesKeyword = !keyword || `${item.code}${item.note}${item.damage}`.includes(keyword);
    return matchesColor && matchesDamage && matchesKeyword;
  }

  function renderReels() {
    const pkg = currentPkg();
    const filtering = isFiltering();
    if (filtering) {
      els.listTitle.textContent = `${escapeHtml(pkg.name)}·筛选结果`;
      els.listHint.textContent = "筛选中已隐藏拆卷/合并控件";
    } else {
      els.listTitle.textContent = `${pkg.name}·放映顺序`;
      els.listHint.textContent = "点接缝处拆卷，点卷间条合并；拖拽片段调整同卷顺序";
    }

    els.reelList.innerHTML = pkg.reels
      .map((reel, reelIndex) => {
        const cards = reel.segments
          .map((item, segIndex) => {
            const realIndex = allSegments(pkg).findIndex((segment) => segment.id === item.id);
            if (filtering && !segmentMatches(item)) return "";
            const hasDamage = item.damage !== "完好";
            return `
              <div class="seg-slot">
                <article class="segment-card" draggable="true" data-id="${item.id}" data-reel-id="${reel.id}">
                  <div class="thumb">
                    ${
                      item.thumb
                        ? `<img src="${item.thumb}" alt="${escapeHtml(item.code)}缩略图" />`
                        : `<div class="film-placeholder" style="background:${fallbackThumbs[realIndex % fallbackThumbs.length]}">${escapeHtml(item.code)}</div>`
                    }
                  </div>
                  <div class="segment-main">
                    <div class="segment-title">
                      <strong>${realIndex + 1}. ${escapeHtml(item.code)}</strong>
                      <span>${formatDuration(item.duration)}</span>
                    </div>
                    <div class="tag-row">
                      <span class="tag">${escapeHtml(item.shift)}</span>
                      <span class="tag ${hasDamage ? "damage" : "ok"}">${escapeHtml(item.damage)}</span>
                    </div>
                    <p class="segment-note">${escapeHtml(item.note || "没有备注。")}</p>
                  </div>
                  <div class="segment-actions">
                    <button type="button" title="上移" data-move-up="${item.id}">↑</button>
                    <button type="button" title="下移" data-move-down="${item.id}">↓</button>
                    <button type="button" title="删除" data-delete="${item.id}">×</button>
                  </div>
                </article>
              </div>
              ${
                !filtering && segIndex < reel.segments.length - 1
                  ? `<button type="button" class="split-seam" data-reel-id="${reel.id}" data-split-at="${segIndex + 1}" title="在此拆卷：左卷保留${escapeHtml(reel.number || "本卷")}编号">✂ 在此拆卷（${escapeHtml(reel.number || "本卷")} → 新卷）</button>`
                  : ""
              }
            `;
          })
          .join("");

        const visibleEmpty = reel.segments.length === 0
          ? `<p class="empty">空卷（时长为零，不能用于合并）。</p>`
          : filtering && cards.trim() === ""
            ? `<p class="empty">本卷没有符合筛选的片段。</p>`
            : "";

        return `
          <section class="reel-block">
            <header class="reel-head">
              <div>
                <span class="reel-badge">第 ${reelIndex + 1} 卷</span>
                <strong class="reel-number">${escapeHtml(reel.number || "未命名卷")}</strong>
                <span class="reel-meta">${reel.segments.length} 段 · ${formatDuration(reelDuration(reel))}</span>
              </div>
              <button type="button" class="ghost small" data-rename-reel="${reel.id}">改卷号</button>
            </header>
            <div class="segment-list">${cards || visibleEmpty}</div>
          </section>
          ${
            !filtering && reelIndex < pkg.reels.length - 1
              ? `<button type="button" class="merge-seam" data-left-reel="${reel.id}" data-right-reel="${pkg.reels[reelIndex + 1].id}">⇠ 与下一卷「${escapeHtml(pkg.reels[reelIndex + 1].number || "未命名卷")}」合并（保留本卷号${escapeHtml(reel.number || "")}）</button>`
              : ""
          }
        `;
      })
      .join("");

    els.undoBtn.disabled = pkg.undo.length === 0;
    els.undoBtn.title = pkg.undo.length ? `撤销最近一次拆卷/合并（剩余 ${pkg.undo.length} 步）` : "没有可撤销的拆卷/合并";
  }

  function renderWarnings() {
    const pkg = currentPkg();
    const warnings = [];
    pkg.reels.forEach((reel) => {
      reel.segments.forEach((item) => {
        if (item.damage !== "完好" || item.shift !== "正常") {
          const reasons = [item.shift !== "正常" ? item.shift : "", item.damage !== "完好" ? item.damage : ""].filter(Boolean).join(" · ");
          warnings.push({ reel, item, reasons });
        }
      });
    });
    els.warningList.innerHTML =
      warnings
        .map(({ reel, item, reasons }) => {
          const index = reel.segments.findIndex((segment) => segment.id === item.id) + 1;
          return `
            <div class="warning-item">
              <strong>${escapeHtml(reel.number || "未命名卷")} · ${index}. ${escapeHtml(item.code)}</strong>
              <span>${escapeHtml(reasons)}${item.note ? `：${escapeHtml(item.note)}` : ""}</span>
            </div>
          `;
        })
        .join("") || `<p class="empty">当前放映包没有颜色偏移或破损提醒。</p>`;
  }

  function renderAll() {
    if (!data.packages.some((pkg) => pkg.id === data.currentPackageId)) {
      data.currentPackageId = data.packages[0].id;
    }
    save();
    renderPackagePicker();
    renderTargetReel();
    renderFilters();
    renderStats();
    renderReels();
    renderWarnings();
  }

  /* ---------- 通用：弹窗、提示 ---------- */

  let modalResolver = null;
  function openPrompt({ title, message = "", value = "", okText = "确定" }) {
    return new Promise((resolve) => {
      els.modalTitle.textContent = title;
      els.modalMessage.textContent = message;
      els.modalInput.value = value;
      els.modalOk.textContent = okText;
      els.modalBackdrop.hidden = false;
      els.modalInput.focus();
      els.modalInput.select();
      modalResolver = resolve;
    });
  }
  function closePrompt(result) {
    els.modalBackdrop.hidden = true;
    if (modalResolver) modalResolver(result);
    modalResolver = null;
  }

  function openConfirm({ title, message, okText = "确定" }) {
    els.modalTitle.textContent = title;
    els.modalMessage.textContent = message;
    els.modalInput.style.display = "none";
    els.modalOk.textContent = okText;
    els.modalBackdrop.hidden = false;
    return new Promise((resolve) => {
      modalResolver = resolve;
    }).then((result) => {
      els.modalInput.style.display = "";
      return result;
    });
  }

  let toastTimer = null;
  function toast(message, ok) {
    els.toast.textContent = message;
    els.toast.className = `toast ${ok ? "ok" : "err"}`;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 3200);
  }

  /* ---------- 操作 ---------- */

  async function handleSplit(reelId, splitAt) {
    const pkg = currentPkg();
    const reel = pkg.reels.find((item) => item.id === reelId);
    if (!reel) return;
    const value = await openPrompt({
      title: `在「${reel.number || "未命名卷"}」第 ${splitAt} 段之后拆卷`,
      message: "左卷保留原编号，请为右卷填写新卷号：",
      value: suggestReelNumber(pkg),
      okText: "拆卷"
    });
    if (value === null) return;
    const result = splitReel(pkg, reelId, splitAt, value);
    if (!result.ok) {
      toast(`已拒绝拆卷：${result.reason}`, false);
      return;
    }
    toast(`已拆出右卷「${value.trim()}」，左卷保持「${reel.number}」编号`, true);
    renderAll();
  }

  async function handleMerge(leftReelId, rightReelId) {
    const pkg = currentPkg();
    const left = pkg.reels.find((item) => item.id === leftReelId);
    const right = pkg.reels.find((item) => item.id === rightReelId);
    if (!left || !right) return;
    const confirmed = await openConfirm({
      title: "合并相邻片卷",
      message: `将「${right.number || "未命名卷"}」并入「${left.number || "未命名卷"}」，合并后保留「${left.number || "左卷"}」编号，卷序不变。是否继续？`,
      okText: "合并"
    });
    if (!confirmed) return;
    const result = mergeAdjacentReels(pkg, leftReelId, rightReelId);
    if (!result.ok) {
      toast(`已拒绝合并：${result.reason}`, false);
      return;
    }
    toast(`已合并，继续使用左卷号「${left.number}」`, true);
    renderAll();
  }

  function handleUndo() {
    const pkg = currentPkg();
    if (!undoLast(pkg)) {
      toast("没有可撤销的拆卷/合并", false);
      return;
    }
    toast("已撤销最近一次拆卷/合并，片段、卷号与顺序已恢复", true);
    renderAll();
  }

  async function addSegment(event) {
    event.preventDefault();
    const pkg = currentPkg();
    const reel = pkg.reels.find((item) => item.id === els.targetReel.value) || pkg.reels[0];
    if (!reel) {
      toast("请先新增一个片卷", false);
      return;
    }
    const thumb = await readFileAsDataUrl(els.thumbInput.files[0]);
    reel.segments.push(
      makeSegment({
        code: els.codeInput.value.trim(),
        duration: Number(els.durationInput.value),
        shift: els.shiftInput.value,
        damage: els.damageInput.value,
        note: els.noteInput.value.trim(),
        thumb
      })
    );
    els.segmentForm.reset();
    els.durationInput.value = 12;
    renderAll();
  }

  function locateSegment(id) {
    const pkg = currentPkg();
    for (const reel of pkg.reels) {
      const index = reel.segments.findIndex((item) => item.id === id);
      if (index >= 0) return { reel, index };
    }
    return null;
  }

  function moveSegment(id, direction) {
    const located = locateSegment(id);
    if (!located) return;
    const { reel, index } = located;
    const target = index + direction;
    if (target < 0 || target >= reel.segments.length) return;
    const [item] = reel.segments.splice(index, 1);
    reel.segments.splice(target, 0, item);
    renderAll();
  }

  async function renameReel(reelId) {
    const pkg = currentPkg();
    const reel = pkg.reels.find((item) => item.id === reelId);
    if (!reel) return;
    const value = await openPrompt({ title: "修改卷号", message: "", value: reel.number, okText: "保存" });
    if (value === null) return;
    const number = value.trim();
    if (!number) {
      toast("卷号不能为空", false);
      return;
    }
    if (pkg.reels.some((item) => item.id !== reelId && item.number.trim() === number)) {
      toast(`卷号「${number}」已存在，未修改`, false);
      return;
    }
    reel.number = number;
    renderAll();
  }

  async function addReel() {
    const pkg = currentPkg();
    const value = await openPrompt({ title: "新增片卷", message: "新卷将排在放映包末尾：", value: suggestReelNumber(pkg), okText: "新增" });
    if (value === null) return;
    const number = value.trim();
    if (!number) {
      toast("卷号不能为空", false);
      return;
    }
    if (pkg.reels.some((item) => item.number.trim() === number)) {
      toast(`卷号「${number}」已存在，未新增`, false);
      return;
    }
    pkg.reels.push(makeReel(number));
    renderAll();
  }

  async function addPackage() {
    const value = await openPrompt({ title: "新建放映包", message: "", value: "", okText: "新建" });
    if (value === null) return;
    const name = value.trim() || "未命名放映包";
    const pkg = makePackage(name, [makeReel(suggestReelNumber({ reels: [] }))]);
    data.packages.push(pkg);
    data.currentPackageId = pkg.id;
    renderAll();
  }

  async function renamePackage() {
    const pkg = currentPkg();
    const value = await openPrompt({ title: "放映包改名", message: "", value: pkg.name, okText: "保存" });
    if (value === null) return;
    const name = value.trim();
    if (!name) {
      toast("放映包名称不能为空", false);
      return;
    }
    pkg.name = name;
    renderAll();
  }

  async function deletePackage() {
    if (data.packages.length <= 1) {
      toast("至少保留一个放映包", false);
      return;
    }
    const pkg = currentPkg();
    const confirmed = await openConfirm({
      title: "删除放映包",
      message: `确定删除「${pkg.name}」及其全部片卷与片段？删除后无法恢复。`,
      okText: "删除"
    });
    if (!confirmed) return;
    data.packages = data.packages.filter((item) => item.id !== pkg.id);
    data.currentPackageId = data.packages[0].id;
    renderAll();
  }

  function switchPackage(packageId) {
    if (!data.packages.some((pkg) => pkg.id === packageId)) return;
    data.currentPackageId = packageId;
    // 切换放映包：统计、筛选、提醒、导出全部随当前包同步重渲染
    renderAll();
  }

  function exportList() {
    const pkg = currentPkg();
    const lines = [`放映包：${pkg.name}`];
    pkg.reels.forEach((reel, reelIndex) => {
      lines.push("");
      lines.push(`【第 ${reelIndex + 1} 卷 · ${reel.number || "未命名卷"}】共 ${reel.segments.length} 段，时长 ${formatDuration(reelDuration(reel))}`);
      reel.segments.forEach((item, index) => {
        lines.push(
          `${index + 1}. ${item.code}｜${formatDuration(item.duration)}｜${item.shift}｜${item.damage}｜${item.note || "无备注"}`
        );
      });
    });
    lines.push("");
    lines.push(`总时长：${formatDuration(allSegments(pkg).reduce((sum, item) => sum + Number(item.duration), 0))}`);
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${(pkg.name || "film-package").replace(/[\\/:*?"<>|]/g, "_")}-checklist.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  /* ---------- 事件绑定 ---------- */

  els.packageSelect.addEventListener("change", () => switchPackage(els.packageSelect.value));
  els.newPackageBtn.addEventListener("click", addPackage);
  els.renamePackageBtn.addEventListener("click", renamePackage);
  els.deletePackageBtn.addEventListener("click", deletePackage);
  els.undoBtn.addEventListener("click", handleUndo);
  els.newReelBtn.addEventListener("click", addReel);
  els.segmentForm.addEventListener("submit", addSegment);
  els.exportBtn.addEventListener("click", exportList);

  els.colorFilter.addEventListener("change", () => {
    data.filters.color = els.colorFilter.value;
    save();
    renderStats();
    renderReels();
  });
  els.damageFilter.addEventListener("change", () => {
    data.filters.damage = els.damageFilter.value;
    save();
    renderStats();
    renderReels();
  });
  els.searchInput.addEventListener("input", () => {
    data.filters.keyword = els.searchInput.value;
    save();
    renderReels();
  });

  els.modalCancel.addEventListener("click", () => closePrompt(null));
  els.modalOk.addEventListener("click", () => closePrompt(els.modalInput.style.display === "none" ? true : els.modalInput.value));
  els.modalBackdrop.addEventListener("click", (event) => {
    if (event.target === els.modalBackdrop) closePrompt(null);
  });
  els.modalInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") closePrompt(els.modalInput.value);
    if (event.key === "Escape") closePrompt(null);
  });

  els.reelList.addEventListener("click", (event) => {
    const splitBtn = event.target.closest("[data-split-at]");
    if (splitBtn) {
      handleSplit(splitBtn.dataset.reelId, Number(splitBtn.dataset.splitAt));
      return;
    }
    const mergeBtn = event.target.closest("[data-left-reel]");
    if (mergeBtn) {
      handleMerge(mergeBtn.dataset.leftReel, mergeBtn.dataset.rightReel);
      return;
    }
    const renameReelBtn = event.target.closest("[data-rename-reel]");
    if (renameReelBtn) {
      renameReel(renameReelBtn.dataset.renameReel);
      return;
    }
    const up = event.target.closest("[data-move-up]");
    const down = event.target.closest("[data-move-down]");
    const remove = event.target.closest("[data-delete]");
    if (up) moveSegment(up.dataset.moveUp, -1);
    if (down) moveSegment(down.dataset.moveDown, 1);
    if (remove) {
      const located = locateSegment(remove.dataset.delete);
      if (located) {
        located.reel.segments.splice(located.index, 1);
        renderAll();
      }
    }
  });

  els.reelList.addEventListener("dragstart", (event) => {
    const card = event.target.closest("[data-id]");
    if (!card) return;
    dragged = { id: card.dataset.id, reelId: card.dataset.reelId };
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });

  els.reelList.addEventListener("dragend", (event) => {
    event.target.closest("[data-id]")?.classList.remove("dragging");
    dragged = null;
  });

  els.reelList.addEventListener("dragover", (event) => {
    const card = event.target.closest("[data-id]");
    if (!card || !dragged || card.dataset.id === dragged.id) return;
    // 只允许同卷内拖拽，跨卷拖动不改卷序
    if (card.dataset.reelId !== dragged.reelId) return;
    event.preventDefault();
    const located = locateSegment(dragged.id);
    const reel = located?.reel;
    if (!reel) return;
    const fromIndex = reel.segments.findIndex((item) => item.id === dragged.id);
    const toIndex = reel.segments.findIndex((item) => item.id === card.dataset.id);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    const [item] = reel.segments.splice(fromIndex, 1);
    reel.segments.splice(toIndex, 0, item);
    renderAll();
  });

  renderAll();
}

/* ---------- 共用工具 ---------- */

function formatDuration(seconds) {
  const value = Number(seconds) || 0;
  const minutes = Math.floor(value / 60);
  const rest = String(value % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    uid,
    makeSegment,
    makeReel,
    makePackage,
    defaultPackages,
    defaultFilters,
    migrateLegacy,
    normalizeData,
    inspectSegments,
    reelDuration,
    splitReel,
    mergeAdjacentReels,
    undoLast,
    suggestReelNumber,
    serializeReels
  };
}
