#!/usr/bin/env node
"use strict";

// 云端同步设备轮换工具。
//
// 背景：免费 / 已过期档的 Cloud 同步只有一个活跃设备槽位（machine_limit=1），
// 上传额度按账号计算（每天一次）。多台异地设备想轮流同步时，需要定期把槽位
// 从当前设备切到下一台：先暂停当前设备，再恢复目标设备。服务端的
// remove-device 实际是把设备置为 paused（历史数据保留），可随时换回。
//
// 用法：
//   node scripts/rotate-cloud-devices.cjs --every-days 1 --dry-run
//   node scripts/rotate-cloud-devices.cjs --every-days 2 --force
//   node scripts/rotate-cloud-devices.cjs --devices <id1>,<id2> --every-days 1
//
// 轮换后默认触发一次本机云上传（--sync，--no-sync 关闭）；只有本机是活跃设备
// 时才会上传，被暂停的机器会打印跳过原因。
//
// 凭据直接从本地 dashboard 服务（默认 127.0.0.1:7681）的已登录会话换取，
// 不落盘、不打印。

const fs = require("node:fs");
const path = require("node:path");
const { resolveTrackerPaths } = require("../src/lib/tracker-paths");

const DEFAULT_SERVER = process.env.TOKENTRACKER_LOCAL_SERVER || "http://127.0.0.1:7681";
const STATE_FILE = "cloud-device-rotation.json";
const LOG_FILE = "cloud-device-rotation.log";
const DAY_MS = 24 * 60 * 60 * 1000;

function usage() {
  return [
    "用法: node scripts/rotate-cloud-devices.cjs [选项]",
    "",
    "选项:",
    "  --every-days <n>   每 n 天轮换一台设备（默认沿用状态文件，否则 1）",
    "  --devices <ids>    显式指定轮换顺序（逗号分隔的 machine_id），未列出的设备追加在后",
    "  --parity-even <x>  奇偶模式：本地日期为偶数日时激活的设备（machine_id 或设备名）",
    "  --parity-odd <x>   奇偶模式：本地日期为奇数日时激活的设备（machine_id 或设备名）",
    "  --force            忽略时间间隔，立即轮换一次",
    "  --dry-run          只打印计划，不调用任何修改接口",
    "  --sync             轮换后自动上传本机待同步数据（默认开启）",
    "  --no-sync          关闭自动上传，只切换设备槽位",
    "  --server <url>     本地 dashboard 地址（默认 " + DEFAULT_SERVER + "）",
    "  --state <path>     状态文件路径（默认 ~/.tokentracker/tracker/" + STATE_FILE + "）",
    "  -h, --help         显示本帮助",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    everyDays: null,
    devices: [],
    evenDevice: null,
    oddDevice: null,
    force: false,
    dryRun: false,
    sync: true,
    server: DEFAULT_SERVER,
    statePath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--every-days") args.everyDays = Number(argv[++i]);
    else if (token === "--devices") args.devices = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (token === "--parity-even") args.evenDevice = String(argv[++i] || "").trim() || null;
    else if (token === "--parity-odd") args.oddDevice = String(argv[++i] || "").trim() || null;
    else if (token === "--force") args.force = true;
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--sync") args.sync = true;
    else if (token === "--no-sync") args.sync = false;
    else if (token === "--server") args.server = String(argv[++i] || "");
    else if (token === "--state") args.statePath = argv[++i] || null;
    else if (token === "-h" || token === "--help") args.help = true;
    else throw new Error(`未知参数: ${token}`);
  }
  if (args.everyDays !== null && (!Number.isFinite(args.everyDays) || args.everyDays < 1)) {
    throw new Error("--every-days 必须是 >= 1 的数字");
  }
  if (Boolean(args.evenDevice) !== Boolean(args.oddDevice)) {
    throw new Error("--parity-even 与 --parity-odd 必须同时提供");
  }
  args.server = String(args.server || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(args.server)) throw new Error("--server 必须是 http(s) 地址");
  return args;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(statePath, value) {
  const tmpPath = `${statePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, statePath);
}

// 本地日期（不是 UTC），用于奇偶模式与日志。
function localDateKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { res, data, text };
}

async function resolveCloudSession(server) {
  const authRes = await fetchJson(`${server}/api/local-auth`);
  const localToken = authRes.data?.token;
  if (!authRes.res.ok || !localToken) throw new Error("本地服务未返回 local-auth，确认 dashboard 服务正在运行");

  const refreshRes = await fetchJson(`${server}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const accessToken = refreshRes.data?.accessToken || refreshRes.data?.access_token;
  if (!refreshRes.res.ok || !accessToken) throw new Error("无法从本地服务换取 access token（浏览器可能未登录云账户）");

  const runtimeRes = await fetch(`${server}/api/runtime-config.js`);
  const runtimeSource = await runtimeRes.text();
  if (!runtimeRes.ok) throw new Error("无法读取本地 runtime-config");
  const jsonText = runtimeSource.slice(runtimeSource.indexOf("=") + 1).trim().replace(/;$/, "");
  const runtime = JSON.parse(jsonText);
  if (!runtime?.baseUrl || !runtime?.anonKey) throw new Error("runtime-config 缺少 baseUrl 或 anonKey");

  return {
    localToken,
    accessToken,
    baseUrl: String(runtime.baseUrl).replace(/\/+$/, ""),
    anonKey: runtime.anonKey,
  };
}

function decodeJwtSub(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return "";
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload?.sub === "string" ? payload.sub : "";
  } catch {
    return "";
  }
}

// 用本地服务持有的登录态换一次设备会话。本机被暂停时服务端会返回
// cloud_machine_paused，这里视为"不是本机轮次"而不是错误。
async function bridgeDeviceSession(session, server) {
  const ownerId = decodeJwtSub(session.accessToken);
  if (!ownerId) return { skipped: true, reason: "auth_invalid" };
  const { res, data } = await fetchJson(`${server}/functions/tokentracker-cloud-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-tokentracker-local-auth": session.localToken,
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({ expectedOwnerId: ownerId, insforgeBaseUrl: session.baseUrl }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok || !data?.session_id) return { skipped: true, reason: data?.code || `HTTP ${res.status}` };
  return { skipped: false, sessionId: data.session_id, ownerId };
}

async function runLocalCloudSync({ server, session, log }) {
  const bridge = await bridgeDeviceSession(session, server);
  if (bridge.skipped) {
    const notActive = ["cloud_machine_paused", "cloud_machine_limit", "auth_rejected"].includes(bridge.reason);
    log(notActive
      ? `云同步跳过：本机当前不是活跃设备（${bridge.reason}）`
      : `云同步跳过：${bridge.reason}`);
    return;
  }
  const { res, data } = await fetchJson(`${server}/functions/tokentracker-local-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-tokentracker-local-auth": session.localToken,
    },
    body: JSON.stringify({
      cloudSessionId: bridge.sessionId,
      expectedOwnerId: bridge.ownerId,
      insforgeBaseUrl: session.baseUrl,
      drain: true,
      auto: true,
    }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) {
    const code = data?.code || `HTTP ${res.status}`;
    if (res.status === 429) {
      log(`云同步受限：今日额度已用完${data?.next_allowed_at ? `，next_allowed_at=${data.next_allowed_at}` : ""}`);
      return;
    }
    if (["auth_session_changed", "auth_session_required", "CLOUD_SYNC_DISABLED"].includes(code)) {
      log(`云同步跳过：${code}`);
      return;
    }
    throw new Error(`local-sync 失败: ${code}`);
  }
  log(`云同步完成：uploaded=${data?.uploaded === true} pending=${data?.pending === true}${data?.next_allowed_at ? ` next_allowed_at=${data.next_allowed_at}` : ""}`);
}

// 上传失败不应影响已经完成的槽位轮换，只记录并在下一次任务重试。
async function syncAfterRotation(args, session, log) {
  if (!args.sync || args.dryRun) return;
  try {
    await runLocalCloudSync({ server: args.server, session, log });
  } catch (error) {
    log(`云同步失败：${error.message}`);
  }
}

async function billingRequest(session, action, { method = "GET", body } = {}) {
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    Accept: "application/json",
    apikey: session.anonKey,
  };
  if (body) headers["Content-Type"] = "application/json";
  const { res, data, text } = await fetchJson(`${session.baseUrl}/functions/tokentracker-billing?action=${encodeURIComponent(action)}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok || data?.ok === false || (data?.error && res.status !== 202)) {
    const code = data?.code || data?.error || `HTTP ${res.status}`;
    const error = new Error(`${action} 失败: ${code}`);
    error.code = code;
    error.status = res.status;
    error.detail = data || text;
    throw error;
  }
  return data;
}

function resolveRotationOrder(machines, state, requested) {
  const present = machines.map((m) => m.machine_id);
  const requestedValid = requested.filter((id) => present.includes(id));
  if (requested.length > 0 && requestedValid.length !== requested.length) {
    const missing = requested.filter((id) => !present.includes(id));
    throw new Error(`--devices 中的设备不存在: ${missing.join(", ")}`);
  }
  const base = requestedValid.length > 0
    ? requestedValid
    : Array.isArray(state?.order) ? state.order.filter((id) => present.includes(id)) : [];
  // 未显式列出的设备按服务端返回顺序（创建时间升序）追加，保证顺序稳定。
  return [...base, ...present.filter((id) => !base.includes(id))];
}

function resolveDeviceByRef(machines, ref) {
  const needle = String(ref || "").trim().toLowerCase();
  if (!needle) return null;
  return machines.find((m) => m.machine_id === String(ref).trim())
    || machines.find((m) => String(m.name || "").trim().toLowerCase() === needle)
    || null;
}

function formatTime(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : String(iso || "?");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const { trackerDir } = await resolveTrackerPaths();
  const statePath = args.statePath || path.join(trackerDir, STATE_FILE);
  const logPath = path.join(trackerDir, LOG_FILE);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(logPath, `${line}\n`, "utf8");
    } catch {
      /* 日志不可写不影响轮换 */
    }
  };

  const lockPath = `${statePath}.lock`;
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      log("跳过：另一个轮换进程正在运行");
      return;
    }
    throw error;
  }

  try {
    const state = readJson(statePath);
    const everyDays = args.everyDays ?? (Number(state?.everyDays) >= 1 ? Number(state.everyDays) : 1);
    const session = await resolveCloudSession(args.server);
    const listing = await billingRequest(session, "devices");
    const machines = Array.isArray(listing?.machines) ? listing.machines : [];
    if (machines.length < 2) {
      log(`仅注册了 ${machines.length} 台设备，无需轮换`);
      await syncAfterRotation(args, session, log);
      return;
    }

    // 奇偶模式：按本地日期把槽位写死给指定设备。判定基于"今天是几号"，
    // 不做时间差累计，任务漏跑后下一次运行会自动纠正到当天的目标设备。
    if (args.evenDevice && args.oddDevice) {
      const evenMachine = resolveDeviceByRef(machines, args.evenDevice);
      const oddMachine = resolveDeviceByRef(machines, args.oddDevice);
      if (!evenMachine) throw new Error(`未找到偶数日设备: ${args.evenDevice}`);
      if (!oddMachine) throw new Error(`未找到奇数日设备: ${args.oddDevice}`);
      if (evenMachine.machine_id === oddMachine.machine_id) throw new Error("偶数日与奇数日不能是同一台设备");
      const dayOfMonth = new Date().getDate();
      const isOddDay = dayOfMonth % 2 === 1;
      const target = isOddDay ? oddMachine : evenMachine;
      const activeNow = machines.filter((m) => m.status === "active");
      log(`本地 ${localDateKey()}（${dayOfMonth} 号）为${isOddDay ? "奇" : "偶"}数日，目标设备: ${target.name || target.machine_id}`);
      if (activeNow.length === 1 && activeNow[0].machine_id === target.machine_id) {
        log("当前活跃设备已是目标设备，无需切换");
        await syncAfterRotation(args, session, log);
        return;
      }
      if (args.dryRun) {
        for (const machine of activeNow) {
          if (machine.machine_id !== target.machine_id) log(`[dry-run] 将暂停设备 ${machine.name || machine.machine_id}`);
        }
        log(`[dry-run] 将恢复设备 ${target.name || target.machine_id}`);
        log("[dry-run] 未调用任何修改接口");
        return;
      }
      const paused = [];
      for (const machine of activeNow) {
        if (machine.machine_id === target.machine_id) continue;
        await billingRequest(session, "remove-device", { method: "POST", body: { machine_id: machine.machine_id } });
        paused.push(machine);
        log(`已暂停设备 ${machine.name || machine.machine_id}`);
      }
      try {
        await billingRequest(session, "resume-device", { method: "POST", body: { machine_id: target.machine_id } });
      } catch (error) {
        // 恢复失败时把已暂停的设备恢复回去，避免账号没有活跃设备。
        for (const machine of paused) {
          try {
            await billingRequest(session, "resume-device", { method: "POST", body: { machine_id: machine.machine_id } });
            log(`恢复 ${target.name || target.machine_id} 失败，已回滚为 ${machine.name || machine.machine_id}`);
          } catch {
            log(`回滚 ${machine.name || machine.machine_id} 也失败，请到 设置 → 云服务 手动恢复`);
          }
        }
        throw error;
      }
      log(`已恢复设备 ${target.name || target.machine_id}`);
      const after = await billingRequest(session, "devices");
      const afterMachines = Array.isArray(after?.machines) ? after.machines : [];
      const activeAfter = afterMachines.filter((m) => m.status === "active");
      log(`校验：目标状态=${afterMachines.find((m) => m.machine_id === target.machine_id)?.status || "unknown"}，活跃设备数=${activeAfter.length}`);
      writeState(statePath, {
        version: 1,
        mode: "parity",
        evenDeviceId: evenMachine.machine_id,
        oddDeviceId: oddMachine.machine_id,
        lastAppliedDate: localDateKey(),
        lastActiveMachineId: target.machine_id,
      });
      await syncAfterRotation(args, session, log);
      return;
    }

    const order = resolveRotationOrder(machines, state, args.devices);
    const active = machines.filter((m) => m.status === "active");
    const byId = new Map(machines.map((m) => [m.machine_id, m]));
    const now = Date.now();

    const previousActiveId = active[0]?.machine_id
      || (state?.lastActiveMachineId && byId.has(state.lastActiveMachineId) ? state.lastActiveMachineId : null);
    const previousIndex = previousActiveId ? order.indexOf(previousActiveId) : -1;
    const nextId = order[(previousIndex + 1) % order.length];
    const nextMachine = byId.get(nextId);

    log(`设备顺序: ${order.map((id) => byId.get(id)?.name || id).join(" -> ")}`);
    log(`当前活跃: ${previousActiveId ? (byId.get(previousActiveId)?.name || previousActiveId) : "无"}；下一台: ${nextMachine?.name || nextId}`);

    const lastRotatedAt = Date.parse(state?.lastRotatedAt || "");
    const dueAt = Number.isFinite(lastRotatedAt) ? lastRotatedAt + everyDays * DAY_MS : 0;
    const due = args.force || !state || now >= dueAt;
    if (!due) {
      log(`未到轮换时间：每 ${everyDays} 天一次，下次 ${formatTime(new Date(dueAt).toISOString())}`);
      await syncAfterRotation(args, session, log);
      return;
    }

    if (!nextId || nextId === previousActiveId) {
      log("目标设备与当前活跃设备相同，跳过");
      await syncAfterRotation(args, session, log);
      return;
    }

    if (args.dryRun) {
      if (previousActiveId) log(`[dry-run] 将暂停设备 ${byId.get(previousActiveId)?.name || previousActiveId}`);
      log(`[dry-run] 将恢复设备 ${nextMachine?.name || nextId}`);
      log("[dry-run] 未调用任何修改接口");
      return;
    }

    if (previousActiveId) {
      await billingRequest(session, "remove-device", { method: "POST", body: { machine_id: previousActiveId } });
      log(`已暂停设备 ${byId.get(previousActiveId)?.name || previousActiveId}`);
    }

    try {
      await billingRequest(session, "resume-device", { method: "POST", body: { machine_id: nextId } });
    } catch (error) {
      // 恢复失败时把原设备恢复回活跃状态，避免账号出现"没有活跃设备"的空档。
      if (previousActiveId) {
        try {
          await billingRequest(session, "resume-device", { method: "POST", body: { machine_id: previousActiveId } });
          log(`恢复 ${nextMachine?.name || nextId} 失败，已回滚为原设备 ${byId.get(previousActiveId)?.name || previousActiveId}`);
        } catch (rollbackError) {
          log(`恢复失败且回滚失败：${rollbackError.message}；请到 设置 → 云服务 手动恢复设备`);
        }
      }
      throw error;
    }
    log(`已恢复设备 ${nextMachine?.name || nextId}`);

    const after = await billingRequest(session, "devices");
    const afterMachines = Array.isArray(after?.machines) ? after.machines : [];
    const target = afterMachines.find((m) => m.machine_id === nextId);
    const activeAfter = afterMachines.filter((m) => m.status === "active");
    log(`校验：目标状态=${target?.status || "unknown"}，活跃设备数=${activeAfter.length}`);

    const nextState = {
      version: 1,
      everyDays,
      order,
      lastRotatedAt: new Date(now).toISOString(),
      lastActiveMachineId: nextId,
    };
    writeState(statePath, nextState);
    log(`下次轮换时间：${formatTime(new Date(now + everyDays * DAY_MS).toISOString())}（每 ${everyDays} 天）`);
    await syncAfterRotation(args, session, log);
  } finally {
    try { fs.closeSync(lockFd); } catch { /* 已关闭 */ }
    try { fs.unlinkSync(lockPath); } catch { /* 锁文件可能已不存在 */ }
  }
}

main().catch(async (error) => {
  console.error(`[rotate-cloud-devices] ${error.message}`);
  if (error.detail) console.error(JSON.stringify(error.detail));
  // 计划任务下没有可见控制台，失败原因必须落到日志文件里。
  try {
    const { trackerDir } = await resolveTrackerPaths();
    fs.appendFileSync(path.join(trackerDir, LOG_FILE), `[${new Date().toISOString()}] 失败: ${error.message}\n`, "utf8");
  } catch {
    /* 日志不可写时只保留 stderr */
  }
  process.exitCode = 1;
});
