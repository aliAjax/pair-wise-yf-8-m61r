const fs = require("fs");
const path = require("path");
const { JSDOM } = require(path.join("/tmp/node_modules/jsdom"));

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDom(saved) {
  const dom = new JSDOM(html.replace('<script src="app.js"></script>', `<script>${js}<\/script>`), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://film.test/",
    beforeParse(window) {
      window.Blob = class {
        constructor(parts) {
          this.parts = parts;
        }
      };
      window.URL.createObjectURL = () => "blob:x";
      window.URL.revokeObjectURL = () => {};
      if (saved) window.localStorage.setItem("zfl17-film-strip-desk", saved);
    }
  });
  return dom;
}

function fire(win, el, type) {
  el.dispatchEvent(new win.Event(type, { bubbles: true }));
}

let failures = 0;
function check(name, cond) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`ok: ${name}`);
  }
}

async function modalEnter(win, value) {
  const doc = win.document;
  if (value !== null) doc.querySelector("#modalInput").value = value;
  doc.querySelector("#modalOk").click();
  await wait();
}

async function run() {
  /* 1. 旧单卷数据首次打开自动迁移 */
  const legacy = JSON.stringify({
    reelTitle: "旧单卷C卷",
    segments: [
      { id: "old-1", code: "C-9", duration: 42, shift: "褪色", damage: "完好", note: "旧备注", thumb: "" }
    ]
  });
  const dom = makeDom(legacy);
  const win = dom.window;
  const doc = win.document;
  await wait();

  check("迁移后只有一卷", doc.querySelectorAll(".reel-block").length === 1);
  check("卷号取旧标题", doc.querySelector(".reel-number").textContent === "旧单卷C卷");
  check("片段迁移并渲染", doc.querySelector(".reel-block").textContent.includes("C-9"));
  check("统计：片段数 1", doc.querySelector("#segmentCount").textContent === "1");
  check("统计：总时长 0:42", doc.querySelector("#totalDuration").textContent === "0:42");
  const stored = JSON.parse(win.localStorage.getItem("zfl17-film-strip-desk"));
  check("localStorage 写为 v2 多卷结构", stored.version === 2 && Array.isArray(stored.packages));

  /* 2. 新增空卷 */
  doc.querySelector("#newReelBtn").click();
  await wait();
  await modalEnter(win, "D卷");
  check("新增卷后有两卷", doc.querySelectorAll(".reel-block").length === 2);

  /* 3. 在两个卷中分别录入片段 */
  const target = doc.querySelector("#targetReel");
  target.value = [...target.options].find((o) => o.textContent.includes("D卷")).value;
  doc.querySelector("#codeInput").value = "D-1";
  doc.querySelector("#durationInput").value = "11";
  fire(win, doc.querySelector("#segmentForm"), "submit");
  await wait();
  check("片段进入 D卷", [...doc.querySelectorAll(".reel-block")].some((b) => b.textContent.includes("D-1")));

  target.value = [...target.options].find((o) => o.textContent.includes("旧单卷C卷")).value;
  doc.querySelector("#codeInput").value = "C-10";
  doc.querySelector("#durationInput").value = "8";
  fire(win, doc.querySelector("#segmentForm"), "submit");
  await wait();

  /* 4. 拆卷：左卷守号，右卷领号 */
  const firstSeam = doc.querySelector(".split-seam");
  check("两段之间出现拆卷接缝", !!firstSeam);
  firstSeam.click();
  await wait();
  await modalEnter(win, "E卷");
  check("拆卷成功变三卷", doc.querySelectorAll(".reel-block").length === 3);
  check("左卷守住原编号", doc.querySelectorAll(".reel-number")[0].textContent === "旧单卷C卷");
  check("右卷领取新编号 E卷", doc.querySelectorAll(".reel-number")[1].textContent === "E卷");
  check("撤销按钮启用", doc.querySelector("#undoBtn").disabled === false);

  /* 5. 合并相邻卷，保留左卷号（顺序：旧C → E → D，合并旧C 与 E） */
  doc.querySelector(".merge-seam").click();
  await wait();
  await modalEnter(win, null); // confirm 模式，确定
  check("合并后两卷", doc.querySelectorAll(".reel-block").length === 2);
  check("合并保留左卷号", doc.querySelectorAll(".reel-number")[0].textContent === "旧单卷C卷");

  /* 6. 撤销恢复合并、再撤销恢复拆卷 */
  doc.querySelector("#undoBtn").click();
  check("撤销合并恢复三卷", doc.querySelectorAll(".reel-block").length === 3);
  doc.querySelector("#undoBtn").click();
  check("撤销拆卷恢复两卷", doc.querySelectorAll(".reel-block").length === 2);
  check("撤销栈清空后按钮禁用", doc.querySelector("#undoBtn").disabled === true);

  /* 7. 整次拒绝：新卷号重号 */
  doc.querySelector(".split-seam").click();
  await wait();
  await modalEnter(win, "D卷");
  check("重号整次拒绝提示", doc.querySelector("#toast").textContent.includes("重复"));
  check("拒绝后卷序不变（仍两卷）", doc.querySelectorAll(".reel-block").length === 2);
  check("被拒绝操作不产生撤销步", doc.querySelector("#undoBtn").disabled === true);

  /* 8. 颜色与破损筛选同步，筛选中隐藏拆并控件 */
  doc.querySelector("#colorFilter").value = "褪色";
  fire(win, doc.querySelector("#colorFilter"), "change");
  check("颜色筛选后接缝隐藏", doc.querySelectorAll(".split-seam").length === 0);
  check("筛选结果含 C-9", doc.querySelector("#reelList").textContent.includes("C-9"));
  check("筛选不含 D-1", !doc.querySelector("#reelList").textContent.includes("D-1"));
  doc.querySelector("#colorFilter").value = "all";
  fire(win, doc.querySelector("#colorFilter"), "change");
  doc.querySelector("#damageFilter").value = "完好";
  fire(win, doc.querySelector("#damageFilter"), "change");
  check("破损筛选后合并条隐藏", doc.querySelectorAll(".merge-seam").length === 0);
  doc.querySelector("#damageFilter").value = "all";
  fire(win, doc.querySelector("#damageFilter"), "change");
  check("提醒列出褪色 C-9", doc.querySelector("#warningList").textContent.includes("C-9"));

  /* 9. 新建放映包并切换：统计/筛选/提醒/导出按包同步 */
  doc.querySelector("#newPackageBtn").click();
  await wait();
  await modalEnter(win, "试映二包");
  check("新包片段数为 0", doc.querySelector("#segmentCount").textContent === "0");
  check("新包卷数为 1", doc.querySelector("#reelCount").textContent === "1");
  check("新包提醒为空态", doc.querySelector("#warningList").textContent.includes("没有"));
  check("新包撤销按钮禁用", doc.querySelector("#undoBtn").disabled === true);

  const sel = doc.querySelector("#packageSelect");
  sel.value = [...sel.options].find((o) => !o.textContent.includes("试映二包")).value;
  fire(win, sel, "change");
  check("切回旧包统计恢复（3 段）", doc.querySelector("#segmentCount").textContent === "3");
  check("切回旧包卷数为 2", doc.querySelector("#reelCount").textContent === "2");

  let exported = "";
  win.URL.createObjectURL = (blob) => {
    exported = blob.parts.join("");
    return "blob:y";
  };
  doc.querySelector("#exportBtn").click();
  check("导出含放映包名", exported.includes("放映包：") && exported.includes("旧单卷C卷"));
  check("导出含卷头与片段", exported.includes("D-1") && exported.includes("总时长"));

  /* 10. 刷新保留 */
  const dom2 = makeDom(win.localStorage.getItem("zfl17-film-strip-desk"));
  const doc2 = dom2.window.document;
  await wait();
  check("刷新后放映包列表保留", [...doc2.querySelector("#packageSelect").options].some((o) => o.textContent.includes("试映二包")));
  check("刷新后当前包统计恢复", doc2.querySelector("#segmentCount").textContent === "3");

  console.log(failures ? `\n${failures} FAILURES` : "\nALL SMOKE CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
