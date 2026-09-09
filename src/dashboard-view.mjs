import React, { useEffect, useState, useRef } from "react";
import { Box, Text, render, useInput, useStdout } from "ink";
import { statusText } from "./status.mjs";
import { wrapLines } from "./terminal-ui.mjs";
import { stripVTControlCharacters } from "node:util";

const h = React.createElement;
const display = value => stripVTControlCharacters(value).replace(/[\r\n\t]/g, " ");
const syncLabels = { aligned: "已对齐", paused: "已暂停", disconnected: "连接断开", scanning: "扫描中", syncing: "同步中", conflict: "有冲突", error: "同步错误", unknown: "状态未知", "not-started": "未启动" };
export function rowLabels(row) {
  if (row.error) return { manager: "未知", sync: row.error.code === "ENOENT" || row.error.code === "PROJECT_UNAVAILABLE" ? "目录不可用" : "查询失败" };
  if (!row.status) return { manager: "查询中", sync: "查询中" };
  const { manager, sync, auto } = row.status;
  return { manager: auto ? "已开启" : manager.state === "stopping" ? "停止中" : ["missing", "failed"].includes(manager.state) ? "管理异常" : sync.active ? "未托管" : "已关闭",
    sync: syncLabels[sync.state] || "状态未知" };
}

function Panel({ model, selectedRoot, message, onAction }) {
  const [, tick] = useState(0);
  const { stdout } = useStdout();
  const [selection, setSelection] = useState(selectedRoot);
  const [detail, setDetail] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [ready, setReady] = useState(false);
  const submitted = useRef(false);
  useEffect(() => {
    const update = () => tick(value => value + 1);
    model.on("change", update); stdout.on("resize", update); update();
    return () => { model.off("change", update); stdout.off("resize", update); };
  }, [model, stdout]);
  const { projects, registryError, loading } = model.snapshot();
  const columns = stdout.columns || 80, rows = stdout.rows || 24;
  const index = Math.max(0, projects.findIndex(p => p.root === selection));
  const selected = projects[index];
  useEffect(() => { if (selected && selected.root !== selection) setSelection(selected.root); }, [selected?.root, selection]);
  const pageSize = Math.max(1, rows - 15);
  const offset = Math.max(0, index - pageSize + 1);
  const detailLines = selected ? wrapLines([
    `项目：${selected.name}`, `远端：${selected.target || "未配置或不可用"}`,
    selected.error ? `${selected.root}\n${selected.error.message}` : selected.status ? statusText(selected.status) : "正在查询…",
    `更新：${selected.updatedAt || "等待首次查询"}`,
  ].join("\n"), columns).split("\n") : [];
  const maxScroll = Math.max(0, detailLines.length - pageSize);
  useInput((input, key) => {
    if (submitted.current) return;
    if (input === "q" || (key.ctrl && input === "c")) {
      submitted.current = true; onAction({ type: "quit", interrupted: key.ctrl, root: selected?.root }); return;
    }
    if (detail) {
      if (key.escape || key.return) { setDetail(false); setScroll(0); }
      else if (key.upArrow) setScroll(n => Math.max(0, n - 1));
      else if (key.downArrow) setScroll(n => Math.min(maxScroll, n + 1));
      return;
    }
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const delta = key.pageUp ? -pageSize : key.pageDown ? pageSize : key.upArrow ? -1 : 1;
      setSelection(projects[Math.max(0, Math.min(projects.length - 1, index + delta))]?.root);
      return;
    }
    if (key.return && selected) { setDetail(true); return; }
    if (input === "r") { void model.refresh(); return; }
    const type = { s: "start", x: "stop", a: "add", d: "remove", l: "relocate", c: "configure" }[input];
    if (type && (selected || type === "add")) { submitted.current = true; onAction({ type, root: selected?.root }); }
  });
  // Ink attaches keyboard listeners in effects, after the first frame. Show
  // actionable content only once those effects have run (including remounts).
  useEffect(() => { setReady(true); }, []);
  if (!ready) return h(Text, null, "正在准备控制面板…");
  const text = (value, props = {}) => h(Text, props, value);
  const line = (value, props = {}) => text(wrapLines(value, columns), props);
  const notice = value => {
    const lines = wrapLines(value, columns).split("\n");
    return lines.slice(0, 2).join("\n") + (lines.length > 2 ? "…" : "");
  };
  return h(Box, { flexDirection: "column", width: columns, paddingX: 1 },
    text("devsync · 项目控制面板", { bold: true, color: "cyan" }),
    text(`自动同步 ${projects.filter(p => p.status?.auto).length} / 已登记 ${projects.length}  ·  ${loading ? "刷新中" : "每 3 秒刷新"}`, { dimColor: true }),
    registryError ? text(notice(registryError), { color: "red" }) : null,
    message ? text(notice(message), { color: "yellow" }) : null,
    h(Box, { marginTop: 1, flexDirection: "column" },
      detail ? detailLines.slice(Math.min(scroll, maxScroll), Math.min(scroll, maxScroll) + pageSize).map((value, i) => text(value, { key: i }))
      : projects.length ? [
        columns < 60 ? text("项目 · 自动同步 · 文件状态", { key: "header", dimColor: true })
          : h(Box, { key: "header" }, h(Box, { flexGrow: 1, flexBasis: 0 }, text("项目", { dimColor: true })),
            h(Box, { width: 12 }, text("自动同步", { dimColor: true })), h(Box, { width: 14 }, text("文件状态", { dimColor: true }))),
        ...projects.slice(offset, offset + pageSize).map(project => {
          const selectedRow = project.root === selected?.root;
          const labels = rowLabels(project);
          return columns < 60 ? text(`${selectedRow ? "›" : " "} ${display(project.name)} · ${labels.manager} · ${labels.sync}`, { key: project.root, color: selectedRow ? "cyan" : undefined, wrap: "truncate-end" })
            : h(Box, { key: project.root },
              h(Box, { flexGrow: 1, flexBasis: 0 }, text(`${selectedRow ? "›" : " "} ${display(project.name)}`, { color: selectedRow ? "cyan" : undefined, wrap: "truncate-end" })),
              h(Box, { width: 12 }, text(labels.manager)), h(Box, { width: 14 }, text(labels.sync)));
        }),
      ] : line("尚无项目。按 a 添加已有项目；之后 init/config/start 成功时会自动登记。")),
    !detail && selected ? h(Box, { marginTop: 1, flexDirection: "column" }, text(display(selected.root), { dimColor: true, wrap: "truncate-middle" }),
      text(display(selected.target || selected.error?.message || "等待状态查询…"), { dimColor: true, wrap: "truncate-end" })) : null,
    h(Box, { marginTop: 1, flexDirection: "column" },
      line(detail ? "↑↓ 滚动  Enter/Esc 返回  q 退出" : "↑↓ 选择  Enter 详情  s 开启  x 停止  r 刷新", { dimColor: true }),
      !detail ? line("a 添加  c 配置  l 重新定位  d 移除记录  q 退出", { dimColor: true }) : null,
      text("退出面板不会停止后台同步。", { dimColor: true })));
}

export async function dashboardView(model, options = {}) {
  let action = { type: "quit" }, instance;
  instance = render(h(Panel, { model, ...options, onAction: value => { action = value; instance.unmount(); } }),
    { alternateScreen: true, exitOnCtrlC: false, patchConsole: false, interactive: true, maxFps: 10 });
  options.onMount?.(instance);
  try { await instance.waitUntilExit(); return action; }
  finally { instance.unmount(); instance.cleanup(); options.onMount?.(null); }
}
