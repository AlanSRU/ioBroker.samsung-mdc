/*
 * Created with @iobroker/create-adapter v3.1.5
 *
 * ioBroker adapter for Samsung commercial signage displays via the MDC
 * protocol (TCP 1515). Provides power, input-source, volume and mute control
 * plus status polling, with optional Wake-on-LAN for cold power-on.
 *
 * One instance handles any number of displays: each configured display gets its
 * own device folder, MDC client and poll timer. MDC opens a fresh socket per
 * request, so panels are polled independently — a dead panel does not stall the
 * others.
 */
import * as utils from '@iobroker/adapter-core';
import { MdcClient } from './lib/mdc';
import { expandScanRange, scanForPanels } from './lib/scan';
import { wake } from './lib/wol';

/*
 * Human-readable input source name -> MDC source code. Models vary; edit to taste.
 * Verified on a QB43C: HDMI1, HDMI2 and MagicInfo ACK; the legacy PC (0x14),
 * DVI (0x18) and TV (0x40) codes NAK, as do HDMI1_PC (0x22) and HDMI2_PC (0x24).
 * DisplayPort is kept for the larger C-series panels that carry the connector.
 */
const INPUT_SOURCES: Record<string, number> = {
    HDMI1: 0x21,
    HDMI2: 0x23,
    DisplayPort: 0x25,
    MagicInfo: 0x60,
};

/** Object ids that belong to the instance itself and cannot name a display. */
const RESERVED_IDS = ['info'];

/** Consecutive failed polls before a display that was answering counts as offline. */
const OFFLINE_AFTER = 2;

/**
 * After a power-on command the MDC service restarts and stays silent for about
 * 30 s (measured 28-31 s on a QB43C). Poll failures in this window are expected
 * and do not count against the display.
 */
const POWER_ON_GRACE_MS = 45_000;

/** Delay before the status read that follows a command. */
const REFRESH_DELAY_MS = 600;

/** One row of the display table in the instance configuration. */
interface DeviceConfig {
    enabled?: boolean;
    name?: string;
    ipAddress?: string;
    port?: number;
    displayId?: number;
    macAddress?: string;
}

/** A configured display and its runtime state. */
interface Panel {
    /** object-tree id, e.g. "pitch_west" */
    id: string;
    /** display name shown in the object tree */
    label: string;
    ipAddress: string;
    macAddress: string;
    client: MdcClient;
    polling: boolean;
    /** a refresh was requested while a poll was running */
    refreshPending: boolean;
    connected: boolean;
    /** consecutive failed polls */
    failures: number;
    /** last poll error logged as a warning, so a repeating one is logged once */
    lastPollError?: string;
    /** poll failures before this time (ms) are expected: the panel is booting */
    graceUntil: number;
    pollTimer?: ioBroker.Timeout;
}

class SamsungMdc extends utils.Adapter {
    private panels = new Map<string, Panel>();
    /** object ids of configured but disabled displays, whose objects are kept */
    private disabledIds = new Set<string>();
    /** poll interval in ms; 0 disables polling */
    private pollInterval = 0;
    private scanning = false;
    private stopped = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'samsung-mdc',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        this.buildPanels();
        await this.removeStaleObjects();
        for (const panel of this.panels.values()) {
            await this.createPanelObjects(panel);
        }
        for (const id of this.disabledIds) {
            // not polled while disabled, so do not leave it looking reachable
            if (await this.getObjectAsync(`${id}.info.connection`)) {
                await this.setState(`${id}.info.connection`, { val: false, ack: true });
            }
        }
        if (this.stopped) {
            return;
        }
        if (!this.panels.size) {
            this.log.warn('No displays configured — open the instance settings and add at least one display.');
            return;
        }
        this.subscribeStates('*');

        // 0 disables polling; otherwise 5 s (above the 4 s request timeout) to 1 h
        const seconds = Number(this.config.pollingInterval) || 0;
        this.pollInterval = seconds > 0 ? Math.min(3600, Math.max(5, seconds)) * 1000 : 0;
        let stagger = 0;
        for (const panel of this.panels.values()) {
            // spread the panels out so a fleet does not poll in one burst
            this.schedulePoll(panel, stagger);
            stagger += 250;
        }
    }

    /** Turn the configured display table into runtime panels. */
    private buildPanels(): void {
        const devices = (this.config.devices ?? []) as unknown as DeviceConfig[];
        for (const device of devices) {
            const ip = (device.ipAddress || '').trim();
            if (!ip) {
                this.log.warn(`Ignoring display "${device.name || '(unnamed)'}": no IP address configured.`);
                continue;
            }
            const label = (device.name || '').trim() || ip;
            const id = this.makeId(label);
            if (device.enabled === false) {
                // keep its objects (and their history/alias settings) for when it is re-enabled
                this.disabledIds.add(id);
                continue;
            }
            const port = Number(device.port) || 1515;
            const displayId = Number(device.displayId) || 0;
            this.panels.set(id, {
                id,
                label,
                ipAddress: ip,
                macAddress: (device.macAddress || '').trim(),
                client: new MdcClient(ip, port, displayId),
                polling: false,
                refreshPending: false,
                connected: false,
                failures: 0,
                graceUntil: 0,
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
    private makeId(label: string): string {
        const base =
            label
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, '_')
                .replace(/^_+|_+$/g, '') || 'display';
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
    private async removeStaleObjects(): Promise<void> {
        for (const obj of await this.getDevicesAsync()) {
            const id = obj._id.substring(this.namespace.length + 1);
            if (!id.includes('.') && !this.panels.has(id) && !this.disabledIds.has(id)) {
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
    private async createPanelObjects(panel: Panel): Promise<void> {
        await this.extendObject(panel.id, {
            type: 'device',
            common: { name: panel.label },
            native: {},
        });
        for (const [id, name] of [
            ['info', 'Information'],
            ['control', 'Control'],
            ['media', 'Media'],
        ] as const) {
            await this.extendObject(`${panel.id}.${id}`, {
                type: 'channel',
                common: { name },
                native: {},
            });
        }

        await this.extendObject(`${panel.id}.info.connection`, {
            type: 'state',
            common: {
                name: 'Display connected',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.extendObject(`${panel.id}.control.power`, {
            type: 'state',
            common: { name: 'Power', type: 'boolean', role: 'switch.power', read: true, write: true, def: false },
            native: {},
        });
        await this.extendObject(`${panel.id}.control.input`, {
            type: 'state',
            common: {
                name: 'Input source',
                type: 'number',
                role: 'media.input',
                read: true,
                write: true,
                states: Object.fromEntries(Object.entries(INPUT_SOURCES).map(([name, code]) => [code, name])),
            },
            native: {},
        });
        await this.extendObject(`${panel.id}.media.volume`, {
            type: 'state',
            common: {
                name: 'Volume',
                type: 'number',
                role: 'level.volume',
                min: 0,
                max: 100,
                unit: '%',
                read: true,
                write: true,
            },
            native: {},
        });
        await this.extendObject(`${panel.id}.media.mute`, {
            type: 'state',
            common: { name: 'Mute', type: 'boolean', role: 'media.mute', read: true, write: true, def: false },
            native: {},
        });
    }

    /**
     * Poll one display for its combined status and reflect it into the state tree.
     *
     * @param panel - the display to poll
     */
    private async poll(panel: Panel): Promise<void> {
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
                // a panel in standby always reports mute=1, which says nothing about the audio
                await this.setState(`${panel.id}.media.mute`, { val: s.mute, ack: true });
            }
            panel.failures = 0;
            panel.graceUntil = 0;
            await this.setConnected(panel, true);
        } catch (error) {
            const message = (error as Error).message;
            if (this.stopped) {
                return;
            }
            if (Date.now() < panel.graceUntil) {
                this.log.debug(`[${panel.label}] status poll failed while the display starts up: ${message}`);
                return;
            }
            // A display that was answering goes offline only after OFFLINE_AFTER failures in a row,
            // and a repeating error is logged as a warning once, not on every poll.
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
            // re-arm only now, so a slow poll (timeouts) can never overlap the next one
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
    private schedulePoll(panel: Panel, delayMs: number): void {
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
    private refreshSoon(panel: Panel): void {
        if (panel.polling) {
            panel.refreshPending = true; // the running poll schedules it when it finishes
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
    private async setConnected(panel: Panel, connected: boolean): Promise<void> {
        if (panel.connected !== connected) {
            this.log.info(`[${panel.label}] ${connected ? 'connected' : 'not reachable'}`);
            if (connected) {
                panel.lastPollError = undefined;
            }
        }
        panel.connected = connected;
        await this.setState(`${panel.id}.info.connection`, { val: connected, ack: true });
        const any = [...this.panels.values()].some(p => p.connected);
        await this.setState('info.connection', { val: any, ack: true });
    }

    /**
     * Switch a display on or off. Power-on wakes it first when Wake-on-LAN is
     * enabled, applies the default volume, and opens the start-up grace window.
     *
     * @param panel - the display
     * @param on - true to power on
     */
    private async setPower(panel: Panel, on: boolean): Promise<void> {
        if (!on) {
            await panel.client.setPower(false);
            return;
        }
        if (this.config.useWol && panel.macAddress) {
            await wake(panel.macAddress).catch(e =>
                this.log.warn(`[${panel.label}] Wake-on-LAN failed: ${(e as Error).message}`),
            );
        }
        // a timed-out power-on often still takes effect, so allow for the restart either way
        panel.graceUntil = Date.now() + POWER_ON_GRACE_MS;
        await panel.client.setPower(true);
        const dv = this.config.defaultVolume;
        if (dv !== '' && dv !== null && dv !== undefined && !Number.isNaN(Number(dv))) {
            await panel.client.setVolume(Number(dv)).catch(() => undefined);
        }
    }

    /**
     * Is called if a subscribed state changes.
     *
     * @param id - State ID
     * @param state - State object
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }
        const rel = id.substring(`${this.namespace}.`.length);
        const separator = rel.indexOf('.');
        const panel = separator > 0 ? this.panels.get(rel.substring(0, separator)) : undefined;
        if (!panel) {
            return;
        }
        const key = rel.substring(separator + 1);
        try {
            switch (key) {
                case 'control.power':
                    await this.setPower(panel, Boolean(state.val));
                    break;
                case 'control.input':
                    await panel.client.setInput(Number(state.val));
                    break;
                case 'media.volume':
                    await panel.client.setVolume(Number(state.val));
                    break;
                case 'media.mute':
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
            // a timed-out write can still have taken effect: the refresh below shows the outcome
            this.log.warn(`[${panel.label}] command "${key}" failed: ${(error as Error).message}`);
        }
        this.refreshSoon(panel);
    }

    /**
     * Pick the display a message is aimed at: by id, configured name or IP
     * address, or the only configured display if the message names none.
     *
     * @param device - the "device" field of the message
     */
    private resolvePanel(device: unknown): Panel | undefined {
        if (typeof device !== 'string' || !device.trim()) {
            return this.panels.size === 1 ? [...this.panels.values()][0] : undefined;
        }
        const wanted = device.trim().toLowerCase();
        return [...this.panels.values()].find(
            p => p.id.toLowerCase() === wanted || p.label.toLowerCase() === wanted || p.ipAddress === wanted,
        );
    }

    /**
     * Handle sendTo messages so other adapters/scripts can drive the displays,
     * and serve the "search for displays" button of the admin UI.
     * Requires "common.messagebox": true in io-package.json.
     *
     * @param obj - the incoming message
     */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (typeof obj !== 'object' || !obj.command) {
            return;
        }
        const reply = (response: unknown): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, response as ioBroker.MessagePayload, obj.callback);
            }
        };
        const msg = (obj.message ?? {}) as Record<string, unknown>;

        if (obj.command === 'discover') {
            reply(await this.discover(typeof msg.range === 'string' ? msg.range : ''));
            return;
        }

        const panel = this.resolvePanel(msg.device);
        if (!panel) {
            const known = [...this.panels.keys()].join(', ') || 'none';
            reply({ error: `no display selected — pass "device" with one of: ${known}` });
            return;
        }
        try {
            switch (obj.command) {
                case 'getStatus':
                    reply(await panel.client.getStatus());
                    break;
                case 'power':
                    await this.setPower(panel, Boolean(msg.value));
                    reply({ ok: true });
                    break;
                case 'input':
                    await panel.client.setInput(Number(msg.value));
                    reply({ ok: true });
                    break;
                case 'volume':
                    await panel.client.setVolume(Number(msg.value));
                    reply({ ok: true });
                    break;
                case 'mute':
                    await panel.client.setMute(Boolean(msg.value));
                    reply({ ok: true });
                    break;
                default:
                    reply({ error: `unknown command "${obj.command}"` });
                    return;
            }
        } catch (error) {
            reply({ error: (error as Error).message });
        }
        if (obj.command !== 'getStatus') {
            this.refreshSoon(panel);
        }
    }

    /**
     * Sweep an address range for panels answering MDC and merge the hits into
     * the configured display table, which the admin UI then offers to save.
     *
     * @param range - address range to probe (see expandScanRange)
     */
    private async discover(range: string): Promise<Record<string, unknown>> {
        if (this.scanning) {
            return { error: 'a search is already running' };
        }
        let hosts: string[];
        try {
            hosts = expandScanRange(range);
        } catch (error) {
            return { error: (error as Error).message };
        }
        if (!hosts.length) {
            return { error: 'no addresses to search — enter a range such as 192.168.230.0/24' };
        }

        this.scanning = true;
        try {
            this.log.info(`Searching ${hosts.length} address(es) for MDC displays...`);
            const hits = await scanForPanels({ hosts, port: 1515, displayId: 0 });
            const devices = [...((this.config.devices ?? []) as unknown as DeviceConfig[])];
            const known = new Set(devices.map(d => `${(d.ipAddress || '').trim()}:${Number(d.port) || 1515}`));
            let added = 0;
            for (const hit of hits) {
                this.log.info(
                    `Found a display at ${hit.ipAddress}:${hit.port} (power ${hit.status.power ? 'on' : 'off'}, ` +
                        `input 0x${hit.status.input.toString(16)}, volume ${hit.status.volume})`,
                );
                if (known.has(`${hit.ipAddress}:${hit.port}`)) {
                    continue;
                }
                devices.push({
                    enabled: true,
                    name: '',
                    ipAddress: hit.ipAddress,
                    port: hit.port,
                    displayId: hit.displayId,
                    macAddress: '',
                });
                added++;
            }
            this.log.info(`Search finished: ${hits.length} display(s) answered, ${added} added to the table.`);
            return {
                native: { ...this.config, devices, scanRange: range },
                saveConfig: true,
                result: `${hits.length} display(s) found, ${added} added`,
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
    private onUnload(callback: () => void): void {
        this.stopped = true;
        try {
            for (const panel of this.panels.values()) {
                if (panel.pollTimer) {
                    this.clearTimeout(panel.pollTimer);
                }
            }
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${(error as Error).message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new SamsungMdc(options);
} else {
    // otherwise start the instance directly
    (() => new SamsungMdc())();
}
