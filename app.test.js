const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./app.js");

const {
  makeSegment,
  makeReel,
  makePackage,
  migrateLegacy,
  normalizeData,
  inspectSegments,
  splitReel,
  mergeAdjacentReels,
  undoLast,
  suggestReelNumber
} = core;

function seg(code, duration, extra = {}) {
  return makeSegment({ code, duration, note: "n", ...extra });
}

test("旧单卷数据首次打开自动迁移为单卷放映包，卷号取旧标题", () => {
  const migrated = migrateLegacy({
    reelTitle: "老胶片B卷",
    segments: [
      { id: "s1", code: "X-1", duration: 5, shift: "正常", damage: "完好", note: "a", thumb: "" }
    ]
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.packages.length, 1);
  const pkg = migrated.packages[0];
  assert.equal(pkg.reels.length, 1);
  assert.equal(pkg.reels[0].number, "老胶片B卷");
  assert.equal(pkg.reels[0].segments[0].id, "s1");
  assert.equal(pkg.reels[0].segments[0].code, "X-1");
  assert.equal(migrated.currentPackageId, pkg.id);

  // normalizeData 对旧结构同样触发迁移
  const normalized = normalizeData({ reelTitle: "无名", segments: [] });
  assert.ok(Array.isArray(normalized.packages));
  assert.equal(normalized.packages[0].reels[0].number, "无名");
});

test("拆卷只在相邻片段之间，左卷守号右卷领新号", () => {
  const pkg = makePackage("p", [
    makeReel("A卷", [seg("A-1", 10), seg("A-2", 20), seg("A-3", 30)])
  ]);
  const reelId = pkg.reels[0].id;

  assert.equal(splitReel(pkg, reelId, 0, "B卷").ok, false);
  assert.equal(splitReel(pkg, reelId, 3, "B卷").ok, false);
  assert.equal(splitReel(pkg, "missing", 1, "B卷").ok, false);
  assert.equal(pkg.reels.length, 1, "非法拆卷卷序不变");

  const result = splitReel(pkg, reelId, 1, "B卷");
  assert.equal(result.ok, true);
  assert.equal(pkg.reels.length, 2);
  assert.equal(pkg.reels[0].number, "A卷", "左卷守住原编号");
  assert.equal(pkg.reels[1].number, "B卷");
  assert.deepEqual(pkg.reels[0].segments.map((s) => s.code), ["A-1"]);
  assert.deepEqual(pkg.reels[1].segments.map((s) => s.code), ["A-2", "A-3"]);
});

test("拆卷新卷号为空或与已有卷号重复时整次拒绝", () => {
  const pkg = makePackage("p", [
    makeReel("A卷", [seg("A-1", 10), seg("A-2", 20)]),
    makeReel("B卷", [seg("B-1", 5)])
  ]);
  const before = JSON.parse(JSON.stringify(pkg.reels));

  assert.equal(splitReel(pkg, pkg.reels[0].id, 1, "  ").ok, false);
  assert.equal(splitReel(pkg, pkg.reels[0].id, 1, "B卷").ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(pkg.reels)), before, "拒绝时清单与卷序不变");
});

test("时长为零导致拆卷整次拒绝", () => {
  const pkg = makePackage("p", [
    makeReel("A卷", [seg("A-1", 10), seg("A-2", 0), seg("A-3", 30)])
  ]);
  const before = JSON.parse(JSON.stringify(pkg.reels));
  // 零时长段落在右卷
  const r1 = splitReel(pkg, pkg.reels[0].id, 1, "B卷");
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /时长为零/);
  // 零时长段落在左卷
  const r2 = splitReel(pkg, pkg.reels[0].id, 2, "B卷");
  assert.equal(r2.ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(pkg.reels)), before);
});

test("需跳过片段缺备注导致拆卷整次拒绝", () => {
  const pkg = makePackage("p", [
    makeReel("A卷", [seg("A-1", 10), seg("A-2", 12, { damage: "需跳过", note: "" })])
  ]);
  const before = JSON.parse(JSON.stringify(pkg.reels));
  const result = splitReel(pkg, pkg.reels[0].id, 1, "B卷");
  assert.equal(result.ok, false);
  assert.match(result.reason, /需跳过/);
  assert.deepEqual(JSON.parse(JSON.stringify(pkg.reels)), before);
});

test("拆卷后任一卷内编号重复时整次拒绝（重复落在同一侧）", () => {
  const build = () =>
    makePackage("p", [
      makeReel("A卷", [seg("A-1", 10), seg("A-2", 12), seg("A-2", 8), seg("A-4", 9)])
    ]);

  // 重复对落在左卷：splitAt=3 -> 左 [A-1,A-2,A-2]
  const pkgLeft = build();
  const beforeLeft = JSON.parse(JSON.stringify(pkgLeft.reels));
  const r1 = splitReel(pkgLeft, pkgLeft.reels[0].id, 3, "B卷");
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /重复/);
  assert.deepEqual(JSON.parse(JSON.stringify(pkgLeft.reels)), beforeLeft);

  // 重复对落在右卷：splitAt=1 -> 右 [A-2,A-2,A-4]
  const pkgRight = build();
  const beforeRight = JSON.parse(JSON.stringify(pkgRight.reels));
  const r2 = splitReel(pkgRight, pkgRight.reels[0].id, 1, "B卷");
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /重复/);
  assert.deepEqual(JSON.parse(JSON.stringify(pkgRight.reels)), beforeRight);
});

test("只有相邻卷可以合并，合并保留左卷号", () => {
  const pkg = makePackage("p", [
    makeReel("A卷", [seg("A-1", 10)]),
    makeReel("B卷", [seg("B-1", 20)]),
    makeReel("C卷", [seg("C-1", 30)])
  ]);
  const before = JSON.parse(JSON.stringify(pkg.reels));

  assert.equal(mergeAdjacentReels(pkg, pkg.reels[0].id, pkg.reels[2].id).ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(pkg.reels)), before, "非相邻拒绝，卷序不变");

  const result = mergeAdjacentReels(pkg, pkg.reels[0].id, pkg.reels[1].id);
  assert.equal(result.ok, true);
  assert.equal(pkg.reels.length, 2);
  assert.deepEqual(pkg.reels.map((r) => r.number), ["A卷", "C卷"], "左卷号保留，卷序不变");
  assert.deepEqual(pkg.reels[0].segments.map((s) => s.code), ["A-1", "B-1"]);
});

test("合并时编号重复整次拒绝", () => {
  const pkg = makePackage("p", [
    makeReel("A卷", [seg("DUP", 10)]),
    makeReel("B卷", [seg("DUP", 20)])
  ]);
  const before = JSON.parse(JSON.stringify(pkg.reels));
  const result = mergeAdjacentReels(pkg, pkg.reels[0].id, pkg.reels[1].id);
  assert.equal(result.ok, false);
  assert.match(result.reason, /重复/);
  assert.deepEqual(JSON.parse(JSON.stringify(pkg.reels)), before);
});

test("合并时零时长或需跳过缺备注整次拒绝", () => {
  const zero = makePackage("p", [
    makeReel("A卷", [seg("A-1", 0)]),
    makeReel("B卷", [seg("B-1", 20)])
  ]);
  assert.equal(mergeAdjacentReels(zero, zero.reels[0].id, zero.reels[1].id).ok, false);

  const skip = makePackage("p", [
    makeReel("A卷", [seg("A-1", 10)]),
    makeReel("B卷", [seg("B-1", 20, { damage: "需跳过", note: "" })])
  ]);
  const result = mergeAdjacentReels(skip, skip.reels[0].id, skip.reels[1].id);
  assert.equal(result.ok, false);
  assert.match(result.reason, /需跳过/);
});

test("每次成功拆并生成版本，撤销恢复片段、卷号与顺序", () => {
  const pkg = makePackage("p", [
    makeReel("A卷", [seg("A-1", 10), seg("A-2", 20), seg("A-3", 30)]),
    makeReel("B卷", [seg("B-1", 5)])
  ]);
  const start = JSON.parse(JSON.stringify(pkg.reels));

  splitReel(pkg, pkg.reels[0].id, 1, "C卷");
  assert.equal(pkg.reels.length, 3);
  assert.equal(pkg.undo.length, 1);
  // 再把新右卷与 B卷（现在相邻）合并
  const cId = pkg.reels[1].id;
  const bId = pkg.reels[2].id;
  mergeAdjacentReels(pkg, cId, bId);
  assert.equal(pkg.reels.length, 2);
  assert.equal(pkg.undo.length, 2);

  assert.equal(undoLast(pkg), true);
  assert.deepEqual(pkg.reels.map((r) => r.number), ["A卷", "C卷", "B卷"]);
  assert.equal(undoLast(pkg), true);
  assert.deepEqual(JSON.parse(JSON.stringify(pkg.reels)), start, "撤销后片段、卷号、顺序完全恢复");
  assert.equal(pkg.undo.length, 0);
  assert.equal(undoLast(pkg), false);
});

test("被拒绝的操作不生成撤销版本", () => {
  const pkg = makePackage("p", [makeReel("A卷", [seg("A-1", 0), seg("A-2", 20)])]);
  splitReel(pkg, pkg.reels[0].id, 1, "B卷");
  assert.equal(pkg.undo.length, 0);
});

test("undo 栈按放映包独立，切换包互不干扰", () => {
  const pkgA = makePackage("A", [makeReel("A卷", [seg("A-1", 10), seg("A-2", 20)])]);
  const pkgB = makePackage("B", [makeReel("X卷", [seg("X-1", 1), seg("X-2", 2)])]);
  splitReel(pkgA, pkgA.reels[0].id, 1, "A2卷");
  assert.equal(pkgA.undo.length, 1);
  assert.equal(pkgB.undo.length, 0);
});

test("suggestReelNumber 跳过已用卷号", () => {
  const pkg = makePackage("p", [makeReel("A卷"), makeReel("B卷")]);
  assert.equal(suggestReelNumber(pkg), "C卷");
});

test("inspectSegments 基础校验", () => {
  assert.equal(inspectSegments([seg("a", 1), seg("b", 2)]).ok, true);
  assert.equal(inspectSegments([seg("a", 1), seg("a", 2)]).ok, false);
  assert.equal(inspectSegments([seg("a", 0)]).ok, false);
  assert.equal(inspectSegments([seg("a", 1, { damage: "需跳过", note: "" })]).ok, false);
  assert.equal(inspectSegments([seg("a", 1, { damage: "需跳过", note: "理由" })]).ok, true);
});

test("normalizeData 修复缺失 currentPackageId 与畸形片段", () => {
  const data = normalizeData({
    version: 2,
    packages: [{ name: "p", reels: [{ number: "R", segments: [{ code: "z" }] }] }],
    filters: { color: "偏红" }
  });
  assert.equal(data.packages[0].reels[0].segments[0].duration, 0);
  assert.equal(data.currentPackageId, data.packages[0].id);
  assert.equal(data.filters.color, "偏红");
});
