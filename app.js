const storageKey = "zfl17-film-strip-desk";
const storageVersion = 2;

const fallbackThumbs = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];
const undoLimit = 100;

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sampleSegment(code, duration, shift, damage, note) {
  return { id: makeId(), code, duration, shift, damage, note, thumb: "" };
}

function defaultReels() {
  return [
    {
      number: "A",
      segments: [
        sampleSegment("A-001", 18, "正常", "完好", "开场街景，节奏平稳，适合保留原顺序。"),
        sampleSegment("A-006", 9, "偏红", "轻微划痕", "人物近景左侧有划痕，试映时留意是否明显。"),
        sampleSegment("A-012", 14, "褪色", "接片松动", "接片位置靠近段尾，放映前建议重新压平。")
      ]
    }
  ];
}

function defaultState() {
  return {
    version: storageVersion,
    activePackageId: null,
    packages: [
      {
        id: makeId(),
        title: "春日试映放映包",
        reels: defaultReels()
      }
    ]
  };
}

/* ---------- 加载与旧单卷数据迁移 ---------- */

function loadState() {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    const fresh = defaultState();
    fresh.activePackageId = fresh.packages[0].id;
    return { state: fresh, migrated: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const fresh = defaultState();
    fresh.activePackageId = fresh.packages[0].id;
    return { state: fresh, migrated: false };
  }

  // 旧版单卷结构：{ reelTitle, segments }
  const isLegacy = parsed && !Array.isArray(parsed.packages) && Array.isArray(parsed.segments);
  if (isLegacy) {
    const migrated = {
      version: storageVersion,
      activePackageId: null,
      packages: [
        {
          id: makeId(),
          title: parsed.reelTitle ? `${parsed.reelTitle}放映包` : "旧版迁移放映包",
          reels: [
            {
              number: "A",
              segments: normalizeSegments(parsed.segments)
            }
          ]
        }
      ]
    };
    migrated.activePackageId = migrated.packages[0].id;
    return { state: migrated, migrated: true };
  }

  const state = normalizeState(parsed);
  return { state, migrated: false };
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.map((item) => ({
    id: item && item.id ? String(item.id) : makeId(),
    code: item && item.code != null ? String(item.code) : "",
    duration: item && Number.isFinite(Number(item.duration)) ? Number(item.duration) : 0,
    shift: item && item.shift ? String(item.shift) : "正常",
    damage: item && item.damage ? String(item.damage) : "完好",
    note: item && item.note != null ? String(item.note) : "",
    thumb: item && item.thumb ? String(item.thumb) : ""
  }));
}

function normalizeState(input) {
  const base = defaultState();
  if (!input || !Array.isArray(input.packages) || input.packages.length === 0) {
    base.activePackageId = base.packages[0].id;
    return base;
  }

  const packages = input.packages.map((pkg, pkgIndex) => {
    let reels;
    if (Array.isArray(pkg.reels)) {
      reels = pkg.reels
        .filter((reel) => reel && Array.isArray(reel.segments))
        .map((reel, reelIndex) => ({
          number: reel.number ? String(reel.number) : numberForIndex(reelIndex),
          segments: normalizeSegments(reel.segments)
        }));
    } else if (Array.isArray(pkg.segments)) {
      // 兼容半成品结构：包下直接挂 segments
      reels = [{ number: "A", segments: normalizeSegments(pkg.segments) }];
    } else {
      reels = [];
    }
    if (reels.length === 0) reels = [{ number: "A", segments: [] }];
    return {
      id: pkg.id ? String(pkg.id) : makeId(),
      title: pkg.title ? String(pkg.title) : `放映包 ${pkgIndex + 1}`,
      reels
    };
  });

  const exists = packages.some((pkg) => pkg.id === input.activePackageId);
  const activePackageId = exists ? input.activePackageId : packages[0].id;
  return { version: storageVersion, activePackageId, packages };
}

function numberForIndex(index) {
  if (index < 26) return String.fromCharCode(65 + index);
  return `卷${index + 1}`;
}

function nextReelNumber(reels) {
  for (let index = 0; index < 26; index += 1) {
    const candidate = String.fromCharCode(65 + index);
    if (!reels.some((reel) => reel.number === candidate)) return candidate;
  }
  let extra = 27;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = `卷${extra}`;
    if (!reels.some((reel) => reel.number === candidate)) return candidate;
    extra += 1;
  }
}

/* ---------- 全局状态 ---------- */

const loaded = loadState();
let state = loaded.state;
const bootMigrated = loaded.migrated;

// 撤销栈只存在内存：每次成功拆/并压入当前包的卷快照
const undoHistory = {};
let draggedId = null;
let noticeTimer = null;

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function activePackage() {
  let pkg = state.packages.find((item) => item.id === state.activePackageId);
  if (!pkg) {
    state.activePackageId = state.packages[0].id;
    pkg = state.packages[0];
  }
  return pkg;
}

/* ---------- 校验：编号重复 / 时长为零 / 需跳过无备注 ---------- */

function findReelViolation(reel, label) {
  const scope = label || `卷${reel.number}`;
  const seen = new Set();
  for (const segment of reel.segments) {
    const code = segment.code.trim();
    if (!code) {
      return { scope, segment, reason: "存在没有编号的片段" };
    }
    if (seen.has(code)) {
      return { scope, segment, reason: `片段编号 ${code} 重复` };
    }
    seen.add(code);
    if (!Number.isFinite(Number(segment.duration)) || Number(segment.duration) <= 0) {
      return { scope, segment, reason: `片段 ${code} 时长为零或无效` };
    }
    if (segment.damage === "需跳过" && !segment.note.trim()) {
      return { scope, segment, reason: `需跳过的片段 ${code} 缺少备注` };
    }
  }
  return null;
}

/* ---------- 拆卷 / 合卷（整次拒绝 + 可撤销） ---------- */

function pushUndo(pkg) {
  const stack = undoHistory[pkg.id] || (undoHistory[pkg.id] = []);
  stack.push(structuredClone(pkg.reels));
  if (stack.length > undoLimit) stack.shift();
}

function splitReel(reelIndex, afterSegmentIndex) {
  const pkg = activePackage();
  const reel = pkg.reels[reelIndex];
  if (!reel || afterSegmentIndex < 0 || afterSegmentIndex >= reel.segments.length - 1) {
    showNotice("只能在同卷两个相邻片段之间拆卷。", "error");
    return;
  }

  // 先在“拆完之后的两卷”上整次校验，任一不通过都不动卷序与清单
  const leftSegments = reel.segments.slice(0, afterSegmentIndex + 1);
  const rightSegments = reel.segments.slice(afterSegmentIndex + 1);
  const newNumber = nextReelNumber(pkg.reels);
  const leftDraft = { number: reel.number, segments: leftSegments };
  const rightDraft = { number: newNumber, segments: rightSegments };
  const violation =
    findReelViolation(leftDraft, `卷${reel.number}`) ||
    findReelViolation(rightDraft, `新卷${newNumber}`);
  if (violation) {
    showNotice(`拆卷已整次拒绝：${violation.scope}内${violation.reason}。卷序与清单未改动。`, "error");
    return;
  }

  pushUndo(pkg);
  const leftReel = { number: reel.number, segments: structuredClone(leftSegments) };
  const rightReel = { number: newNumber, segments: structuredClone(rightSegments) };
  pkg.reels.splice(reelIndex, 1, leftReel, rightReel);
  saveState();
  renderAll();
  showNotice(`已在 ${leftSegments[leftSegments.length - 1].code} 之后拆卷：左侧保留 ${leftReel.number} 卷，右侧领取 ${rightReel.number} 卷。`, "success");
}

function mergeReel(reelIndex) {
  const pkg = activePackage();
  const left = pkg.reels[reelIndex];
  const right = pkg.reels[reelIndex + 1];
  if (!left || !right) {
    showNotice("只有相邻的两卷可以合并。", "error");
    return;
  }

  // 先在合并结果上整次校验
  const mergedDraft = {
    number: left.number,
    segments: [...left.segments, ...right.segments]
  };
  const violation = findReelViolation(mergedDraft, `${left.number}/${right.number}卷合并结果`);
  if (violation) {
    showNotice(`合并已整次拒绝：${violation.scope}内${violation.reason}。卷序与清单未改动。`, "error");
    return;
  }

  pushUndo(pkg);
  pkg.reels.splice(reelIndex, 2, {
    number: left.number,
    segments: structuredClone(mergedDraft.segments)
  });
  saveState();
  renderAll();
  showNotice(`已合并 ${left.number}、${right.number} 两卷，片段顺序不变，合并后沿用 ${left.number} 卷编号。`, "success");
}

function undoLast() {
  const pkg = activePackage();
  const stack = undoHistory[pkg.id] || [];
  if (stack.length === 0) return;
  const previous = stack.pop();
  pkg.reels = previous;
  saveState();
  renderAll();
  showNotice("已撤销上一次拆/并，片段、卷号和顺序均恢复。", "success");
}

/* ---------- 筛选 ---------- */

function reelHasVisible(reel) {
  return reel.segments.some(matchesFilters);
}

function matchesFilters(item) {
  const color = els.colorFilter.value;
  const damage = els.damageFilter.value;
  const keyword = els.searchInput.value.trim();
  const matchesColor = color === "all" || item.shift === color;
  const matchesDamage = damage === "all" || item.damage === damage;
  const matchesKeyword =
    !keyword || `${item.code}${item.note}${item.damage}${item.shift}`.includes(keyword);
  return matchesColor && matchesDamage && matchesKeyword;
}

function isFiltering() {
  return (
    els.colorFilter.value !== "all" ||
    els.damageFilter.value !== "all" ||
    els.searchInput.value.trim() !== ""
  );
}

/* ---------- 渲染 ---------- */

const els = {
  packageSelect: document.querySelector("#packageSelect"),
  newPackageBtn: document.querySelector("#newPackageBtn"),
  deletePackageBtn: document.querySelector("#deletePackageBtn"),
  packageTitle: document.querySelector("#packageTitle"),
  undoBtn: document.querySelector("#undoBtn"),
  colorFilter: document.querySelector("#colorFilter"),
  damageFilter: document.querySelector("#damageFilter"),
  searchInput: document.querySelector("#searchInput"),
  exportBtn: document.querySelector("#exportBtn"),
  notice: document.querySelector("#notice"),
  segmentForm: document.querySelector("#segmentForm"),
  reelSelect: document.querySelector("#reelSelect"),
  codeInput: document.querySelector("#codeInput"),
  durationInput: document.querySelector("#durationInput"),
  shiftInput: document.querySelector("#shiftInput"),
  damageInput: document.querySelector("#damageInput"),
  thumbInput: document.querySelector("#thumbInput"),
  noteInput: document.querySelector("#noteInput"),
  segmentList: document.querySelector("#segmentList"),
  warningList: document.querySelector("#warningList"),
  totalDuration: document.querySelector("#totalDuration"),
  reelCount: document.querySelector("#reelCount"),
  damageCount: document.querySelector("#damageCount"),
  segmentCount: document.querySelector("#segmentCount")
};

function renderStats() {
  const pkg = activePackage();
  const all = pkg.reels.flatMap((reel) => reel.segments);
  const total = all.reduce((sum, item) => sum + Number(item.duration), 0);
  const damaged = all.filter((item) => item.damage !== "完好").length;
  els.totalDuration.textContent = formatDuration(total);
  els.reelCount.textContent = pkg.reels.length;
  els.damageCount.textContent = damaged;
  els.segmentCount.textContent = all.length;
}

function renderPackageBar() {
  const pkg = activePackage();
  els.packageSelect.innerHTML = state.packages
    .map(
      (item) =>
        `<option value="${item.id}"${item.id === pkg.id ? " selected" : ""}>${escapeHtml(item.title || "未命名放映包")}</option>`
    )
    .join("");
  els.packageTitle.value = pkg.title;
  els.deletePackageBtn.disabled = state.packages.length <= 1;

  const stack = undoHistory[pkg.id] || [];
  els.undoBtn.disabled = stack.length === 0;
  els.undoBtn.textContent = stack.length ? `↶ 撤销拆/并（剩 ${stack.length} 步）` : "↶ 撤销拆/并";
}

function renderReelSelect() {
  const pkg = activePackage();
  const current = els.reelSelect.value;
  els.reelSelect.innerHTML = pkg.reels
    .map((reel) => `<option value="${reel.number}">${escapeHtml(reel.number)} 卷（${reel.segments.length} 段）</option>`)
    .join("");
  if (current && pkg.reels.some((reel) => reel.number === current)) {
    els.reelSelect.value = current;
  }
}

function renderList() {
  const pkg = activePackage();
  const filtering = isFiltering();

  const blocks = pkg.reels
    .map((reel, reelIndex) => {
      const total = reel.segments.reduce((sum, item) => sum + Number(item.duration), 0);
      const damaged = reel.segments.filter((item) => item.damage !== "完好").length;

      let body;
      if (filtering) {
        const visible = reel.segments.filter(matchesFilters);
        body = visible.length
          ? visible.map((item) => renderCard(reel, item, false)).join("")
          : `<p class="empty">本卷没有符合筛选的片段。</p>`;
      } else {
        body = reel.segments.length
          ? reel.segments
              .map((item, index) => `${renderCard(reel, item, true)}${renderSplitLine(reelIndex, index, reel.segments.length)}`)
              .join("")
          : `<p class="empty">${escapeHtml(reel.number)} 卷还是空卷，可在左侧录入片段并选择放入此卷。</p>`;
      }

      const canMerge = reelIndex < pkg.reels.length - 1 && !filtering;
      const rightNumber = canMerge ? pkg.reels[reelIndex + 1].number : "";
      return `
        <section class="reel-block">
          <header class="reel-head">
            <strong>${escapeHtml(reel.number)} 卷</strong>
            <span>${reel.segments.length} 段 · ${formatDuration(total)}${damaged ? ` · ${damaged} 处破损` : ""}</span>
            ${
              canMerge
                ? `<button type="button" class="merge-btn" data-merge="${reelIndex}">合并到 ${escapeHtml(rightNumber)} 卷 →</button>`
                : ""
            }
          </header>
          <div class="reel-cards">${body}</div>
        </section>
      `;
    })
    .join("");

  els.segmentList.innerHTML = blocks || `<p class="empty">放映包内还没有胶片卷。</p>`;
}

function renderCard(reel, item, draggable) {
  const realIndex = reel.segments.findIndex((segment) => segment.id === item.id);
  const hasDamage = item.damage !== "完好";
  return `
    <article class="segment-card"${draggable ? ' draggable="true"' : ""} data-id="${item.id}" data-reel="${escapeHtml(reel.number)}">
      <div class="thumb">
        ${
          item.thumb
            ? `<img src="${item.thumb}" alt="${escapeHtml(item.code)}缩略图" />`
            : `<div class="film-placeholder" style="background:${fallbackThumbs[realIndex % fallbackThumbs.length]}">${escapeHtml(item.code)}</div>`
        }
      </div>
      <div class="segment-main">
        <div class="segment-title">
          <strong>${escapeHtml(reel.number)}-${realIndex + 1}. ${escapeHtml(item.code)}</strong>
          <span>${formatDuration(item.duration)}</span>
        </div>
        <div class="tag-row">
          <span class="tag">${escapeHtml(item.shift)}</span>
          <span class="tag ${hasDamage ? "damage" : "ok"}">${escapeHtml(item.damage)}</span>
        </div>
        <p class="segment-note">${escapeHtml(item.note || "没有备注。")}</p>
      </div>
      <div class="segment-actions">
        <button type="button" title="同卷上移" data-move-up="${item.id}" ${realIndex === 0 ? "disabled" : ""}>↑</button>
        <button type="button" title="同卷下移" data-move-down="${item.id}" ${realIndex === reel.segments.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" title="删除" data-delete="${item.id}">×</button>
      </div>
    </article>
  `;
}

function renderSplitLine(reelIndex, segmentIndex, reelLength) {
  if (segmentIndex >= reelLength - 1) return "";
  return `
    <div class="split-line">
      <span class="split-rule"></span>
      <button type="button" class="split-btn" data-split-reel="${reelIndex}" data-split-after="${segmentIndex}">
        ✂ 在此相邻片段之间拆卷
      </button>
      <span class="split-rule"></span>
    </div>
  `;
}

function renderWarnings() {
  const pkg = activePackage();
  const warnings = pkg.reels.flatMap((reel) =>
    reel.segments
      .filter((item) => item.damage !== "完好" || item.shift !== "正常")
      .map((item) => ({ reel, item }))
  );
  els.warningList.innerHTML =
    warnings
      .map(({ reel, item }) => {
        const index = reel.segments.findIndex((segment) => segment.id === item.id) + 1;
        const reasons = [
          item.shift !== "正常" ? item.shift : "",
          item.damage !== "完好" ? item.damage : ""
        ]
          .filter(Boolean)
          .join(" · ");
        return `
          <div class="warning-item">
            <strong>${escapeHtml(reel.number)} 卷-${index}. ${escapeHtml(item.code)}</strong>
            <span>${escapeHtml(reasons)}${item.note ? `：${escapeHtml(item.note)}` : ""}</span>
          </div>
        `;
      })
      .join("") || `<p class="empty">当前放映包没有颜色偏移或破损提醒。</p>`;
}

function renderAll() {
  saveState();
  renderPackageBar();
  renderStats();
  renderReelSelect();
  renderList();
  renderWarnings();
}

/* ---------- 提示条 ---------- */

function showNotice(message, kind) {
  els.notice.textContent = message;
  els.notice.className = `notice ${kind || ""}`;
  els.notice.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    els.notice.hidden = true;
    els.notice.className = "notice";
  }, kind === "error" ? 6000 : 4000);
}

/* ---------- 工具 ---------- */

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

/* ---------- 片段增删与同卷排序 ---------- */

async function addSegment(event) {
  event.preventDefault();
  const pkg = activePackage();
  let reel = pkg.reels.find((item) => item.number === els.reelSelect.value);
  if (!reel) reel = pkg.reels[0];
  if (!reel) {
    reel = { number: nextReelNumber(pkg.reels), segments: [] };
    pkg.reels.push(reel);
  }

  const thumb = await readFileAsDataUrl(els.thumbInput.files[0]);
  reel.segments.push({
    id: makeId(),
    code: els.codeInput.value.trim(),
    duration: Number(els.durationInput.value),
    shift: els.shiftInput.value,
    damage: els.damageInput.value,
    note: els.noteInput.value.trim(),
    thumb
  });
  els.segmentForm.reset();
  els.durationInput.value = 12;
  renderAll();
  showNotice(`片段已加入 ${reel.number} 卷末尾。`, "success");
}

function findSegmentLocation(id) {
  const pkg = activePackage();
  for (let reelIndex = 0; reelIndex < pkg.reels.length; reelIndex += 1) {
    const segmentIndex = pkg.reels[reelIndex].segments.findIndex((item) => item.id === id);
    if (segmentIndex >= 0) return { reel: pkg.reels[reelIndex], reelIndex, segmentIndex };
  }
  return null;
}

function moveSegment(id, direction) {
  const location = findSegmentLocation(id);
  if (!location) return;
  const { reel, segmentIndex } = location;
  const target = segmentIndex + direction;
  if (target < 0 || target >= reel.segments.length) return;
  const [item] = reel.segments.splice(segmentIndex, 1);
  reel.segments.splice(target, 0, item);
  saveState();
  renderAll();
}

/* ---------- 放映包管理 ---------- */

function createPackage() {
  const pkg = {
    id: makeId(),
    title: `新放映包 ${state.packages.length + 1}`,
    reels: [{ number: "A", segments: [] }]
  };
  state.packages.push(pkg);
  state.activePackageId = pkg.id;
  saveState();
  renderAll();
  showNotice("已新建空放映包，初始为 A 卷。", "success");
}

function switchPackage(packageId) {
  if (!state.packages.some((pkg) => pkg.id === packageId)) return;
  state.activePackageId = packageId;
  draggedId = null;
  saveState();
  renderAll();
}

function deleteActivePackage() {
  if (state.packages.length <= 1) return;
  const pkg = activePackage();
  const count = pkg.reels.reduce((sum, reel) => sum + reel.segments.length, 0);
  const ok = window.confirm(
    `确定删除放映包「${pkg.title || "未命名放映包"}」吗？其中 ${pkg.reels.length} 卷、${count} 个片段将一并删除，且不可恢复。`
  );
  if (!ok) return;
  delete undoHistory[pkg.id];
  const index = state.packages.findIndex((item) => item.id === pkg.id);
  state.packages.splice(index, 1);
  state.activePackageId = state.packages[Math.max(0, index - 1)].id;
  saveState();
  renderAll();
  showNotice("放映包已删除。", "success");
}

/* ---------- 导出 ---------- */

function exportList() {
  const pkg = activePackage();
  const lines = [`放映包：${pkg.title || "未命名放映包"}`];
  pkg.reels.forEach((reel) => {
    const total = reel.segments.reduce((sum, item) => sum + Number(item.duration), 0);
    lines.push("", `【${reel.number} 卷】共 ${reel.segments.length} 段 · ${formatDuration(total)}`);
    reel.segments.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${item.code}｜${formatDuration(item.duration)}｜${item.shift}｜${item.damage}｜${item.note || "无备注"}`
      );
    });
  });
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const safeName = (pkg.title || "film-package").replace(/[\\/:*?"<>|]+/g, "_");
  link.download = `${safeName}-checklist.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---------- 事件绑定 ---------- */

els.packageSelect.addEventListener("change", () => switchPackage(els.packageSelect.value));
els.newPackageBtn.addEventListener("click", createPackage);
els.deletePackageBtn.addEventListener("click", deleteActivePackage);
els.packageTitle.addEventListener("input", () => {
  activePackage().title = els.packageTitle.value;
  saveState();
});
els.undoBtn.addEventListener("click", undoLast);

els.colorFilter.addEventListener("change", renderList);
els.damageFilter.addEventListener("change", renderList);
els.searchInput.addEventListener("input", renderList);
els.segmentForm.addEventListener("submit", addSegment);
els.exportBtn.addEventListener("click", exportList);

els.segmentList.addEventListener("click", (event) => {
  const split = event.target.closest("[data-split-reel]");
  const merge = event.target.closest("[data-merge]");
  const up = event.target.closest("[data-move-up]");
  const down = event.target.closest("[data-move-down]");
  const remove = event.target.closest("[data-delete]");

  if (split) {
    splitReel(Number(split.dataset.splitReel), Number(split.dataset.splitAfter));
    return;
  }
  if (merge) {
    mergeReel(Number(merge.dataset.merge));
    return;
  }
  if (up) moveSegment(up.dataset.moveUp, -1);
  if (down) moveSegment(down.dataset.moveDown, 1);
  if (remove) {
    const location = findSegmentLocation(remove.dataset.delete);
    if (location) {
      location.reel.segments.splice(location.segmentIndex, 1);
      saveState();
      renderAll();
    }
  }
});

// 拖拽排序只允许在同一卷内进行
els.segmentList.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-id]");
  if (!card) return;
  draggedId = card.dataset.id;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
});

els.segmentList.addEventListener("dragend", (event) => {
  event.target.closest("[data-id]")?.classList.remove("dragging");
  draggedId = null;
});

els.segmentList.addEventListener("dragover", (event) => {
  const card = event.target.closest("[data-id]");
  if (!card || !draggedId || card.dataset.id === draggedId) return;
  const from = findSegmentLocation(draggedId);
  const to = findSegmentLocation(card.dataset.id);
  if (!from || !to || from.reel.number !== to.reel.number) return;
  event.preventDefault();
  const [item] = from.reel.segments.splice(from.segmentIndex, 1);
  from.reel.segments.splice(to.segmentIndex, 0, item);
  saveState();
  renderAll();
});

renderAll();
if (bootMigrated) {
  showNotice("已检测到旧版单卷数据，首次打开已自动迁移为单卷放映包；原片段、编号和顺序均保留。", "success");
}
