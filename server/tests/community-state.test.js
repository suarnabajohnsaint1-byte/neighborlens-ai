const test = require('node:test');
const assert = require('node:assert/strict');
const { create, optimistic } = require('../../frontend/js/community/communityState');
const rules = require('../domain/community/community.rules');
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const post = () => ({ id: 1, body: 'Public fixture', reactions: { total: 0, like: 0, heart: 0, mine: null }, engagementVersion: 0 });
const response = posts => ({ posts, pagination: { page: 1, pages: 1, total: posts.length }, barangay: 'Fixture barangay' });
const result = (mine, version = 1) => ({ reactions: { total: mine ? 1 : 0, like: mine === 'like' ? 1 : 0, heart: mine === 'heart' ? 1 : 0, mine }, engagementVersion: version });

test('community rules reject forged membership, malformed IDs, filters and excessive input', () => {
    for (const value of [0, -1, '01', '1e2', '1 OR 1=1', '99999999999']) assert.throws(() => rules.id(value));
    for (const user of [null, { role: 'admin', barangayId: 1 }, { role: 'citizen', barangayId: null }]) assert.throws(() => rules.member(user));
    for (const input of [{ barangayId: 0 }, { barangay: ['Villamonte', 'Mandalagan'] }, { barangay: 'Villamonte', barangayId: 2 }, { pageSize: 21 }, { page: 1001 }, { sort: 'nearby' }, { search: 'x'.repeat(121) }]) assert.throws(() => rules.query(input));
    assert.equal(rules.query({ barangayId: 2 }).barangay, '2');
    assert.equal(rules.query({}).barangay, null);
    assert.doesNotThrow(() => rules.viewer({ role: 'citizen', barangayId: null }));
    assert.throws(() => rules.viewer({ role: 'admin' }));
    assert.throws(() => rules.reaction('affected'));
    assert.deepEqual(rules.author({ is_official: 0, author_id: 42, full_name: 'Private' }), { label: 'Anonymous resident', official: false });
});

test('OCR addresses prefer a clear barangay and ignore Purok numbers and ambiguous matches', () => {
    const catalog = ['Barangay 5', 'Barangay 13', 'Mandalagan', 'Villamonte', 'Sum-ag'].map((name, id) => ({ id, name, city: 'Bacolod City' }));
    for (const [address, expected] of [
        ['Purok 5, Brgy. Mandalagan, Bacolod City', 'Mandalagan'],
        ['PUROK 5 MANDALAGAN BACOLOD CITY', 'Mandalagan'],
        ['Mandalagan Road, Villamonte, Bacolod City', 'Villamonte'],
        ['Lacson Street, Bgy #013, Bacolod City', 'Barangay 13'],
        ['Sum ag, Bacolod City', 'Sum-ag'],
        ['Mandalagan Road Bacolod City', undefined],
        ['Barangay 5, Another City', undefined],
        ['Purok 5, Bacolod City', undefined],
        ['Mandalagan, Villamonte, Bacolod City', undefined]
    ]) assert.equal(rules.addressBarangay(address, catalog)?.name, expected);
});

test('switching feed area clears previous posts and ignores a superseded request', async () => {
    const pending = defer();
    const state = create({ list: async query => query.scope === 'citywide' ? pending.promise : response([post()]) }, () => {});
    await state.load();
    assert.equal(state.snapshot().query.scope, 'local');
    const citywide = state.load({ scope: 'citywide', page: 1 });
    assert.deepEqual(state.snapshot().posts, []);
    await state.load({ scope: 'local', page: 1 });
    pending.resolve(response([{ ...post(), id: 2 }]));
    await citywide;
    assert.deepEqual(state.snapshot().posts.map(row => row.id), [1]);
    state.destroy();
});
test('optimistic switching and removal never count a user twice', () => {
    assert.deepEqual(optimistic({ total: 3, like: 2, heart: 1, mine: 'like' }, 'heart'), { total: 3, like: 1, heart: 2, mine: 'heart' });
    assert.deepEqual(optimistic({ total: 1, like: 1, heart: 0, mine: 'like' }, null), { total: 0, like: 0, heart: 0, mine: null });
});
test('outdated search responses cannot replace the newest feed', async () => {
    const old = defer(), fresh = defer(); let calls = 0;
    const state = create({ list: () => ++calls === 1 ? old.promise : fresh.promise }, () => {});
    const first = state.load({ search: 'old' }), second = state.load({ search: 'fresh' });
    fresh.resolve(response([{ ...post(), body: 'Fresh' }])); await second;
    old.resolve(response([{ ...post(), body: 'Stale' }])); await first;
    assert.equal(state.snapshot().posts[0].body, 'Fresh');
    assert.equal(state.snapshot().query.search, 'fresh'); state.destroy();
});
test('failed refresh retains successful content but revocation clears it', async () => {
    let failure = null;
    const state = create({ list: async () => { if (failure) throw failure; return response([post()]); } }, () => {});
    await state.load(); failure = new Error('Offline'); await state.load();
    assert.equal(state.snapshot().posts.length, 1); assert.equal(state.snapshot().status, 'error');
    failure.status = 401; await state.load(); assert.equal(state.snapshot().posts.length, 0); state.destroy();
});
test('rapid reaction switching serializes desired states and keeps the latest intent', async () => {
    const first = defer(), calls = [];
    const state = create({ list: async () => response([post()]), react: async (_, value) => { calls.push(value); return calls.length === 1 ? first.promise : result(value, calls.length); } }, () => {});
    await state.load(); const running = state.react(1, 'like'); state.react(1, 'heart');
    assert.equal(state.snapshot().posts[0].reactions.mine, 'heart');
    first.resolve(result('like')); await running;
    assert.deepEqual(calls, ['like', 'heart']); assert.equal(state.snapshot().posts[0].reactions.mine, 'heart'); state.destroy();
});
test('ambiguous failure still sends a queued removal matching the old baseline', async () => {
    const first = defer(), calls = [];
    const state = create({ list: async () => response([post()]), react: async (_, value) => { calls.push(value); return calls.length === 1 ? first.promise : result(value, 2); } }, () => {});
    await state.load(); const running = state.react(1, 'like'); state.react(1, 'like');
    first.reject(new Error('Connection interrupted after commit')); await running;
    assert.deepEqual(calls, ['like', null]); assert.equal(state.snapshot().posts[0].reactions.total, 0); state.destroy();
});
test('failed reaction rolls back and a stale refresh cannot double-count the confirmed reaction', async () => {
    let failing = true;
    const state = create({ list: async () => response([post()]), react: async (_, value) => { if (failing) throw new Error('Rejected'); return result(value, 8); } }, () => {});
    await state.load(); await state.react(1, 'like'); assert.equal(state.snapshot().posts[0].reactions.mine, null);
    failing = false; await state.react(1, 'heart'); await state.load();
    assert.deepEqual(state.snapshot().posts[0].reactions, result('heart').reactions); state.destroy();
});
test('confirmed comment totals survive reaction renders and outdated feed responses', async () => {
    const state = create({ list: async () => response([{ ...post(), commentCount: 0 }]), react: async (_, value) => result(value, 6) }, () => {});
    await state.load(); state.commentCount(1, 4, 5); await state.react(1, 'like'); await state.load();
    assert.equal(state.snapshot().posts[0].commentCount, 4);
    state.commentCount(1, 2, 3); assert.equal(state.snapshot().posts[0].commentCount, 4); state.destroy();
});
test('destroyed state ignores in-flight responses without notifying or retaining data', async () => {
    const pending = defer(); let notifications = 0;
    const state = create({ list: () => pending.promise }, () => notifications++);
    const loading = state.load(); state.destroy(); pending.resolve(response([post()])); await loading;
    assert.equal(notifications, 1); assert.deepEqual(state.snapshot().posts, []);
});
test('shared carousel navigation does not subtract an unrelated parent offset', () => {
    const { mount } = require('../../frontend/js/shared/mediaCarousel');
    const listeners = new Map();
    const track = { scrollLeft: 0, clientWidth: 686, offsetLeft: 351,
        getBoundingClientRect: () => ({ left: 351 }),
        scrollTo: ({ left }) => { track.scrollLeft = left; },
        addEventListener: (event, callback) => listeners.set(event, callback), removeEventListener: event => listeners.delete(event) };
    const slides = [0, 1].map(index => ({ getBoundingClientRect: () => ({ left: 351 + index * 686 - track.scrollLeft }) }));
    const carousel = mount({ track, slides });
    carousel.goTo(1); assert.equal(carousel.index(), 1); assert.equal(track.scrollLeft, 686);
    carousel.goTo(0); assert.equal(track.scrollLeft, 0); carousel.destroy(); assert.equal(listeners.size, 0);
});
test('Supabase community publishing requires a confirmed private bucket', async () => {
    const Adapter = require('../infrastructure/storage/supabaseStorage.adapter');
    for (const data of [null, { public: true }, {}]) await assert.rejects(Adapter.prototype.assertPrivate.call({ bucketName: 'fixture', client: { storage: { getBucket: async () => ({ data }) } } }));
    await Adapter.prototype.assertPrivate.call({ bucketName: 'fixture', client: { storage: { getBucket: async () => ({ data: { public: false } }) } } });
});
test('failed transaction cleans only newly published derivatives with bounded retries', async () => {
    const { createCommunityPublicationService } = require('../application/use-cases/communityPublication.service');
    const removed = [], writes = [];
    const user = { id: 1, role: 'citizen', barangayId: 1, tokenVersion: 0 };
    const service = createCommunityPublicationService({
        getDatabase: () => ({ withTransaction: async fn => fn({}) }),
        repository: { lockReport: async () => ({ submitted_by: 1, barangay_id: 1 }), admins: async () => [], byKey: async () => null, find: async () => null, workload: async () => [], create: async () => { throw new Error('Isolated transaction failure'); } },
        community: { byReportId: async () => null, lockUser: async () => ({ role: 'citizen', status: 'active', barangay_id: 1, token_version: 0 }) },
        media: { fingerprint: () => 'a'.repeat(64), publish: async () => { writes.push('new-derivative'); return 'new-derivative'; }, remove: async reference => { removed.push(reference); if (removed.length === 1) throw new Error('Transient storage failure'); } },
        audit: {}, events: {}
    });
    await assert.rejects(service.request(user, { body: 'Public fixture', reportId: 1, requestKey: 'fixture-rollback-key' }, [{ buffer: Buffer.from('fixture') }]), /Isolated transaction failure/);
    assert.deepEqual(writes, ['new-derivative']); assert.deepEqual(removed, ['new-derivative', 'new-derivative']);
});
