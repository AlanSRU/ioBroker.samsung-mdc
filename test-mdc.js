#!/usr/bin/env node
/*
 * Standalone Samsung MDC field probe — no adapter, no build, no deps.
 *
 * Validates a panel over TCP 1515 before installing the ioBroker adapter.
 * Deliberately self-contained (reimplements the framing from src/lib/mdc.ts)
 * so it runs anywhere with just `node test-mdc.js`, and prints RAW frames so
 * first-contact deviations from the spec are visible.
 *
 * Usage:
 *   node test-mdc.js <ip>                     # full read: status + power/vol/mute/input
 *   node test-mdc.js <ip> status
 *   node test-mdc.js <ip> power on|off
 *   node test-mdc.js <ip> volume <0-100>
 *   node test-mdc.js <ip> mute on|off
 *   node test-mdc.js <ip> input <HDMI1|HDMI2|DisplayPort|DVI|PC|TV|MagicInfo|0xNN>
 *   node test-mdc.js <ip> discover            # probe set IDs 0, 1, 254(0xFE)
 *   node test-mdc.js <ip> wake <mac>          # send a Wake-on-LAN packet
 *
 * Options: --id <n> (default 0)   --port <n> (default 1515)   --raw (hex dump)
 */
'use strict';
const net = require('node:net');
const dgram = require('node:dgram');

const CMD = { STATUS: 0x00, POWER: 0x11, VOLUME: 0x12, MUTE: 0x13, INPUT: 0x14 };
const INPUTS = { HDMI1: 0x21, HDMI2: 0x23, DisplayPort: 0x25, MagicInfo: 0x60 };
const INPUT_NAMES = Object.fromEntries(Object.entries(INPUTS).map(([k, v]) => [v, k]));

const argv = process.argv.slice(2);
const opts = { id: 0, port: 1515, raw: false };
const pos = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') {
        opts.id = parseInt(argv[++i], 10);
    } else if (argv[i] === '--port') {
        opts.port = parseInt(argv[++i], 10);
    } else if (argv[i] === '--raw') {
        opts.raw = true;
    } else {
        pos.push(argv[i]);
    }
}
const [ip, command = 'read', ...rest] = pos;
if (!ip) {
    console.error('Usage: node test-mdc.js <ip> [command] [args]  (see header for commands)');
    process.exit(1);
}

const hex = buf => Array.from(buf, b => b.toString(16).padStart(2, '0')).join(' ');

function buildFrame(cmd, id, data) {
    const body = [cmd, id, data.length, ...data];
    const checksum = body.reduce((a, b) => a + b, 0) & 0xff;
    return Buffer.from([0xaa, ...body, checksum]);
}

// Send one command, resolve { ack, cmd, data } or reject.
function request(cmd, data = [], id = opts.id) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        const chunks = [];
        let done = false;
        const finish = (err, val) => {
            if (done) {
                return;
            }
            done = true;
            socket.destroy();
            err ? reject(err) : resolve(val);
        };
        socket.setTimeout(4000, () => finish(new Error('timeout (no response in 4s)')));
        socket.on('error', finish);
        socket.on('data', chunk => {
            chunks.push(chunk);
            const buf = Buffer.concat(chunks);
            if (buf.length < 4) {
                return;
            }
            if (buf[0] !== 0xaa) {
                return finish(new Error(`bad header 0x${buf[0].toString(16)}`));
            }
            const total = 4 + buf[3] + 1;
            if (buf.length < total) {
                return;
            }
            const frame = buf.subarray(0, total);
            if (opts.raw) {
                console.log(`  <- ${hex(frame)}`);
            }
            const sum = frame.subarray(1, total - 1).reduce((a, b) => a + b, 0) & 0xff;
            if (sum !== frame[total - 1]) {
                return finish(new Error('checksum mismatch'));
            }
            finish(null, { ack: frame[4], cmd: frame[5], data: Array.from(frame.subarray(6, total - 1)) });
        });
        socket.connect(opts.port, ip, () => {
            const frame = buildFrame(cmd, id, data);
            if (opts.raw) {
                console.log(`  -> ${hex(frame)}`);
            }
            socket.write(frame);
        });
    });
}

const ok = r => (r.ack === 0x41 ? 'ACK' : `NAK(0x${r.ack.toString(16)})`);

async function readAll() {
    console.log(`\nMDC probe  ${ip}:${opts.port}  set id ${opts.id}\n`);
    const s = await request(CMD.STATUS);
    if (s.ack !== 0x41) {
        console.log(`STATUS -> ${ok(s)}  (panel reachable but refused; check Set ID / MDC settings)`);
        return;
    }
    const [power, volume, mute, input] = s.data;
    console.log(`  power        ${power === 1 ? 'ON' : 'off'}`);
    console.log(`  volume       ${volume}`);
    console.log(`  mute         ${mute === 1 ? 'ON' : 'off'}`);
    console.log(`  input        0x${(input ?? 0).toString(16)}  ${INPUT_NAMES[input] || '(unknown code)'}`);
    console.log(`  raw status   [${s.data.join(', ')}]`);
    console.log(`\n✓ MDC works on this panel. Adapter config: IP ${ip}, port ${opts.port}, display id ${opts.id}.`);
}

async function discover() {
    console.log(`\nProbing set IDs on ${ip}:${opts.port} ...\n`);
    for (const id of [0, 1, 254]) {
        try {
            const r = await request(CMD.STATUS, [], id);
            console.log(
                `  id ${String(id).padStart(3)}  ${ok(r)}  ${r.ack === 0x41 ? `power=${r.data[0]} vol=${r.data[1]} input=0x${(r.data[3] || 0).toString(16)}` : ''}`,
            );
        } catch (e) {
            console.log(`  id ${String(id).padStart(3)}  -- ${e.message}`);
        }
    }
}

function wake(mac) {
    return new Promise((resolve, reject) => {
        const b = mac.split(/[:-]/).map(h => parseInt(h, 16));
        if (b.length !== 6 || b.some(Number.isNaN)) {
            return reject(new Error(`bad MAC: ${mac}`));
        }
        const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(b))]);
        const sock = dgram.createSocket('udp4');
        sock.once('error', e => (sock.close(), reject(e)));
        sock.bind(() => {
            sock.setBroadcast(true);
            sock.send(pkt, 9, '255.255.255.255', err => (sock.close(), err ? reject(err) : resolve()));
        });
    });
}

(async () => {
    try {
        switch (command) {
            case 'read':
                await readAll();
                break;
            case 'status': {
                const r = await request(CMD.STATUS);
                console.log(`STATUS ${ok(r)}  data=[${r.data.join(', ')}]`);
                break;
            }
            case 'power': {
                const r = await request(CMD.POWER, [rest[0] === 'on' ? 1 : 0]);
                console.log(`POWER ${rest[0]} -> ${ok(r)}`);
                break;
            }
            case 'volume': {
                const r = await request(CMD.VOLUME, [Math.max(0, Math.min(100, parseInt(rest[0], 10)))]);
                console.log(`VOLUME ${rest[0]} -> ${ok(r)}`);
                break;
            }
            case 'mute': {
                const r = await request(CMD.MUTE, [rest[0] === 'on' ? 1 : 0]);
                console.log(`MUTE ${rest[0]} -> ${ok(r)}`);
                break;
            }
            case 'input': {
                const code = rest[0] in INPUTS ? INPUTS[rest[0]] : parseInt(rest[0], 16);
                const r = await request(CMD.INPUT, [code & 0xff]);
                console.log(`INPUT ${rest[0]} (0x${code.toString(16)}) -> ${ok(r)}`);
                break;
            }
            case 'discover':
                await discover();
                break;
            case 'wake':
                await wake(rest[0]);
                console.log(`WoL packet sent to ${rest[0]}`);
                break;
            default:
                console.error(`unknown command "${command}"`);
                process.exit(1);
        }
    } catch (e) {
        console.error(`\n✗ ${e.message}`);
        console.error(
            '  Checks: panel powered/network-standby on, on the LAN, port 1515 open, MDC/network control enabled, correct Set ID (try: discover).',
        );
        process.exit(1);
    }
})();
