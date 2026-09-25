"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var scan_exports = {};
__export(scan_exports, {
  MAX_SCAN_HOSTS: () => MAX_SCAN_HOSTS,
  expandScanRange: () => expandScanRange,
  scanForPanels: () => scanForPanels
});
module.exports = __toCommonJS(scan_exports);
var import_mdc = require("./mdc");
const MAX_SCAN_HOSTS = 4096;
const ipToLong = (ip) => {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    throw new Error(`invalid IP address: ${ip}`);
  }
  return parts.reduce((acc, part) => {
    const octet = Number(part);
    if (!/^\d{1,3}$/.test(part) || octet > 255) {
      throw new Error(`invalid IP address: ${ip}`);
    }
    return acc * 256 + octet;
  }, 0);
};
const longToIp = (value) => [value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255].join(".");
function expandScanRange(spec) {
  const found = /* @__PURE__ */ new Set();
  for (const token of spec.split(/[,\s]+/).filter(Boolean)) {
    let first;
    let last;
    if (token.includes("/")) {
      const [base, bitsText] = token.split("/");
      const bits = Number(bitsText);
      if (!/^\d{1,2}$/.test(bitsText) || bits > 32) {
        throw new Error(`invalid CIDR prefix: ${token}`);
      }
      const size = 2 ** (32 - bits);
      const network = Math.floor(ipToLong(base) / size) * size;
      first = size > 2 ? network + 1 : network;
      last = size > 2 ? network + size - 2 : network + size - 1;
    } else if (token.includes("-")) {
      const [from, to] = token.split("-");
      first = ipToLong(from);
      last = to.includes(".") ? ipToLong(to) : ipToLong(`${from.split(".").slice(0, 3).join(".")}.${to}`);
      if (last < first) {
        throw new Error(`range ends before it starts: ${token}`);
      }
    } else {
      first = last = ipToLong(token);
    }
    if (found.size + (last - first + 1) > MAX_SCAN_HOSTS) {
      throw new Error(`scan range covers more than ${MAX_SCAN_HOSTS} addresses \u2014 narrow it down`);
    }
    for (let value = first; value <= last; value++) {
      found.add(value);
    }
  }
  return [...found].sort((a, b) => a - b).map(longToIp);
}
async function scanForPanels(options) {
  const { hosts, port, displayId, timeoutMs = 1500, concurrency = 32 } = options;
  const hits = new Array(hosts.length);
  let cursor = 0;
  const worker = async () => {
    for (let index = cursor++; index < hosts.length; index = cursor++) {
      const ipAddress = hosts[index];
      try {
        const status = await new import_mdc.MdcClient(ipAddress, port, displayId, timeoutMs).getStatus();
        hits[index] = { ipAddress, port, displayId, status };
      } catch {
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, () => worker()));
  return hits.filter((hit) => hit !== void 0);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_SCAN_HOSTS,
  expandScanRange,
  scanForPanels
});
//# sourceMappingURL=scan.js.map
