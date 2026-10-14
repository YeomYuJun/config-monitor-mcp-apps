// src/ui/transfer.ts - 이관·동기화 뷰. 우측 detail 패널 자리에 그린다.
//   Export  config_export(dryRun 포함) + 최근 번들
//   Import  config_import_plan -> 항목 선택·충돌 선택·시크릿 입력 -> config_import_apply, 기록과 되돌리기
//   Sync    config_sync_setup / push / status(4상태). 다른 PC 가져오기는 Import 탭을 syncFrom 으로 연다
// 파일 선택 다이얼로그는 위젯 iframe 에서 쓸 수 없어 경로는 문자열로 받는다.
import { callTool, jparse } from "./bridge";
import { t, errText } from "./i18n";
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
      if (!dryRun) flashToast(r.message);
      for (const w of r.warnings || []) out.appendChild(notice(w));
      out.appendChild(el("pre", "xfreport", (r.report || []).join("\n")));
      if (!dryRun) void fillRecent(recent);
    } finally { clearPending(b); }
  };
  dry.addEventListener("click", () => run(dry, true));
  go.addEventListener("click", () => run(go, false));
  void fillRecent(recent);
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
    c.addEventListener("click", () => { bundlePath = x.path; syncFrom = ""; plan = null; tab = "import"; renderTransfer(); });
    box.appendChild(c);
  }
}

// ----- Import -----

function renderImport(pane: HTMLElement): void {
  const row = el("div", "xfrow");
  const inp = pathInput(bundlePath, t("xfBundlePh"), (v) => { bundlePath = v; syncFrom = ""; });
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
  const r = jparse(await callTool("config_import_plan", { ...src, secrets, choices }));
  if (!r || r.ok === false) { plan = null; out.replaceChildren(notice(errText(r), "err")); return; }
  plan = r;
  checked.clear();
  for (const it of r.items) if (it.state === "new" || it.state === "changed") checked.add(it.id);
  renderPlan(out);
}

function renderPlan(out: HTMLElement): void {
  out.replaceChildren();
  const s = plan.summary || {};
  const head = el("div", "xfsum");
  head.textContent = `${plan.source?.host ?? ""} · ` +
    ["new", "changed", "same", "blocked", "skipped"].map((k) => `${t(STATE_BADGE[k][0])} ${s[k] ?? 0}`).join(" · ");
  out.appendChild(head);
  for (const w of plan.warnings || []) out.appendChild(notice(w));
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
    out.appendChild(el("div", "dlabel", t("xfExternal")));
    const box = el("div", "xflist");
    for (const e of ext) {
      const r = el("div", "xfitem");
      r.append(el("span", "badge " + (e.exists ? "ok" : "err"), t(e.exists ? "xfExists" : "xfMissing")),
        el("span", "xfid", e.path), el("span", "xftgt", (e.owners || []).join(", ")));
      box.appendChild(r);
    }
    out.appendChild(box);
  }

  const btn = el("button", "xfbtn primary", `${t("xfApply")} (${checked.size})`) as HTMLButtonElement;
  applyBtn = btn;
  const res = el("div", "xfres");
  btn.addEventListener("click", async () => {
    if (!checked.size) { res.replaceChildren(notice(t("xfNothing"))); return; }
    setPending(btn);
    try {
      const args = { planId: plan.plan_id, ids: [...checked], secrets, choices };
      const r = jparse(syncFrom ? await callTool("config_sync_pull", { from: syncFrom, ...args })
        : await callTool("config_import_apply", { bundle: bundlePath, ...args }));
      res.replaceChildren(notice(errText(r, t("failed")), r?.ok ? "ok" : "err"));
      if (r?.failed?.length) res.appendChild(failedList(r.failed));
      if (r && (r.ok || r.code === "partial")) {
        plan = null;
        const hist = document.querySelector<HTMLElement>("#xfer .xfhist");
        if (hist) void renderHistory(hist);
      }
    } finally { clearPending(btn); }
  });
  out.append(btn, res);
}

function planRow(it: any): HTMLElement {
  const wrap = el("div", "xfitem" + (it.state === "blocked" ? " blocked" : ""));
  const line = el("div", "xfline");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  const selectable = it.state === "new" || it.state === "changed" || it.code === "secret_missing";
  cb.disabled = !selectable || (it.code === "secret_missing" && !secretsFilled(it));
  cb.checked = checked.has(it.id);
  cb.addEventListener("change", () => {
    if (cb.checked) checked.add(it.id); else checked.delete(it.id);
    if (applyBtn) applyBtn.textContent = `${t("xfApply")} (${checked.size})`;
  });
  line.append(cb, badge(it.state), el("span", "xfid", it.id), el("span", "xftgt", it.target || it.reason || ""));
  wrap.appendChild(line);
  const detail = el("div", "xfdetail");
  if (it.diff?.length || it.files) {
    const tg = el("button", "linkbtn", t("xfDiff"));
    tg.addEventListener("click", () => {
      if (openDiff.has(it.id)) openDiff.delete(it.id); else openDiff.add(it.id);
      fillDetail();
    });
    line.appendChild(tg);
  }
  const fillDetail = () => {
    detail.replaceChildren();
    if (!openDiff.has(it.id)) return;
    if (it.diff?.length) detail.appendChild(diffLines(it.diff));
    if (it.files) {
      for (const [k, label] of [["added", "xfFilesAdded"], ["modified", "xfFilesModified"], ["removed", "xfFilesRemoved"]]) {
        if (it.files[k]?.length) detail.appendChild(el("div", "xffiles", `${t(label)}: ${it.files[k].join(", ")}`));
      }
    }
  };
  fillDetail();
  wrap.appendChild(detail);
  for (const w of it.warnings || []) wrap.appendChild(notice(w));
  if (it.state === "blocked" && it.reason && it.code !== "secret_missing") wrap.appendChild(notice(it.reason, "err"));
  if (it.conflicts?.length) {
    const box = el("div", "xfconf");
    box.appendChild(el("div", "dlabel", t("xfConflict")));
    for (const p of it.conflicts as string[]) {
      const r = el("div", "xfconfrow");
      const sel = document.createElement("select");
      sel.innerHTML = `<option value="keep">${esc(t("xfKeep"))}</option><option value="take">${esc(t("xfTake"))}</option>`;
      sel.value = choices[it.id]?.[p] || "keep";
      sel.addEventListener("change", () => { (choices[it.id] ||= {})[p] = sel.value as "keep" | "take"; });
      r.append(el("span", "xfid", p), sel);
      box.appendChild(r);
    }
    wrap.appendChild(box);
  }
  if (it.code === "secret_missing") {
    const box = el("div", "xfconf");
    box.appendChild(notice(it.reason, "err"));
    for (const p of it.missing_secrets as string[]) {
      const r = el("div", "xfconfrow");
      const i = document.createElement("input");
      i.type = "password";
      i.className = "xfinput";
      i.placeholder = t("xfSecretPh");
      i.value = secrets[it.id]?.[p] || "";
      i.addEventListener("input", () => {
        (secrets[it.id] ||= {})[p] = i.value;
        cb.disabled = !secretsFilled(it);
        if (cb.disabled) { cb.checked = false; checked.delete(it.id); }
      });
      r.append(el("span", "xfid", p), i);
      box.appendChild(r);
    }
    wrap.appendChild(box);
  }
  return wrap;
}

const secretsFilled = (it: any): boolean =>
  (it.missing_secrets || []).every((p: string) => !!secrets[it.id]?.[p]);

function failedList(failed: any[]): HTMLElement {
  const box = el("div", "xflist");
  box.appendChild(el("div", "dlabel", t("xfFailed")));
  for (const f of failed) {
    const r = el("div", "xfitem");
    r.append(el("span", "xfid", f.id), el("span", "xftgt", errText({ code: f.code, target: f.target || f.id, message: f.reason })));
    box.appendChild(r);
  }
  return box;
}

async function renderHistory(box: HTMLElement): Promise<void> {
  const h = await history();
  box.replaceChildren(el("div", "dlabel", t("xfHistory")));
  if (!h.imports?.length) { box.appendChild(el("div", "empty", t("xfNoHistory"))); return; }
  for (const x of h.imports) {
    const r = el("div", "xfitem");
    const line = el("div", "xfline");
    line.append(el("span", "xfid", x.id), el("span", "xftgt", `${x.source_host ?? ""} · ${x.items.length} · ${x.bundle}`));
    const res = el("div", "xfres");
    if (x.undone_at) line.appendChild(el("span", "badge", t("xfUndone")));
    else {
      const undo = (force: boolean, b: HTMLButtonElement) => async () => {
        setPending(b);
        try {
          const u = jparse(await callTool("config_import_undo", { importId: x.id, force }));
          res.replaceChildren(notice(errText(u, t("failed")), u?.ok ? "ok" : "err"));
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
    r.append(line, res);
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
      res.replaceChildren(notice(errText(r, t("failed")), r?.ok ? "ok" : "err"));
      if (r?.ok) flashToast(r.message);
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
  pull.addEventListener("click", () => { syncFrom = from; plan = null; tab = "import"; renderTransfer(); });
  box.append(el("div", "xfsum", r.message), pull);
  for (const it of r.items) {
    if (it.state === "in-sync" && !showAll) continue;
    const [k, cls] = SYNC_BADGE[it.state] || [it.state, ""];
    const line = el("div", "xfitem");
    const l = el("div", "xfline");
    l.append(el("span", "badge" + (cls ? " " + cls : ""), t(k)), el("span", "xfid", it.id));
    line.appendChild(l);
    box.appendChild(line);
  }
}
