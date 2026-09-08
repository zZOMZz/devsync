import path from "node:path";
import { validateRemoteField } from "./core.mjs";
import { identityPath } from "./ssh-transport.mjs";

// Prompt rendering and connection checks are supplied by the caller. Legacy
// ask(message, secret) callers remain supported alongside structured prompts.
export async function configureConnection(ask, previous = null, previousAuth = {}, {
  root = process.cwd(), aliases = [], resolve = async () => ({}), select,
  probe = async () => ({}), checkPath = async () => {}, log = console.log,
} = {}) {
  const old = previous?.remote || {};
  const draft = { ...previous };
  const fieldError = (field, answer) => {
    try { validateRemoteField(field, field === "port" ? Number(answer) : answer); }
    catch (error) { return error.message; }
  };
  const value = async (field, label, fallback) => {
    while (true) {
      let answer = (await ask(`${label}${fallback ? ` [${fallback}]` : ""}：`, false, {
        message: label, initialValue: String(fallback ?? ""), validate: input => fieldError(field, input || fallback),
      })) || fallback;
      if (field === "port") answer = Number(answer);
      try { validateRemoteField(field, answer); return answer; }
      catch (error) { log(error.message); }
    }
  };
  const choose = async (message, options, initialValue, legacy) => {
    if (select) return select({ message, options, initialValue });
    while (true) {
      const answer = (await ask(legacy)) || initialValue;
      if (options.some(option => option.value === answer)) return answer;
    }
  };
  let host;
  if (select && aliases.length) {
    const hosts = [...new Set([...(old.host ? [old.host] : []), ...aliases])];
    host = await choose("选择开发机", [...hosts.map(value => ({ value, label: value })), { value: "", label: "手动输入地址" }], old.host || (hosts.length === 1 ? hosts[0] : ""));
  } else if (aliases.length) log(`可用 SSH 别名：${aliases.join("、")}`);
  host ||= await value("host", "开发机地址或 SSH 别名", old.host || (aliases.length === 1 ? aliases[0] : undefined));
  const defaults = await resolve(host);
  let username = await value("username", "开发机账号", old.host === host ? old.username : defaults.username);
  let port = await value("port", "SSH 端口", old.host === host ? old.port : defaults.port || 22);
  let auth = {}, home;
  let identityFile = previous?.identityFile || "";
  let method = previousAuth.password ? "2" : previous?.identityFile && process.platform !== "win32" ? "3" : "1";
  let needAuth = true, allowSavedPassword = true;
  while (true) {
    if (needAuth) {
      const methods = [{ value: "1", label: "SSH config / agent", hint: "使用已有 SSH 配置或密钥" },
        ...(process.platform === "win32" ? [] : [{ value: "3", label: "指定私钥文件", hint: "仅对当前项目生效" }]),
        { value: "2", label: "密码" }];
      method = await choose("认证方式", methods, method, `认证方式：1 SSH 密钥/agent，2 密码${process.platform === "win32" ? "" : "，3 指定私钥"} [${method}]：`);
      auth = {};
      delete draft.identityFile;
      if (method === "3") {
        while (true) {
          const fallback = identityFile;
          const validate = input => { try { identityPath(root, { identityFile: input || fallback }); } catch (error) { return error.message; } };
          const identity = (await ask(`私钥文件路径${fallback ? ` [${fallback}]` : ""}：`, false,
            { message: "私钥文件路径", initialValue: fallback, validate })) || fallback;
          const error = validate(identity);
          if (error) { log(error); continue; }
          draft.identityFile = identity;
          identityFile = identity;
          break;
        }
      }
      if (method === "2") {
        const canKeep = allowSavedPassword && old.host === host && old.username === username &&
          old.port === port && Boolean(previousAuth.password);
        let password;
        do {
          const message = canKeep ? "开发机密码（回车保留原密码）" : "开发机密码";
          password = await ask(message + "：", true, { message,
            validate: input => !input && !canKeep ? "请输入密码。" : undefined });
          if (!password && canKeep) password = previousAuth.password;
        } while (!password);
        auth = { password };
      }
    }
    try {
      if (!select) log("正在验证 SSH 连接和认证…");
      ({ home } = await probe({ ...draft, remote: { host, username, port } }, auth));
      break;
    } catch (error) {
      log(error.message);
      if (!error.field) throw error;
      let field = error.field;
      if (field === "connection") {
        const answer = await choose("选择需要修正的项目", [
          { value: "5", label: "网络恢复后重试" }, { value: "1", label: "地址" },
          { value: "2", label: "端口" }, { value: "3", label: "账号" }, { value: "4", label: "认证" },
        ], "5", "修正项：1 地址，2 端口，3 账号，4 认证，5 网络恢复后重试 [5]：");
        field = { 1: "host", 2: "port", 3: "username", 4: "auth", 5: "retry" }[answer];
      }
      needAuth = field === "auth";
      if (field === "auth") allowSavedPassword = false;
      if (field === "host") host = await value("host", "开发机地址或 SSH 别名", host);
      if (field === "port") port = await value("port", "SSH 端口", port);
      if (field === "username") username = await value("username", "开发机账号", username);
      if (["host", "port", "username"].includes(field) && auth.password) {
        needAuth = true;
        allowSavedPassword = false;
      }
    }
  }
  let remotePath = old.path && host === old.host && username === old.username && port === old.port
    ? old.path : path.posix.join(home || `/home/${username}`, path.basename(root));
  while (true) {
    remotePath = await value("path", "远端项目绝对路径", remotePath);
    const cfg = { ...draft, remote: { host, username, port, path: remotePath } };
    try { await checkPath(cfg, auth); return { cfg, auth }; }
    catch (error) { if (error.field !== "path") throw error; log(error.message); }
  }
}
