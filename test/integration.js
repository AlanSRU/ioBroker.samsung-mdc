const path = require('path');
const { createServer } = require('node:net');
const { expect } = require('chai');
const { tests } = require('@iobroker/testing');

/**
 * A fake MDC display: answers STATUS with its current state and applies
 * POWER / VOLUME / MUTE / INPUT writes, so command round trips can be asserted.
 */
function startFakePanel(port, state) {
    const server = createServer(socket => {
        socket.on('data', request => {
            const command = request[1];
            const data = request.subarray(4, 4 + request[3]);
            if (command === 0x11) state.power = data[0] === 1;
            if (command === 0x12) state.volume = data[0];
            if (command === 0x13) state.mute = data[0] === 1;
            if (command === 0x14) state.input = data[0];
            const body = [
                0xff,
                request[2],
                0x09,
                0x41,
                command,
                state.power ? 1 : 0,
                state.volume,
                state.mute ? 1 : 0,
                state.input,
                0x10,
                0x00,
                0x00,
            ];
            const checksum = body.reduce((sum, b) => sum + b, 0) & 0xff;
            socket.write(Buffer.from([0xaa, ...body, checksum]));
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

const getState = (harness, id) =>
    new Promise((resolve, reject) => harness.states.getState(id, (err, state) => (err ? reject(err) : resolve(state))));

const getObject = (harness, id) =>
    new Promise((resolve, reject) => harness.objects.getObject(id, (err, obj) => (err ? reject(err) : resolve(obj))));

const setState = (harness, id, val) =>
    new Promise((resolve, reject) =>
        harness.states.setState(id, { val, ack: false }, err => (err ? reject(err) : resolve())),
    );

/** Poll a state until the predicate holds, so tests do not depend on exact timing. */
async function waitForState(harness, id, predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await getState(harness, id);
        if (last && predicate(last)) {
            return last;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${id} did not reach the expected value in ${timeoutMs} ms (last: ${JSON.stringify(last)})`);
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('multiple displays', getHarness => {
            const west = { power: true, volume: 42, mute: false, input: 0x21 };
            const tunnel = { power: false, volume: 7, mute: true, input: 0x23 };
            const panels = [];

            before(async function () {
                this.timeout(30000);
                panels.push(await startFakePanel(15515, west));
                panels.push(await startFakePanel(15516, tunnel));
                // answers on the default MDC port so the discovery sweep can find it
                panels.push(await startFakePanel(1515, west));

                const harness = getHarness();
                await harness.changeAdapterConfig(harness.adapterName, {
                    native: {
                        devices: [
                            { enabled: true, name: 'Pitch West', ipAddress: '127.0.0.1', port: 15515, displayId: 0 },
                            { enabled: true, name: 'Tunnel', ipAddress: '127.0.0.1', port: 15516, displayId: 0 },
                            { enabled: false, name: 'Spare', ipAddress: '127.0.0.1', port: 15517, displayId: 0 },
                        ],
                        pollingInterval: 5,
                    },
                });
                await harness.enableSendTo();
                await harness.startAdapterAndWait(true);
            });

            after(async () => {
                await Promise.all(panels.map(server => new Promise(resolve => server.close(resolve))));
            });

            it('creates one device folder per configured display', async function () {
                this.timeout(30000);
                const harness = getHarness();
                expect((await getObject(harness, 'samsung-mdc.0.pitch_west')).type).to.equal('device');
                expect((await getObject(harness, 'samsung-mdc.0.tunnel')).type).to.equal('device');
                expect(await getObject(harness, 'samsung-mdc.0.spare')).to.be.not.ok;
                expect(await getObject(harness, 'samsung-mdc.0.control')).to.be.not.ok;
            });

            it('polls every display independently', async function () {
                this.timeout(30000);
                const harness = getHarness();
                await waitForState(harness, 'samsung-mdc.0.pitch_west.info.connection', s => s.val === true);
                await waitForState(harness, 'samsung-mdc.0.tunnel.info.connection', s => s.val === true);
                expect((await getState(harness, 'samsung-mdc.0.pitch_west.media.volume')).val).to.equal(42);
                expect((await getState(harness, 'samsung-mdc.0.pitch_west.control.power')).val).to.equal(true);
                expect((await getState(harness, 'samsung-mdc.0.tunnel.media.volume')).val).to.equal(7);
                expect((await getState(harness, 'samsung-mdc.0.tunnel.control.power')).val).to.equal(false);
            });

            it('sends a command to the addressed display only', async function () {
                this.timeout(30000);
                const harness = getHarness();
                await setState(harness, 'samsung-mdc.0.tunnel.media.volume', 15);
                await waitForState(harness, 'samsung-mdc.0.tunnel.media.volume', s => s.val === 15 && s.ack === true);
                expect(tunnel.volume).to.equal(15);
                expect(west.volume).to.equal(42);
            });

            it('routes sendTo commands by display', async function () {
                this.timeout(30000);
                const harness = getHarness();
                const status = await new Promise(resolve =>
                    harness.sendTo('samsung-mdc.0', 'getStatus', { device: 'pitch_west' }, resolve),
                );
                expect(status.volume).to.equal(42);
                const missing = await new Promise(resolve =>
                    harness.sendTo('samsung-mdc.0', 'getStatus', { device: 'nope' }, resolve),
                );
                expect(missing.error).to.contain('no display selected');
            });

            it('finds panels with the discovery sweep', async function () {
                this.timeout(60000);
                const harness = getHarness();
                const result = await new Promise(resolve =>
                    harness.sendTo('samsung-mdc.0', 'discover', { range: '127.0.0.1' }, resolve),
                );
                expect(result.error).to.be.undefined;
                expect(result.result).to.contain('1 display(s) found');
                const added = result.native.devices.filter(d => d.port === 1515);
                expect(added).to.have.lengthOf(1);
                expect(added[0].ipAddress).to.equal('127.0.0.1');
                // the displays already configured must survive the merge
                expect(result.native.devices).to.have.lengthOf(4);
            });
        });

        suite('object housekeeping', getHarness => {
            const setObject = (harness, id, obj) =>
                new Promise((resolve, reject) =>
                    harness.objects.setObject(id, obj, err => (err ? reject(err) : resolve())),
                );

            before(async function () {
                this.timeout(30000);
                const harness = getHarness();
                // objects left by an earlier run: "tunnel" is now disabled, "gone" was deleted from the table
                for (const id of ['tunnel', 'gone']) {
                    await setObject(harness, `samsung-mdc.0.${id}`, {
                        type: 'device',
                        common: { name: id },
                        native: {},
                    });
                    await setObject(harness, `samsung-mdc.0.${id}.media`, {
                        type: 'channel',
                        common: { name: 'Media' },
                        native: {},
                    });
                    await setObject(harness, `samsung-mdc.0.${id}.media.volume`, {
                        type: 'state',
                        common: { name: 'Volume', type: 'number', role: 'level.volume', read: true, write: true },
                        native: {},
                    });
                }
                await harness.changeAdapterConfig(harness.adapterName, {
                    native: {
                        devices: [
                            { enabled: false, name: 'Tunnel', ipAddress: '127.0.0.1', port: 15516, displayId: 0 },
                        ],
                    },
                });
                await harness.startAdapterAndWait();
            });

            it('keeps the objects of a disabled display and removes those of a deleted one', async function () {
                this.timeout(30000);
                const harness = getHarness();
                const deadline = Date.now() + 20000;
                while ((await getObject(harness, 'samsung-mdc.0.gone')) && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                expect(await getObject(harness, 'samsung-mdc.0.gone')).to.be.not.ok;
                expect(await getObject(harness, 'samsung-mdc.0.gone.media.volume')).to.be.not.ok;
                expect((await getObject(harness, 'samsung-mdc.0.tunnel.media.volume')).type).to.equal('state');
            });
        });
    },
});
