import path from "node:path";
import { validateRemoteField } from "./core.mjs";

// No configuration or credentials are persisted until validation and confirmation finish.
export async function configureConnection(ask, previous = null, previousAuth = {}, {
  root = process.cwd(), aliases = [], resolve = async () => ({}),
  probe = async () => ({}), checkPath = async () => {}, log = console.log,
} = {}) {
  const old = previous?.remote || {};
  const value = async (field, label, fallback) => {
    while (true) {
      let answer = (await ask(`${label}${fallback ? ` [${fallback}]` : ""}：`)) || fallback;
      if (field === "port") answer = Number(answer);
      try { validateRemoteField(field, answer); return answer; }
      catch (error) { log(error.message); }
    }
  };
  if (aliases.length) log(`可用 SSH 别名：${aliases.join("、")}`);
  let host = await value("host", "开发机地址或 SSH 别名", old.host || (aliases.length === 1 ? aliases[0] : undefined));
  const defaults = await resolve(host);
  let username = await value("username", "开发机账号", old.host === host ? old.username : defaults.username);
  let port = await value("port", "SSH 端口", old.host === host ? old.port : defaults.port || 22);
  let auth = {}, home;
  let method = previousAuth.password ? "2" : "1";
  let needAuth = true, allowSavedPassword = true;
  while (true) {
    if (needAuth) {
      do {
        method = (await ask(`认证方式：1 SSH 密钥/agent，2 密码 [${method}]：`)) || method;
      } while (!["1", "2"].includes(method));
      auth = {};
      if (method === "2") {
        const canKeep = allowSavedPassword && old.host === host && old.username === username &&
          old.port === port && Boolean(previousAuth.password);
        let password;
        do {
          password = await ask(canKeep ? "开发机密码（隐藏输入，回车保留原密码）：" : "开发机密码（隐藏输入，必须填写）：", true);
          if (!password && canKeep) password = previousAuth.password;
        } while (!password);
        auth = { password };
      }
    }
    try {
      log("正在验证 SSH 连接和认证…");
      ({ home } = await probe({ ...previous, remote: { host, username, port } }, auth));
      break;
    } catch (error) {
      log(error.message);
      if (!error.field) throw error;
      let field = error.field;
      if (field === "connection") {
        let answer;
        do { answer = (await ask("修正项：1 地址，2 端口，3 账号，4 认证，5 网络恢复后重试 [5]：")) || "5"; }
        while (!["1", "2", "3", "4", "5"].includes(answer));
        field = { 1: "host", 2: "port", 3: "username", 4: "auth", 5: "retry" }[answer];
      }
      needAuth = field === "auth";
      if (field === "auth") allowSavedPassword = false;
      if (field === "host") {
        host = await value("host", "开发机地址或 SSH 别名", host);
      }
      if (field === "port") port = await value("port", "SSH 端口", port);
      if (field === "username") {
        username = await value("username", "开发机账号", username);
        needAuth = true;
        allowSavedPassword = false;
      }
    }
  }
  const defaultPath = old.path && host === old.host && username === old.username && port === old.port
    ? old.path : path.posix.join(home || `/home/${username}`, path.basename(root));
  let remotePath = defaultPath;
  while (true) {
    remotePath = await value("path", "远端项目绝对路径", remotePath);
    const cfg = { ...previous, remote: { host, username, port, path: remotePath } };
    try { await checkPath(cfg, auth); return { cfg, auth }; }
    catch (error) { if (error.field !== "path") throw error; log(error.message); }
  }
}
