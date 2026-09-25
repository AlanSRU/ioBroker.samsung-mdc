"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_mdc = require("./lib/mdc");
var import_scan = require("./lib/scan");
var import_wol = require("./lib/wol");
const INPUT_SOURCES = {
  HDMI1: 33,
  HDMI2: 35,
  DisplayPort: 37,
  MagicInfo: 96
};
const RESERVED_IDS = ["info"];
const OFFLINE_AFTER = 2;
const POWER_ON_GRACE_MS = 45e3;
const REFRESH_DELAY_MS = 600;
class SamsungMdc extends utils.Adapter {
  panels = /* @__PURE__ */ new Map();
  /** object ids of configured but disabled displays, whose objects are kept */
  disabledIds = /* @__PURE__ */ new Set();
  /** poll interval in ms; 0 disables polling */
  pollInterval = 0;
  scanning = false;
  stopped = false;
  constructor(options = {}) {
    super({
      ...options,
      name: "samsung-mdc"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
    this.buildPanels();
    await this.removeStaleObjects();
    for (const panel of this.panels.values()) {
      await this.createPanelObjects(panel);
    }
    for (const id of this.disabledIds) {
      if (await this.getObjectAsync(`${id}.info.connection`)) {
        await this.setState(`${id}.info.connection`, { val: false, ack: true });
      }
    }
    if (this.stopped) {
      return;
    }
    if (!this.panels.size) {
      this.log.warn("No displays configured \u2014 open the instance settings and add at least one display.");
      return;
    }
    this.subscribeStates("*");
    const seconds = Number(this.config.pollingInterval) || 0;
    this.pollInterval = seconds > 0 ? Math.min(3600, Math.max(5, seconds)) * 1e3 : 0;
    let stagger = 0;
    for (const panel of this.panels.values()) {
      this.schedulePoll(panel, stagger);
      stagger += 250;
    }
  }
  /** Turn the configured display table into runtime panels. */
  buildPanels() {
    var _a;
    const devices = (_a = this.config.devices) != null ? _a : [];
    for (const device of devices) {
      const ip = (device.ipAddress || "").trim();
      if (!ip) {
        this.log.warn(`Ignoring display "${device.name || "(unnamed)"}": no IP address configured.`);
        continue;
      }
      const label = (device.name || "").trim() || ip;
      const id = this.makeId(label);
      if (device.enabled === false) {
        this.disabledIds.add(id);
        continue;
      }
      const port = Number(device.port) || 1515;
      const displayId = Number(device.displayId) || 0;
      this.panels.set(id, {
        id,
        label,
        ipAddress: ip,
        macAddress: (device.macAddress || "").trim(),
        client: new import_mdc.MdcClient(ip, port, displayId),
        polling: false,
        refreshPending: false,
        connected: false,
        failures: 0,
        graceUntil: 0
      });
      this.log.info(`Display "${label}" -> ${this.namespace}.${id} (${ip}:${port}, set ID ${displayId})`);
    }
  }
  /**
   * Derive a unique object id from a display name. Lower case, so that names
   * differing only in case do not fork into two object trees.
   *
   * @param label - display name or IP address
   */
  makeId(label) {
    const base = label.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "display";
    let id = RESERVED_IDS.includes(base) ? `${base}_display` : base;
    for (let suffix = 2; this.panels.has(id) || this.disabledIds.has(id); suffix++) {
      id = `${base}_${suffix}`;
    }
    return id;
  }
  /**
   * Delete the device folders of displays that were removed from the table or
   * renamed. Disabled displays keep theirs.
   */
  async removeStaleObjects() {
    for (const obj of await this.getDevicesAsync()) {
      const id = obj._id.substring(this.namespace.length + 1);
      if (!id.includes(".") && !this.panels.has(id) && !this.disabledIds.has(id)) {
        this.log.info(`Removing objects of display "${id}", which is no longer configured.`);
        await this.delObjectAsync(id, { recursive: true });
      }
    }
  }
  /**
   * Create the object tree of one display.
   *
   * @param panel - the display
   */
  async createPanelObjects(panel) {
    await this.extendObject(panel.id, {
      type: "device",
      common: { name: panel.label },
      native: {}
    });
    for (const [id, name] of [
      ["info", "Information"],
      ["control", "Control"],
      ["media", "Media"]
    ]) {
      await this.extendObject(`${panel.id}.${id}`, {
        type: "channel",
        common: { name },
        native: {}
      });
    }
    await this.extendObject(`${panel.id}.info.connection`, {
      type: "state",
      common: {
        name: "Display connected",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false
      },
      native: {}
    });
    await this.extendObject(`${panel.id}.control.power`, {
      type: "state",
      common: { name: "Power", type: "boolean", role: "switch.power", read: true, write: true, def: false },
      native: {}
    });
    await this.extendObject(`${panel.id}.control.input`, {
      type: "state",
      common: {
        name: "Input source",
        type: "number",
        role: "media.input",
        read: true,
        write: true,
        states: Object.fromEntries(Object.entries(INPUT_SOURCES).map(([name, code]) => [code, name]))
      },
      native: {}
    });
    await this.extendObject(`${panel.id}.media.volume`, {
      type: "state",
      common: {
        name: "Volume",
        type: "number",
        role: "level.volume",
        min: 0,
        max: 100,
        unit: "%",
        read: true,
        write: true
      },
      native: {}
    });
    await this.extendObject(`${panel.id}.media.mute`, {
      type: "state",
      common: { name: "Mute", type: "boolean", role: "media.mute", read: true, write: true, def: false },
      native: {}
    });
  }
  /**
   * Poll one display for its combined status and reflect it into the state tree.
   *
   * @param panel - the display to poll
   */
  async poll(panel) {
    if (panel.polling || this.stopped) {
      return;
    }
    panel.polling = true;
    try {
      const s = await panel.client.getStatus();
      if (this.stopped) {
        return;
      }
      await this.setState(`${panel.id}.control.power`, { val: s.power, ack: true });
      await this.setState(`${panel.id}.control.input`, { val: s.input, ack: true });
      await this.setState(`${panel.id}.media.volume`, { val: s.volume, ack: true });
      if (s.power) {
        await this.setState(`${panel.id}.media.mute`, { val: s.mute, ack: true });
      }
      panel.failures = 0;
      panel.graceUntil = 0;
      await this.setConnected(panel, true);
    } catch (error) {
      const message = error.message;
      if (this.stopped) {
        return;
      }
      if (Date.now() < panel.graceUntil) {
        this.log.debug(`[${panel.label}] status poll failed while the display starts up: ${message}`);
        return;
      }
      const confirmed = ++panel.failures >= OFFLINE_AFTER || !panel.connected;
      if (confirmed && message !== panel.lastPollError) {
        this.log.warn(`[${panel.label}] status poll failed: ${message}`);
        panel.lastPollError = message;
      } else {
        this.log.debug(`[${panel.label}] status poll failed: ${message}`);
      }
      if (confirmed) {
        await this.setConnected(panel, false);
      }
    } finally {
      panel.polling = false;
      if (panel.refreshPending) {
        panel.refreshPending = false;
        this.schedulePoll(panel, REFRESH_DELAY_MS);
      } else if (this.pollInterval) {
        this.schedulePoll(panel, this.pollInterval);
      }
    }
  }
  /**
   * Replace the display's pending poll with one after the given delay.
   *
   * @param panel - the display
   * @param delayMs - delay before polling
   */
  schedulePoll(panel, delayMs) {
    if (this.stopped) {
      return;
    }
    if (panel.pollTimer) {
      this.clearTimeout(panel.pollTimer);
    }
    panel.pollTimer = this.setTimeout(() => void this.poll(panel), delayMs);
  }
  /**
   * Read the display back shortly after a command, so the tree reflects reality.
   *
   * @param panel - the display
   */
  refreshSoon(panel) {
    if (panel.polling) {
      panel.refreshPending = true;
    } else {
      this.schedulePoll(panel, REFRESH_DELAY_MS);
    }
  }
  /**
   * Track the reachability of one display; info.connection of the instance
   * reports whether any display is answering.
   *
   * @param panel - the display
   * @param connected - whether it just answered
   */
  async setConnected(panel, connected) {
    if (panel.connected !== connected) {
      this.log.info(`[${panel.label}] ${connected ? "connected" : "not reachable"}`);
      if (connected) {
        panel.lastPollError = void 0;
      }
    }
    panel.connected = connected;
    await this.setState(`${panel.id}.info.connection`, { val: connected, ack: true });
    const any = [...this.panels.values()].some((p) => p.connected);
    await this.setState("info.connection", { val: any, ack: true });
  }
  /**
   * Switch a display on or off. Power-on wakes it first when Wake-on-LAN is
   * enabled, applies the default volume, and opens the start-up grace window.
   *
   * @param panel - the display
   * @param on - true to power on
   */
  async setPower(panel, on) {
    if (!on) {
      await panel.client.setPower(false);
      return;
    }
    if (this.config.useWol && panel.macAddress) {
      await (0, import_wol.wake)(panel.macAddress).catch(
        (e) => this.log.warn(`[${panel.label}] Wake-on-LAN failed: ${e.message}`)
      );
    }
    panel.graceUntil = Date.now() + POWER_ON_GRACE_MS;
    await panel.client.setPower(true);
    const dv = this.config.defaultVolume;
    if (dv !== "" && dv !== null && dv !== void 0 && !Number.isNaN(Number(dv))) {
      await panel.client.setVolume(Number(dv)).catch(() => void 0);
    }
  }
  /**
   * Is called if a subscribed state changes.
   *
   * @param id - State ID
   * @param state - State object
   */
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const rel = id.substring(`${this.namespace}.`.length);
    const separator = rel.indexOf(".");
    const panel = separator > 0 ? this.panels.get(rel.substring(0, separator)) : void 0;
    if (!panel) {
      return;
    }
    const key = rel.substring(separator + 1);
    try {
      switch (key) {
        case "control.power":
          await this.setPower(panel, Boolean(state.val));
          break;
        case "control.input":
          await panel.client.setInput(Number(state.val));
          break;
        case "media.volume":
          await panel.client.setVolume(Number(state.val));
          break;
        case "media.mute":
          await panel.client.setMute(Boolean(state.val));
          break;
        default:
          this.log.warn(`Unhandled writable state: ${id}`);
          return;
      }
      if (!this.stopped) {
        await this.setState(id, { val: state.val, ack: true });
      }
    } catch (error) {
      this.log.warn(`[${panel.label}] command "${key}" failed: ${error.message}`);
    }
    this.refreshSoon(panel);
  }
  /**
   * Pick the display a message is aimed at: by id, configured name or IP
   * address, or the only configured display if the message names none.
   *
   * @param device - the "device" field of the message
   */
  resolvePanel(device) {
    if (typeof device !== "string" || !device.trim()) {
      return this.panels.size === 1 ? [...this.panels.values()][0] : void 0;
    }
    const wanted = device.trim().toLowerCase();
    return [...this.panels.values()].find(
      (p) => p.id.toLowerCase() === wanted || p.label.toLowerCase() === wanted || p.ipAddress === wanted
    );
  }
  /**
   * Handle sendTo messages so other adapters/scripts can drive the displays,
   * and serve the "search for displays" button of the admin UI.
   * Requires "common.messagebox": true in io-package.json.
   *
   * @param obj - the incoming message
   */
  async onMessage(obj) {
    var _a;
    if (typeof obj !== "object" || !obj.command) {
      return;
    }
    const reply = (response) => {
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, response, obj.callback);
      }
    };
    const msg = (_a = obj.message) != null ? _a : {};
    if (obj.command === "discover") {
      reply(await this.discover(typeof msg.range === "string" ? msg.range : ""));
      return;
    }
    const panel = this.resolvePanel(msg.device);
    if (!panel) {
      const known = [...this.panels.keys()].join(", ") || "none";
      reply({ error: `no display selected \u2014 pass "device" with one of: ${known}` });
      return;
    }
    try {
      switch (obj.command) {
        case "getStatus":
          reply(await panel.client.getStatus());
          break;
        case "power":
          await this.setPower(panel, Boolean(msg.value));
          reply({ ok: true });
          break;
        case "input":
          await panel.client.setInput(Number(msg.value));
          reply({ ok: true });
          break;
        case "volume":
          await panel.client.setVolume(Number(msg.value));
          reply({ ok: true });
          break;
        case "mute":
          await panel.client.setMute(Boolean(msg.value));
          reply({ ok: true });
          break;
        default:
          reply({ error: `unknown command "${obj.command}"` });
          return;
      }
    } catch (error) {
      reply({ error: error.message });
    }
    if (obj.command !== "getStatus") {
      this.refreshSoon(panel);
    }
  }
  /**
   * Sweep an address range for panels answering MDC and merge the hits into
   * the configured display table, which the admin UI then offers to save.
   *
   * @param range - address range to probe (see expandScanRange)
   */
  async discover(range) {
    var _a;
    if (this.scanning) {
      return { error: "a search is already running" };
    }
    let hosts;
    try {
      hosts = (0, import_scan.expandScanRange)(range);
    } catch (error) {
      return { error: error.message };
    }
    if (!hosts.length) {
      return { error: "no addresses to search \u2014 enter a range such as 192.168.230.0/24" };
    }
    this.scanning = true;
    try {
      this.log.info(`Searching ${hosts.length} address(es) for MDC displays...`);
      const hits = await (0, import_scan.scanForPanels)({ hosts, port: 1515, displayId: 0 });
      const devices = [...(_a = this.config.devices) != null ? _a : []];
      const known = new Set(devices.map((d) => `${(d.ipAddress || "").trim()}:${Number(d.port) || 1515}`));
      let added = 0;
      for (const hit of hits) {
        this.log.info(
          `Found a display at ${hit.ipAddress}:${hit.port} (power ${hit.status.power ? "on" : "off"}, input 0x${hit.status.input.toString(16)}, volume ${hit.status.volume})`
        );
        if (known.has(`${hit.ipAddress}:${hit.port}`)) {
          continue;
        }
        devices.push({
          enabled: true,
          name: "",
          ipAddress: hit.ipAddress,
          port: hit.port,
          displayId: hit.displayId,
          macAddress: ""
        });
        added++;
      }
      this.log.info(`Search finished: ${hits.length} display(s) answered, ${added} added to the table.`);
      return {
        native: { ...this.config, devices, scanRange: range },
        saveConfig: true,
        result: `${hits.length} display(s) found, ${added} added`
      };
    } finally {
      this.scanning = false;
    }
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    this.stopped = true;
    try {
      for (const panel of this.panels.values()) {
        if (panel.pollTimer) {
          this.clearTimeout(panel.pollTimer);
        }
      }
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new SamsungMdc(options);
} else {
  (() => new SamsungMdc())();
}
//# sourceMappingURL=main.js.map
