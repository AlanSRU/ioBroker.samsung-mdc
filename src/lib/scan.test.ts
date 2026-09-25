import { expect } from 'chai';
import { createServer, type Server } from 'node:net';
import { expandScanRange, MAX_SCAN_HOSTS, scanForPanels } from './scan';

describe('scan => expandScanRange', () => {
    it('expands a single address', () => {
        expect(expandScanRange('192.168.230.200')).to.deep.equal(['192.168.230.200']);
    });

    it('expands a /24 without network and broadcast addresses', () => {
        const hosts = expandScanRange('192.168.230.0/24');
        expect(hosts).to.have.lengthOf(254);
        expect(hosts[0]).to.equal('192.168.230.1');
        expect(hosts[253]).to.equal('192.168.230.254');
    });

    it('aligns a CIDR block to its network address', () => {
        expect(expandScanRange('192.168.230.77/30')).to.deep.equal(['192.168.230.77', '192.168.230.78']);
    });

    it('expands a last-octet range', () => {
        expect(expandScanRange('192.168.230.10-12')).to.deep.equal([
            '192.168.230.10',
            '192.168.230.11',
            '192.168.230.12',
        ]);
    });

    it('expands a range that crosses a /24 boundary', () => {
        expect(expandScanRange('192.168.230.254-192.168.231.1')).to.deep.equal([
            '192.168.230.254',
            '192.168.230.255',
            '192.168.231.0',
            '192.168.231.1',
        ]);
    });

    it('merges comma-separated tokens and removes duplicates', () => {
        expect(expandScanRange('192.168.230.5, 192.168.230.5 192.168.230.4')).to.deep.equal([
            '192.168.230.4',
            '192.168.230.5',
        ]);
    });

    it('ignores an empty specification', () => {
        expect(expandScanRange('   ')).to.deep.equal([]);
    });

    it('rejects a malformed address', () => {
        expect(() => expandScanRange('192.168.230.999')).to.throw('invalid IP address');
        expect(() => expandScanRange('192.168.230')).to.throw('invalid IP address');
    });

    it('rejects a reversed range', () => {
        expect(() => expandScanRange('192.168.230.60-10')).to.throw('range ends before it starts');
    });

    it(`rejects more than ${MAX_SCAN_HOSTS} addresses`, () => {
        expect(() => expandScanRange('10.0.0.0/16')).to.throw(`more than ${MAX_SCAN_HOSTS}`);
    });
});

describe('scan => scanForPanels', () => {
    const PORT = 15515;
    let server: Server;

    before(done => {
        // minimal MDC display: answer any request with the QB43C status payload
        server = createServer(socket => {
            socket.once('data', () => {
                const body = [0xff, 0x00, 0x09, 0x41, 0x00, 0x01, 0x2a, 0x00, 0x21, 0x10, 0x00, 0x00];
                const checksum = body.reduce((sum, b) => sum + b, 0) & 0xff;
                socket.end(Buffer.from([0xaa, ...body, checksum]));
            });
        });
        server.listen(PORT, '127.0.0.1', done);
    });

    after(done => {
        server.close(() => done());
    });

    it('reports the panel that answers and its status', async () => {
        const hits = await scanForPanels({ hosts: ['127.0.0.1'], port: PORT, displayId: 0, timeoutMs: 2000 });
        expect(hits).to.have.lengthOf(1);
        expect(hits[0].ipAddress).to.equal('127.0.0.1');
        expect(hits[0].port).to.equal(PORT);
        expect(hits[0].status).to.deep.equal({ power: true, volume: 42, mute: false, input: 0x21 });
    });

    it('reports nothing when the port is closed', async () => {
        const hits = await scanForPanels({ hosts: ['127.0.0.1'], port: PORT + 1, displayId: 0, timeoutMs: 2000 });
        expect(hits).to.deep.equal([]);
    });
});
