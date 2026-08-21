const assert = require('node:assert/strict');

const timeValue = value => Date.parse(value || '') || 0;
const clone = value => JSON.parse(JSON.stringify(value));
const normalizeOrder = order => ({ ...order, items: order.items || [] });

function mergeRecordLists(local, remote) {
    const map = new Map();
    [...remote, ...local].forEach(item => {
        const current = map.get(item.id);
        if (!current || timeValue(item.updatedAt) >= timeValue(current.updatedAt)) map.set(item.id, clone(item));
    });
    return [...map.values()];
}

function mergeStates(local, remote) {
    const merged = {
        products: mergeRecordLists(local.products || [], remote.products || []),
        categories: mergeRecordLists(local.categories || [], remote.categories || []),
        orders: mergeRecordLists((local.orders || []).map(normalizeOrder), (remote.orders || []).map(normalizeOrder)),
        tombstones: []
    };
    const tombstoneMap = new Map();
    [...(remote.tombstones || []), ...(local.tombstones || [])].forEach(item => {
        const key = `${item.type}|${item.id}`;
        const current = tombstoneMap.get(key);
        if (!current || timeValue(item.deletedAt) >= timeValue(current.deletedAt)) tombstoneMap.set(key, clone(item));
    });
    merged.tombstones = [...tombstoneMap.values()];
    const filterDeleted = (items, type) => items.filter(item => {
        const deletion = tombstoneMap.get(`${type}|${item.id}`);
        return !deletion || timeValue(item.updatedAt) > timeValue(deletion.deletedAt);
    });
    merged.products = filterDeleted(merged.products, 'product');
    merged.categories = filterDeleted(merged.categories, 'category');
    merged.orders = filterDeleted(merged.orders, 'order');
    return merged;
}

const local = {
    products: [
        { id: 'p1', name: '本機較新', updatedAt: '2026-08-20T10:10:00Z' },
        { id: 'p2', name: '應被刪除', updatedAt: '2026-08-20T10:00:00Z' },
        { id: 'p3', name: '離線新增', updatedAt: '2026-08-20T10:20:00Z' }
    ],
    categories: [], orders: [],
    tombstones: [{ type: 'product', id: 'p4', deletedAt: '2026-08-20T10:30:00Z' }]
};
const remote = {
    products: [
        { id: 'p1', name: '遠端較舊', updatedAt: '2026-08-20T10:05:00Z' },
        { id: 'p2', name: '應被刪除', updatedAt: '2026-08-20T10:00:00Z' },
        { id: 'p4', name: '不可復活', updatedAt: '2026-08-20T10:25:00Z' }
    ],
    categories: [], orders: [],
    tombstones: [{ type: 'product', id: 'p2', deletedAt: '2026-08-20T10:15:00Z' }]
};
const merged = mergeStates(local, remote);
assert.equal(merged.products.find(item => item.id === 'p1').name, '本機較新');
assert.ok(merged.products.some(item => item.id === 'p3'));
assert.ok(!merged.products.some(item => item.id === 'p2'));
assert.ok(!merged.products.some(item => item.id === 'p4'));
assert.equal(merged.tombstones.length, 2);
console.log('sync merge tests passed');
