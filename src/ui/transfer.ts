// src/ui/transfer.ts - 이관·동기화 뷰. 우측 detail 패널 자리에 그린다.
//   Export  config_export(dryRun 포함) + 최근 번들
//   Import  config_import_plan -> 항목 선택·충돌 선택·시크릿 입력 -> config_import_apply, 기록과 되돌리기
//   Sync    config_sync_setup / push / status(4상태). 다른 PC 가져오기는 Import 탭을 syncFrom 으로 연다
// 파일 선택 다이얼로그는 위젯 iframe 에서 쓸 수 없어 경로는 문자열로 받는다.
import { callTool, jparse, askClaude, canAskClaude } from "./bridge";
import { t, tf, errText, okText, getLang } from "./i18n";
import { $, esc, setPending, clearPending, flashToast } from "./widgets";
import { ABS_PATH_RE } from "./helpers";
import { setDetailOpen, setSelectedPath } from "./state";
import { applyDetailState } from "./detail";

type Tab = "export" | "import" | "sync";
let tab: Tab = "export";
let syncFrom = "";
let outPath = "";
let bundlePath = "";
let plan: any = null;
let showAll = false;
const checked = new Set<string>();
const choices: Record<string, Record<string, "keep" | "take">> = {};
const secrets: Record<string, Record<string, string>> = {};
const openDiff = new Set<string>();
let applyBtn: HTMLButtonElement | null = null;
// 경로 맞춤: 사용자가 표에서 고친 짝만 담는다(나머지는 서버가 저장된 짝과 추정으로 채운다).
// 짝은 화면에 보인 값 자체를 바꾸므로, 고친 뒤에는 다시 비교해야 적용할 수 있다.
let roots: Record<string, string> = {};
let rootsDirty = false;
const exclude = new Set<string>();

// 다른 번들로 넘어가면 앞 번들의 짝·끈 훅은 의미가 없다.
function resetImportInputs(): void {
  roots = {};
  rootsDirty = false;
  exclude.clear();
}

const SYNC_BADGE: Record<string, [string, string]> = {
  "in-sync": ["xfSyncInSync", ""], "local-ahead": ["xfSyncLocal", "ok"], "remote-ahead": ["xfSyncRemote", "warn"],
  diverged: ["xfSyncDiverged", "err"], untracked: ["xfSyncUntracked", ""],
};
const STATE_BADGE: Record<string, [string, string]> = {
  new: ["xfStNew", "ok"], changed: ["xfStChanged", "warn"], same: ["xfStSame", ""],
  blocked: ["xfStBlocked", "err"], skipped: ["xfStSkipped", ""],
};

export const isTransferOpen = (): boolean => !!document.getElementById("xfer");

export function openTransfer(): void {
  // 선택 파일을 비워야 폴링이 이력 패널로 이 뷰를 덮어쓰지 않는다.
  setSelectedPath("");
  document.querySelectorAll(".file").forEach((el) => el.classList.remove("sel"));
  setDetailOpen(true);
  applyDetailState();
  renderTransfer();
}

export function renderTransfer(): void {
  $("sel-name").textContent = t("xfTitle");
  $("sel-path").textContent = t("xfSub");
  const body = $("panel-body");
  body.innerHTML = "";
  const root = el("div", "xfer");
  root.id = "xfer";
  const tabs = el("div", "xftabs");
  for (const [k, label] of [["export", "xfTabExport"], ["import", "xfTabImport"], ["sync", "xfTabSync"]] as [Tab, string][]) {
    const b = el("button", "xftab" + (tab === k ? " sel" : ""), t(label));
    b.addEventListener("click", () => { tab = k; renderTransfer(); });
    tabs.appendChild(b);
  }
  const pane = el("div", "xfpane");
  root.append(tabs, pane);
  body.appendChild(root);
  if (tab === "export") renderExport(pane);
  else if (tab === "import") renderImport(pane);
  else void renderSync(pane);
}

function el(tag: string, cls = "", text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function badge(state: string): HTMLElement {
  const [k, cls] = STATE_BADGE[state] || [state, ""];
  return el("span", "badge" + (cls ? " " + cls : ""), t(k));
}

// 항목 id 를 "종류"와 "이름" 두 조각으로 쪼갠다. 행에서는 이름이 1차 정보라 왼쪽에 두고(열로 훑는다)
// 종류는 뒤에 붙는 꼬리표로 내린다. 이름이 없는 항목(settings.json 등)은 종류가 곧 이름이다.
function itemParts(id: string): { kind: string; name: string } {
  const i = id.indexOf("/");
  const cat = i < 0 ? id : id.slice(0, i);
  const key = "xfCat." + cat;
  return { kind: t(key) === key ? cat : t(key), name: i < 0 ? "" : id.slice(i + 1) };
}

function itemName(id: string): string {
  const { kind, name } = itemParts(id);
  return name ? `${kind} ${name}` : kind;
}

// 목록 행의 공통 골격. **늘어나는 칸은 .xfmeta 하나뿐**이고(min-width:0) 나머지는 고정 폭이다.
// 예전처럼 flex-wrap 행에 늘어나는 span 을 둘씩 두면 뒤엣것이 0 폭까지 눌려 긴 경로가
// 한 글자씩 세로로 쏟아졌다. 경로는 접지 않고 ellipsis 로 자르고 전체 값은 title 에 둔다
// (대시보드의 .file .fdir / .projpickrow .ppath 와 같은 규율).
type RowOpts = {
  cls?: string; check?: HTMLInputElement; badge?: HTMLElement;
  name: string; kind?: string; path?: string; actions?: HTMLElement[];
};
function itemRow(o: RowOpts): { wrap: HTMLElement; line: HTMLElement; meta: HTMLElement } {
  const wrap = el("div", "xfitem" + (o.cls ? " " + o.cls : ""));
  const line = el("div", "xfline");
  if (o.check) line.appendChild(o.check);
  if (o.badge) line.appendChild(o.badge);
  const meta = el("div", "xfmeta");
  const top = el("div", "xftop");
  const nm = el("span", "xfname", o.name);
  nm.title = o.name;
  top.appendChild(nm);
  if (o.kind) {
    const k = el("span", "xfkind", o.kind);
    k.title = o.kind;
    top.appendChild(k);
  }
  meta.appendChild(top);
  if (o.path) {
    const p = el("div", "xfpath", o.path);
    p.title = o.path;
    meta.appendChild(p);
  }
  line.appendChild(meta);
  if (o.actions?.length) {
    const act = el("div", "xfact");
    act.append(...o.actions);
    line.appendChild(act);
  }
  wrap.appendChild(line);
  return { wrap, line, meta };
}

// id 한 줄짜리 자리(충돌 키·시크릿 키). 긴 키도 행을 밀지 않게 자른다.
function keySpan(text: string): HTMLElement {
  const s = el("span", "xfid", text);
  s.title = text;
  return s;
}

// 상태별 개수 요약. "새로 44 · 바뀜 16 · ..." 한 줄로 이으면 어디가 끊기는지 안 보여서
// 숫자를 세우고 배지와 같은 색 점을 달아 아래 목록의 배지와 눈으로 이어지게 한다.
function summary(host: string, counts: Record<string, any>, map: Record<string, [string, string]>,
                 keys: string[]): HTMLElement {
  const box = el("div", "xfsum");
  if (host) box.appendChild(el("span", "xfsumhost", host));
  for (const k of keys) {
    const n = counts[k] ?? 0;
    const [label, cls] = map[k] || [k, ""];
    const c = el("span", "xfsumchip" + (cls ? " " + cls : "") + (n ? "" : " zero"));
    c.append(el("b", "", String(n)), document.createTextNode(t(label)));
    box.appendChild(c);
  }
  return box;
}

function notice(msg: string, kind: "err" | "warn" | "ok" = "warn"): HTMLElement {
  return el("div", "anotice " + kind, msg);
}

function pathInput(value: string, ph: string, onChange: (v: string) => void): HTMLInputElement {
  const i = document.createElement("input");
  i.className = "xfinput";
  i.placeholder = ph;
  i.value = value;
  i.addEventListener("input", () => onChange(i.value.trim()));
  return i;
}

function diffLines(lines: string[]): HTMLElement {
  const wrap = el("div", "diffwrap");
  const box = el("div", "difflines");
  box.innerHTML = lines.map((l) => {
    const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del"
      : l.startsWith("@@") ? "hunk" : "";
    return `<div class="dl ${cls}">${esc(l) || "&nbsp;"}</div>`;
  }).join("");
  wrap.appendChild(box);
  return wrap;
}

async function history(): Promise<any> {
  const r = jparse(await callTool("config_import_history"));
  return r && r.ok !== false ? r : { imports: [], exports: [] };
}

// ----- Export -----

function renderExport(pane: HTMLElement): void {
  const row = el("div", "xfrow");
  const inp = pathInput(outPath, t("xfOutPh"), (v) => { outPath = v; });
  row.appendChild(inp);
  const opts = el("div", "xfopts");
  const sec = checkbox(t("xfInclSecrets"));
  const loc = checkbox(t("xfInclLocal"));
  const mem = checkbox(t("xfInclMemory"));
  const amem = checkbox(t("xfInclAgentMemory"));
  opts.append(sec.label, loc.label, mem.label, amem.label);
  const warn = notice(t("xfSecretsWarn"), "err");
  warn.hidden = true;
  sec.input.addEventListener("change", () => { warn.hidden = !sec.input.checked; });
  const btns = el("div", "xfbtns");
  const dry = el("button", "xfbtn", t("xfDry")) as HTMLButtonElement;
  const go = el("button", "xfbtn primary", t("xfExport")) as HTMLButtonElement;
  btns.append(dry, go);
  const out = el("div", "xfout");
  const recent = el("div", "xfrecent");
  pane.append(row, opts, warn, btns, out, recent);

  const run = async (b: HTMLButtonElement, dryRun: boolean) => {
    if (!dryRun && !ABS_PATH_RE.test(outPath)) { out.replaceChildren(notice(t("xfAbsPath"), "err")); return; }
    setPending(b);
    try {
      const r = jparse(await callTool("config_export", {
        dryRun, out: dryRun ? undefined : outPath, includeSecrets: sec.input.checked,
        withOptional: [[loc, "local"], [mem, "memory"], [amem, "agent-memory"]]
          .filter(([c]) => (c as any).input.checked).map(([, k]) => k),
      }));
      out.replaceChildren();
      if (!r || r.ok === false) { out.appendChild(notice(errText(r), "err")); return; }
      if (!dryRun) flashToast(okText(r, "xfExported", ` · ${r.bundle}`));
      for (const w of r.warnings || []) out.appendChild(notice(w));
      out.appendChild(el("pre", "xfreport", reportLines(r, dryRun).join("\n")));
      if (!dryRun) void fillRecent(recent);
    } finally { clearPending(b); }
  };
  dry.addEventListener("click", () => run(dry, true));
  go.addEventListener("click", () => run(go, false));
  void fillRecent(recent);
}

const EXT_SCOPE: Record<string, string> = { "cc.mcp-user": "Claude Code", "desk.mcp": "Desktop" };

// 백엔드 report 는 한국어 문장이라 영어 화면은 같은 구조 필드로 다시 그린다(transfer.py Collector.report 와 같은 구성).
function reportLines(r: any, dryRun: boolean): string[] {
  if (getLang() === "ko") return r.report || [];
  const lines: string[] = [dryRun ? t("xfRepTargets") : `${t("xfRepResult")}: ${r.bundle}`];
  for (const [cat, n] of Object.entries(r.counts || {})) lines.push(`- ${itemName(cat)}: ${n}`);
  const p = r.plugins || {};
  if (Object.keys(p).length) {
    lines.push("- " + tf("xfRepPlugins", { n: p.declared, m: p.market?.length ?? 0, b: p.builtin?.length ?? 0, i: p.inline?.length ?? 0 }));
    if (p.added_explicit?.length) lines.push(`  - ${t("xfRepAddedExplicit")}: ${p.added_explicit.join(", ")}`);
    if (p.dropped?.length) lines.push(`  - ${t("xfRepDropped")}: ${p.dropped.join(", ")}`);
  }
  const sec = r.secrets || [];
  if (sec.length) {
    lines.push("- " + tf(r.include_secrets ? "xfRepSecretsIn" : "xfRepSecretsOut", { n: sec.length }));
    for (const x of sec) lines.push(`  - ${itemName(x.item)}: ${x.path}`);
  }
  const ext: any[] = r.external || [];
  if (ext.length) {
    lines.push("- " + t("xfRepExternal"));
    const disp = (e: any) => e.path + (e.exists ? "" : ` [${t("xfRepMissingHere")}]`);
    for (const kind of new Set(ext.map((e) => e.kind as string))) {
      const rows = ext.filter((e) => e.kind === kind);
      lines.push(`  - ${t("xfExt." + kind)}`);
      if (kind === "mcp") {
        type Group = { name: string; scopes: string[]; paths: string[] };
        const by = new Map<string, Group>();
        for (const e of rows) for (const o of e.owners || []) {
          const g: Group = by.get(o.toLowerCase()) ?? { name: o, scopes: [], paths: [] };
          by.set(o.toLowerCase(), g);
          g.paths.push(disp(e));
          for (const sc of e.scopes || []) if (!g.scopes.includes(sc)) g.scopes.push(sc);
        }
        for (const g of [...by.values()].sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1)) {
          const where = Object.keys(EXT_SCOPE).filter((sc) => g.scopes.includes(sc)).map((sc) => EXT_SCOPE[sc]).join(", ");
          lines.push(`    - ${g.name} (${where}): ${g.paths.join(", ")}`);
        }
      } else if (kind === "plugin-dirs" || kind === "library") lines.push(...rows.map((e) => `    - ${disp(e)}`));
      else lines.push(...rows.map((e) => `    - ${disp(e)} (${(e.owners || []).join(", ")})`));
    }
  }
  if (r.skipped?.length) {
    lines.push("- " + tf("xfRepSkipped", { n: r.skipped.length }));
    for (const x of r.skipped) lines.push(`  - ${itemName(x.id)}: ${x.reason}`);
  }
  if (r.warnings?.length) lines.push("- " + t("xfRepWarnings"), ...r.warnings.map((w: string) => `  - ${w}`));
  return lines;
}

function checkbox(text: string): { label: HTMLElement; input: HTMLInputElement } {
  const label = el("label", "xfchk");
  const input = document.createElement("input");
  input.type = "checkbox";
  label.append(input, document.createTextNode(" " + text));
  return { label, input };
}

async function fillRecent(box: HTMLElement): Promise<void> {
  const h = await history();
  box.replaceChildren();
  if (!h.exports?.length) return;
  box.appendChild(el("div", "dlabel", t("xfRecent")));
  for (const x of h.exports) {
    const c = el("button", "chip pick", x.path);
    c.title = `${x.at} · ${x.items}`;
    c.addEventListener("click", () => {
      bundlePath = x.path; syncFrom = ""; plan = null; tab = "import"; resetImportInputs(); renderTransfer();
    });
    box.appendChild(c);
  }
}

// ----- Import -----

function renderImport(pane: HTMLElement): void {
  const row = el("div", "xfrow");
  const inp = pathInput(bundlePath, t("xfBundlePh"), (v) => { bundlePath = v; syncFrom = ""; resetImportInputs(); });
  const go = el("button", "xfbtn primary", t("xfPlan")) as HTMLButtonElement;
  row.append(inp, go);
  if (syncFrom) inp.value = `${t("xfTabSync")}: ${syncFrom}`;
  const out = el("div", "xfout");
  const hist = el("div", "xfhist");
  pane.append(row, out, hist);
  go.addEventListener("click", async () => {
    if (!syncFrom && !ABS_PATH_RE.test(bundlePath)) { out.replaceChildren(notice(t("xfAbsPath"), "err")); return; }
    setPending(go);
    try { await runPlan(out); } finally { clearPending(go); }
  });
  if (plan) renderPlan(out);
  else if (syncFrom) go.click();
  void renderHistory(hist);
}

async function runPlan(out: HTMLElement): Promise<void> {
  const src = syncFrom ? { syncFrom } : { bundle: bundlePath };
  const r = jparse(await callTool("config_import_plan", { ...src, secrets, choices, roots, exclude: [...exclude] }));
  if (!r || r.ok === false) { plan = null; out.replaceChildren(notice(errText(r), "err")); return; }
  plan = r;
  rootsDirty = false;
  checked.clear();
  openDiff.clear();
  for (const it of r.items) if (it.state === "new" || it.state === "changed") checked.add(it.id);
  renderPlan(out);
}

function renderPlan(out: HTMLElement): void {
  out.replaceChildren();
  out.appendChild(summary(plan.source?.host ?? "", plan.summary || {}, STATE_BADGE,
    ["new", "changed", "same", "blocked", "skipped"]));
  for (const w of plan.warnings || []) out.appendChild(notice(w));
  if (plan.roots?.length) out.appendChild(rootsBox(out));
  const all = checkbox(t("xfShowAll"));
  all.input.checked = showAll;
  all.input.addEventListener("change", () => { showAll = all.input.checked; renderPlan(out); });
  out.appendChild(all.label);

  const list = el("div", "xflist");
  for (const it of plan.items) {
    if (!showAll && (it.state === "same" || it.state === "skipped")) continue;
    list.appendChild(planRow(it));
  }
  out.appendChild(list);

  const ext = plan.external || [];
  if (ext.length) {
    const miss = ext.filter((e: any) => !e.exists).length;
    const title = `${t("xfExternal")} ${ext.length}` + (miss ? ` · ${t("xfMissing")} ${miss}` : "");
    out.appendChild(foldBox(title, "external", (box) => fillExternal(box, ext)));
  }

  const btn = el("button", "xfbtn primary", `${t("xfApply")} (${checked.size})`) as HTMLButtonElement;
  applyBtn = btn;
  if (rootsDirty) { btn.disabled = true; btn.title = t("xfRootsDirty"); }
  const res = el("div", "xfres");
  btn.addEventListener("click", async () => {
    if (!checked.size) { res.replaceChildren(notice(t("xfNothing"))); return; }
    setPending(btn);
    try {
      const args = { planId: plan.plan_id, ids: [...checked], secrets, choices, roots, exclude: [...exclude] };
      const r = jparse(syncFrom ? await callTool("config_sync_pull", { from: syncFrom, ...args })
        : await callTool("config_import_apply", { bundle: bundlePath, ...args }));
      const n = r?.applied?.length;
      res.replaceChildren(notice(r?.ok ? okText(r, "xfImported", n ? ` (${n})` : "") : errText(r, t("failed")), r?.ok ? "ok" : "err"));
      if (r?.failed?.length) res.appendChild(failedList(r.failed));
      if (r?.dropped?.length) res.appendChild(droppedList(r.dropped));
      if (r && (r.ok || r.code === "partial")) {
        // 적용한 계획은 끝난 계획이다. 이 PC 가 바뀜 같은 plan_id 로는 다시 적용되지 않고
        // (plan_stale), 남겨두면 이미 가져온 항목이 여전히 골라져 있는 목록으로 읽힌다.
        // res 는 out 의 자식이라 결과 안내만 남기고 목록·적용 버튼은 걷어낸다.
        // choices·secrets 는 다음 비교에 그대로 다시 넘겨야 하므로 지우지 않는다.
        plan = null;
        applyBtn = null;
        checked.clear();
        openDiff.clear();
        exclude.clear();
        out.replaceChildren(res);
        const hist = document.querySelector<HTMLElement>("#xfer .xfhist");
        if (hist) void renderHistory(hist);
      }
    } finally { clearPending(btn); }
  });
  out.append(btn, res);
}

// 폴더 항목(스킬·에이전트)은 백엔드가 파일 목록만 주고 내용 diff 는 주지 않는다. 그 목록을
// 토글 뒤에 숨기면 눌러봐야 "변경 SKILL.md" 한 줄이라 누를 값어치가 없다 - 행에 바로 적는다.
// 파일이 많으면 이름 대신 개수로 접고 전체 이름은 title 에 남긴다.
const FILE_KINDS = [["added", "xfFilesAdded"], ["modified", "xfFilesModified"], ["removed", "xfFilesRemoved"]] as const;
function filesLine(files: any): HTMLElement | null {
  const rows = FILE_KINDS.map(([k, label]) => [t(label), (files[k] || []) as string[]] as const).filter(([, v]) => v.length);
  if (!rows.length) return null;
  const total = rows.reduce((n, [, v]) => n + v.length, 0);
  const e = el("div", "xffiles", rows.map(([l, v]) => `${l} ${total > 4 ? v.length : v.join(", ")}`).join("  ·  "));
  e.title = rows.map(([l, v]) => `${l}: ${v.join(", ")}`).join("\n");
  return e;
}

// 설정이 가리키는 외부 경로. 경로가 곧 이름이다(항목 이름이 따로 없다) - 이름 자리에 경로, 아래에 이를 가리키는 주체.
function fillExternal(box: HTMLElement, ext: any[]): void {
  for (const e of ext) {
    const { wrap, meta } = itemRow({
      cls: "ext",
      badge: el("span", "badge " + (e.exists ? "ok" : "err"), t(e.exists ? "xfExists" : "xfMissing")),
      name: e.path, path: (e.owners || []).join(", "),
    });
    if (e.mapped_from) meta.appendChild(remapLine([{ from: e.mapped_from, to: e.path }]));
    box.appendChild(wrap);
  }
}

function planRow(it: any): HTMLElement {
  const cb = document.createElement("input");
  cb.type = "checkbox";
  const selectable = it.state === "new" || it.state === "changed" || it.code === "secret_missing";
  cb.disabled = !selectable || (it.code === "secret_missing" && !secretsFilled(it));
  cb.checked = checked.has(it.id);
  cb.addEventListener("change", () => {
    if (cb.checked) checked.add(it.id); else checked.delete(it.id);
    if (applyBtn) applyBtn.textContent = `${t("xfApply")} (${checked.size})`;
  });

  const blocked = it.state === "blocked" && it.reason && it.code !== "secret_missing";
  // 서버 행의 target 은 쓸 파일(.claude.json)이다. 막은 이유의 대상은 없는 경로나 지킨 서버 이름이다.
  const blockTarget = it.code === "keep_working" ? it.key : it.missing_paths?.[0] ?? it.target;
  const blockMsg = blocked ? errText({ code: it.code, target: blockTarget, message: it.reason }) : "";
  // 경로와 설명은 다른 자리에 둔다. .xfpath 는 한 줄로 자르는 칸이라 문장을 넣으면 뜻이
  // 잘려나간다(제외 항목은 target 없이 reason 만 온다 - transfer.py Collector 의 skipped).
  // 막힘 안내가 대상 경로를 문장 안에 품을 때는 경로 줄을 접는다 - 같은 문자열이 두 번 뜬다.
  // 서버 행의 target 은 늘 같은 설정 파일이고 꼬리표(MCP 서버 (Claude Code))가 이미 그 파일을 말한다 - 줄을 아낀다.
  const server = it.category === "cc.mcp-user" || it.category === "desk.mcp";
  const sub = server || (blockMsg && it.target && blockMsg.includes(it.target)) ? "" : (it.target || "");
  const reason = it.target ? "" : (it.reason || "");

  const { kind, name } = itemParts(it.id);
  const actions: HTMLElement[] = [];
  const detail = el("div", "xfdetail");
  const fillDetail = () => {
    detail.replaceChildren();
    if (openDiff.has(it.id) && it.diff?.length) detail.appendChild(diffLines(it.diff));
  };
  // 실제 내용 diff 가 있을 때만 토글을 단다(없으면 버튼이 거짓 약속이 된다).
  if (it.diff?.length) {
    const tg = el("button", "xfdiffbtn" + (openDiff.has(it.id) ? " on" : ""), t("xfDiff")) as HTMLButtonElement;
    tg.addEventListener("click", () => {
      if (openDiff.has(it.id)) openDiff.delete(it.id); else openDiff.add(it.id);
      tg.classList.toggle("on", openDiff.has(it.id));
      fillDetail();
    });
    actions.push(tg);
  }

  const { wrap, meta } = itemRow({
    cls: it.state === "blocked" ? "blocked" : "", check: cb, badge: badge(it.state),
    name: name || kind, kind: name ? kind : "", path: sub, actions,
  });
  if (reason) meta.appendChild(el("div", "xfreason mut", reason));
  if (it.files) {
    const f = filesLine(it.files);
    if (f) meta.appendChild(f);
  }
  // 맞춘 경로는 위 경로 맞춤 표와 훅 줄마다 이미 보이므로, 훅을 품은 settings 행에서는 되풀이하지 않는다.
  if (it.remapped?.length && it.state !== "blocked" && !it.hooks?.length) meta.appendChild(remapLine(it.remapped));
  const rest = (it.dropped || []).filter((d: any) => d.what !== "hook");
  if (rest.length) {
    const byWhat = new Map<string, string[]>();
    for (const d of rest) byWhat.set(d.what, [...(byWhat.get(d.what) || []), d.target]);
    const line = el("div", "xfreason mut", tf("xfDropLine", {
      what: [...byWhat].map(([w, ps]) => `${t("xfDrop." + w)} ${ps.length}`).join(", "),
    }));
    line.title = rest.map((d: any) => d.target).join("\n");
    meta.appendChild(line);
  }
  // 토글이 있을 때만 붙인다 - 없는 행에 빈 칸을 :empty 규칙 하나에 기대지 않는다.
  if (it.diff?.length) {
    fillDetail();
    wrap.appendChild(detail);
  }
  // 막힌 이유는 상자 대신 행 안의 한 줄로 둔다(실패 목록의 .xfreason 과 같은 결) - 행마다 상자가 붙으면 목록이 세로로 늘어진다.
  if (blocked) meta.appendChild(el("div", "xfreason", blockMsg));
  if (it.hooks?.length) wrap.appendChild(hooksBox(it));
  for (const w of it.warnings || []) wrap.appendChild(notice(w));
  if (it.conflicts?.length) {
    const box = el("div", "xfconf");
    box.appendChild(el("div", "dlabel", t("xfConflict")));
    for (const p of it.conflicts as string[]) {
      const r = el("div", "xfconfrow");
      const sel = document.createElement("select");
      sel.className = "catsel xfsel";
      sel.innerHTML = `<option value="keep">${esc(t("xfKeep"))}</option><option value="take">${esc(t("xfTake"))}</option>`;
      sel.value = choices[it.id]?.[p] || "keep";
      sel.addEventListener("change", () => { (choices[it.id] ||= {})[p] = sel.value as "keep" | "take"; });
      r.append(keySpan(p), sel);
      box.appendChild(r);
    }
    wrap.appendChild(box);
  }
  if (it.code === "secret_missing") {
    const box = el("div", "xfconf");
    box.appendChild(notice(errText({ code: it.code, target: it.target, message: it.reason }), "err"));
    for (const p of it.missing_secrets as string[]) {
      const r = el("div", "xfconfrow");
      const i = document.createElement("input");
      i.type = "password";
      i.className = "xfinput xfsecret";
      i.placeholder = t("xfSecretPh");
      i.value = secrets[it.id]?.[p] || "";
      i.addEventListener("input", () => {
        (secrets[it.id] ||= {})[p] = i.value;
        cb.disabled = !secretsFilled(it);
        if (cb.disabled) { cb.checked = false; checked.delete(it.id); }
      });
      r.append(keySpan(p), i);
      box.appendChild(r);
    }
    wrap.appendChild(box);
  }
  return wrap;
}

// settings.json 의 훅은 명령 하나가 한 줄이다. 이 PC 에 없는 경로를 쓰는 훅(불가)과 이미 같은 훅이 있는 것(동일)은
// 고를 수 없고, 신규만 끄고 켠다(끈 훅은 exclude 로 넘어가 쓰지 않는다). 동일은 목록의 "동일·제외도 표시" 규칙을 따른다.
const HOOK_ORDER: Record<string, number> = { new: 0, blocked: 1, same: 2 };
function hooksBox(it: any): HTMLElement {
  const list = [...it.hooks].sort((a: any, b: any) => (HOOK_ORDER[a.state] ?? 9) - (HOOK_ORDER[b.state] ?? 9));
  const hidden = showAll ? 0 : list.filter((h: any) => h.state === "same").length;
  const n = (s: string) => list.filter((h: any) => h.state === s).length;
  const title = [`${t("xfHooks")} ${list.length}`,
    ...(["new", "blocked", "same"] as const).filter((s) => n(s)).map((s) => `${t(STATE_BADGE[s][0])} ${n(s)}`)].join(" · ");
  return foldBox(title, "hooks:" + it.id, (box) => fillHooks(box, list, hidden));
}

function fillHooks(box: HTMLElement, list: any[], hidden: number): void {
  for (const h of list) {
    if (h.state === "same" && !showAll) continue;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.disabled = h.state !== "new";
    cb.checked = h.state === "new" && !exclude.has(h.id);
    cb.addEventListener("change", () => { if (cb.checked) exclude.delete(h.id); else exclude.add(h.id); });
    box.appendChild(itemRow({
      cls: "xfsub", check: cb, badge: badge(h.state), name: hookName(h.command),
      kind: h.event + (h.matcher ? ` · ${h.matcher}` : ""), path: hookLine(h),
    }).wrap);
  }
  if (hidden) box.appendChild(el("div", "xfreason mut", tf("xfHookDupHidden", { n: hidden })));
}

// 접는 묶음. 현재 파일 뷰어·Diff 와 같은 .curwrap 접기를 쓴다. 수십 줄짜리라 기본은 접고, 펼친 상태는
// 다시 비교·다시 그리기에도 남는다.
const openFolds = new Set<string>();
function foldBox(title: string, key: string, fill: (body: HTMLElement) => void): HTMLElement {
  const w = el("div", "curwrap xffold" + (openFolds.has(key) ? " open" : ""));
  const head = el("div", "curhead");
  head.append(el("span", "chev3", "▸"), el("span", "", title));
  const body = el("div", "curbody");
  head.addEventListener("click", () => {
    w.classList.toggle("open");
    if (openFolds.has(key)) openFolds.delete(key); else openFolds.add(key);
  });
  fill(body);
  w.append(head, body);
  return w;
}

// 짝은 하나만 보여 준다(가장 구체적인 것 = 가장 긴 루트). 나머지는 "외 N곳" 과 title.
function remapText(list: any[]): string {
  const top = [...list].sort((a, b) => b.from.length - a.from.length)[0];
  return tf("xfRemapped", top) + (list.length > 1 ? tf("xfRemapMore", { n: list.length - 1 }) : "");
}
function remapLine(list: any[]): HTMLElement {
  const e = el("div", "xfreason mut", remapText(list));
  e.title = list.map((m) => tf("xfRemapped", m)).join("\n");
  return e;
}

function hookLine(h: any): string {
  if (h.state === "blocked") return tf("xfHookMissing", { p: h.target });
  if (h.state === "same") return t("xfHookDup");
  if (h.remapped?.length) return remapText(h.remapped);
  return h.command;
}

// 훅을 부르는 이름은 실행하는 스크립트의 파일명이다(인터프리터 python.exe 보다 뒤의 .py).
// index.js 처럼 어느 도구에나 있는 이름일 때만 폴더를 붙인다 - comment-linter/index.js.
const GENERIC_SCRIPT = /^(index|main|inject|probe|cli|run|hook|start)\.\w+$/i;
function hookName(cmd: string): string {
  const quoted = [...cmd.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const cands = [...quoted, ...cmd.replace(/"[^"]*"/g, " ").split(/\s+/)].filter((s) => /[\\/]/.test(s));
  const p = cands.find((s) => /\.(m?js|cjs|ts|py|ps1|sh)$/i.test(s)) ?? cands.find((s) => /\.\w+$/.test(s)) ?? cands[0];
  if (!p) return cmd;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.slice(GENERIC_SCRIPT.test(parts[parts.length - 1]) ? -2 : -1).join("/");
}

// 경로 맞춤 표. 행은 "값이 다른 키" 충돌 행과 같은 2열이다(왼쪽 번들 쪽 루트, 오른쪽 이 PC 폴더).
// 서버가 채운 값을 그대로 두면 확인만 하고 바로 적용할 수 있고, 틀렸으면 그 자리에서 고친다.
function rootsBox(out: HTMLElement): HTMLElement {
  const box = el("div", "xfconf");
  box.appendChild(el("div", "dlabel", t("xfRoots")));
  const hint = notice(t("xfRootsDirty"));
  hint.hidden = !rootsDirty;
  for (const r of plan.roots as any[]) {
    const row = el("div", "xfconfrow xfrootrow");
    const note = r.error ? t("xfRootBad")
      : `${t("xfRootSrc." + r.source)} · ${tf("xfRootCount", { n: r.resolved ?? 0, m: r.total ?? 0 })}`;
    const inp = document.createElement("input");
    inp.className = "xfinput xfroot";
    inp.placeholder = t("xfRootNone");
    inp.value = r.from in roots ? roots[r.from] : (r.to ?? "");
    inp.addEventListener("input", () => {
      roots[r.from] = inp.value.trim();
      rootsDirty = true;
      hint.hidden = false;
      if (applyBtn) { applyBtn.disabled = true; applyBtn.title = t("xfRootsDirty"); }
    });
    row.append(keySpan(r.from), inp, el("div", "xfreason xfrootnote" + (r.error ? "" : " mut"), note));
    box.appendChild(row);
  }
  const btns = el("div", "xfbtns");
  const again = el("button", "xfbtn", t("xfReplan")) as HTMLButtonElement;
  again.addEventListener("click", async () => {
    setPending(again);
    try { await runPlan(out); } finally { clearPending(again); }
  });
  btns.appendChild(again);
  const res = el("div", "xfres");
  if (plan.unresolved?.length && canAskClaude()) {
    const ask = el("button", "xfbtn", t("xfAskClaude")) as HTMLButtonElement;
    ask.title = t("xfAskClaudeTip");
    ask.addEventListener("click", async () => {
      setPending(ask);
      try {
        // Claude Desktop 은 맥락(updateModelContext)을 모델에 넘기지 않는다(실측). 그래서 입력창 글 하나가
        // 요청 전부다 - 번들(또는 동기화 PC), 쓸 도구, "설정 파일은 고치지 않는다" 까지 글에 넣는다.
        // 목록은 Claude 가 config_import_plan 을 다시 불러 unresolved 에서 얻는다.
        const src = syncFrom ? `syncFrom ${syncFrom}` : `bundle ${bundlePath}`;
        const ok = await askClaude(claudeContext(), tf("xfAskMsg", { n: plan.unresolved.length, src }));
        res.replaceChildren(notice(t(ok ? "xfAskSent" : "xfAskFail"), ok ? "ok" : "err"));
      } finally { clearPending(ask); }
    });
    btns.appendChild(ask);
  }
  box.append(hint, btns, res);
  return box;
}

// Claude 에게 넘기는 맥락. 사용자 눈에는 입력창의 한 줄만 보이고 이 글은 모델만 읽는다.
// 짝은 번들 쪽(원래 PC) 경로 기준이고, 홈 기준 경로는 이 PC 홈으로 풀리므로 짝으로 바꿀 수 없다.
function claudeContext(): string {
  const src = plan.source || {};
  const own = (u: any) => `${u.source_path} · ${u.kind} · ${(u.owners || []).join(", ")}`;
  const roots = (plan.unresolved as any[]).filter((u) => !u.in_home);
  const home = (plan.unresolved as any[]).filter((u) => u.in_home);
  return [
    "[config-monitor 가져오기 - 이 PC 에서 찾지 못한 경로]",
    syncFrom ? `동기화 PC: ${syncFrom} (config_import_roots 에 syncFrom 으로 넘긴다)`
      : `번들: ${bundlePath} (config_import_roots 에 bundle 로 넘긴다)`,
    `원래 PC: ${src.host ?? "?"} (홈 ${src.home ?? "?"})`,
    "할 일: 이 PC 를 탐색해 아래 도구가 실제로 있는 폴더를 찾고, config_import_roots 로 " +
      '{"<원래 PC 쪽 폴더>": "<이 PC 폴더>"} 를 저장한다. 설정 파일은 직접 고치지 않는다 - 적용은 사용자가 가져오기 화면에서 ' +
      "다시 비교한 뒤 한다. 찾지 못한 것은 찾지 못했다고 말한다.",
    "지금 짝:",
    ...(plan.roots as any[]).map((r) => `- ${r.from} -> ${r.to ?? "(없음)"} [${r.source}] ${r.resolved ?? 0}/${r.total ?? 0}`),
    "찾지 못한 경로 (원래 경로 · 종류 · 쓰는 곳):",
    ...roots.map((u) => `- ${own(u)}`),
    ...(home.length ? ["홈 기준 경로(이 PC 홈의 같은 자리로 풀린다 - 짝으로 바꿀 수 없고, 그 자리에 준비해야 한다):",
      ...home.map((u) => `- ${own(u)}`)] : []),
  ].join("\n");
}

// 이 PC 에 없는 경로라 들이지 않은 것. 적용 결과 아래에 남겨 무엇이 빠졌는지 보이게 한다.
function droppedList(dropped: any[]): HTMLElement {
  const box = el("div", "xflist");
  box.appendChild(el("div", "dlabel xfseclabel", t("xfDroppedTitle")));
  for (const d of dropped) {
    const kind = d.what === "item" ? itemName(d.id) : t("xfDrop." + d.what) + (d.event ? ` · ${d.event}` : "");
    const name = d.target ? String(d.target).split(/[\\/]+/).filter(Boolean).slice(-2).join("/") : itemName(d.id);
    box.appendChild(itemRow({ cls: "blocked", name, kind, path: d.target || "" }).wrap);
  }
  return box;
}

const secretsFilled = (it: any): boolean =>
  (it.missing_secrets || []).every((p: string) => !!secrets[it.id]?.[p]);

function failedList(failed: any[]): HTMLElement {
  const box = el("div", "xflist");
  box.appendChild(el("div", "dlabel xfseclabel", t("xfFailed")));
  for (const f of failed) {
    const { kind, name } = itemParts(f.id);
    const { wrap } = itemRow({ cls: "blocked", name: name || kind, kind: name ? kind : "" });
    // 실패 사유는 경로가 아니라 문장이다 - 잘라내면 정작 무엇이 막혔는지가 사라진다.
    wrap.appendChild(el("div", "xfreason",
      errText({ code: f.code, target: f.target || itemName(f.id), message: f.reason })));
    box.appendChild(wrap);
  }
  return box;
}

async function renderHistory(box: HTMLElement): Promise<void> {
  const h = await history();
  box.replaceChildren(el("div", "dlabel", t("xfHistory")));
  if (!h.imports?.length) { box.appendChild(el("div", "empty", t("xfNoHistory"))); return; }
  for (const x of h.imports) {
    const { wrap: r, line } = itemRow({
      name: x.id, path: x.bundle,
      kind: `${x.source_host ?? ""} · ${x.items.length}` + (x.dropped ? ` · ${t("xfDroppedShort")} ${x.dropped}` : ""),
    });
    const res = el("div", "xfres");
    if (x.undone_at) line.appendChild(el("span", "badge", t("xfUndone")));
    else {
      const undo = (force: boolean, b: HTMLButtonElement) => async () => {
        setPending(b);
        try {
          const u = jparse(await callTool("config_import_undo", { importId: x.id, force }));
          const n = u?.restored?.length;
          res.replaceChildren(notice(u?.ok ? okText(u, "xfUndoDone", n ? ` (${n})` : "") : errText(u, t("failed")), u?.ok ? "ok" : "err"));
          if (u?.failed?.length) {
            res.appendChild(failedList(u.failed));
            const fb = el("button", "xfbtn", t("xfUndoForce")) as HTMLButtonElement;
            fb.addEventListener("click", undo(true, fb));
            res.appendChild(fb);
          }
          if (u?.ok) line.appendChild(el("span", "badge", t("xfUndone")));
        } finally { clearPending(b); }
      };
      const b = el("button", "xfbtn", t("xfUndo")) as HTMLButtonElement;
      b.addEventListener("click", undo(false, b));
      line.appendChild(b);
    }
    r.appendChild(res);
    box.appendChild(r);
  }
}

// ----- Sync -----

async function renderSync(pane: HTMLElement): Promise<void> {
  const st = jparse(await callTool("config_sync_status", {}));
  const cur = st?.sync || {};
  const row = el("div", "xfrow");
  const dir = pathInput(cur.dir || "", t("xfSyncDirPh"), () => undefined);
  const prof = pathInput(cur.profile || "", t("xfSyncProfilePh"), () => undefined);
  prof.classList.add("xfshort");
  const save = el("button", "xfbtn", t("xfSyncSave")) as HTMLButtonElement;
  row.append(dir, prof, save);
  const out = el("div", "xfout");
  pane.append(row, out);
  save.addEventListener("click", async () => {
    if (!ABS_PATH_RE.test(dir.value.trim())) { out.replaceChildren(notice(t("xfAbsPath"), "err")); return; }
    setPending(save);
    try {
      const r = jparse(await callTool("config_sync_setup", { dir: dir.value.trim(), profile: prof.value.trim() || undefined }));
      if (r?.ok) renderTransfer();
      else out.replaceChildren(notice(errText(r), "err"));
    } finally { clearPending(save); }
  });
  if (!st || st.ok === false) {
    if (st?.code !== "sync_unconfigured") out.appendChild(notice(errText(st), "err"));
    return;
  }
  const opts = el("div", "xfopts");
  const sec = checkbox(t("xfInclSecrets"));
  opts.appendChild(sec.label);
  const warn = notice(t("xfSecretsWarn"), "err");
  warn.hidden = true;
  sec.input.addEventListener("change", () => { warn.hidden = !sec.input.checked; });
  const push = el("button", "xfbtn primary", t("xfSyncPush")) as HTMLButtonElement;
  const res = el("div", "xfres");
  push.addEventListener("click", async () => {
    setPending(push);
    try {
      const r = jparse(await callTool("config_sync_push", { includeSecrets: sec.input.checked }));
      const msg = r?.ok ? okText(r, "xfPushed", ` · ${r.bundle}`) : errText(r, t("failed"));
      res.replaceChildren(notice(msg, r?.ok ? "ok" : "err"));
      if (r?.ok) flashToast(msg);
    } finally { clearPending(push); }
  });
  out.append(opts, warn, push, res);

  const others = (st.profiles || []).filter((p: any) => p.profile !== cur.profile);
  out.appendChild(el("div", "dlabel", t("xfSyncFrom")));
  if (!others.length) { out.appendChild(el("div", "empty", t("xfSyncNone"))); return; }
  const chips = el("div", "xfopts");
  const table = el("div", "xflist");
  for (const p of others) {
    const c = el("button", "chip pick", p.profile);
    c.title = `${p.host ?? ""} · ${p.created ?? ""}`;
    c.addEventListener("click", () => void showStatus(p.profile, table));
    chips.appendChild(c);
  }
  out.append(chips, table);
}

async function showStatus(from: string, box: HTMLElement): Promise<void> {
  box.replaceChildren(el("div", "empty", t("loading")));
  const r = jparse(await callTool("config_sync_status", { from }));
  box.replaceChildren();
  if (!r || r.ok === false) { box.appendChild(notice(errText(r), "err")); return; }
  const pull = el("button", "xfbtn primary", t("xfSyncPull"));
  pull.addEventListener("click", () => { syncFrom = from; plan = null; tab = "import"; resetImportInputs(); renderTransfer(); });
  box.append(summary(from, r.summary || {}, SYNC_BADGE,
    Object.keys(SYNC_BADGE).filter((k) => r.summary?.[k])), pull);
  const list = el("div", "xflist");
  for (const it of r.items) {
    if (it.state === "in-sync" && !showAll) continue;
    const [k, cls] = SYNC_BADGE[it.state] || [it.state, ""];
    const { kind, name } = itemParts(it.id);
    list.appendChild(itemRow({
      badge: el("span", "badge" + (cls ? " " + cls : ""), t(k)),
      name: name || kind, kind: name ? kind : "",
    }).wrap);
  }
  box.appendChild(list);
}
