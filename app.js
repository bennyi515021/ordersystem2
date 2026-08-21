(() => {
    'use strict';

    const CACHE_KEY = 'orderSystemStateV3';
    const CONFIG_KEY = 'orderSystemSyncConfigV3';
    const DEFAULT_SYNC_ENDPOINT = 'https://script.google.com/macros/s/AKfycbw_a1f65bsv5FA2fVt0dLv8HApIgiSN4M9d2gJNzqkH3vbU1oCvO93EZxyOfJ5A6z8A/exec';
    const LEGACY_ORDER_KEY = 'orderHistory';
    const COLORS = [
        'bg-blue-100 text-blue-800', 'bg-green-100 text-green-800',
        'bg-orange-100 text-orange-800', 'bg-purple-100 text-purple-800',
        'bg-pink-100 text-pink-800', 'bg-yellow-100 text-yellow-800'
    ];
    const FALLBACK_PRODUCTS = [
        { id: 'prod-1', code: '313629', name: 'A新及第豬肉熟', categoryId: 'cat-1' },
        { id: 'prod-2', code: '313635', name: 'A新及第小籠湯', categoryId: 'cat-1' },
        { id: 'prod-3', code: '314820', name: '七里香-黃金', categoryId: 'cat-1' },
        { id: 'prod-110', code: '347675', name: '酷椰與100%椰', categoryId: 'cat-2' },
        { id: 'prod-144', code: '219349', name: '林鳳營鮮乳全脂228', categoryId: 'cat-2' },
        { id: 'prod-266', code: '130002', name: '糖蜜香紅豆麵包', categoryId: 'cat-3' }
    ];
    const FALLBACK_CATEGORIES = [
        { id: 'cat-1', name: '便當', color: COLORS[0] },
        { id: 'cat-2', name: 'OC飲料', color: COLORS[1] },
        { id: 'cat-3', name: '麵包', color: COLORS[2] }
    ];

    const now = () => new Date().toISOString();
    const clone = value => JSON.parse(JSON.stringify(value));
    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[ch]);
    const makeId = prefix => `${prefix}-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
    const timeValue = value => Date.parse(value || '') || 0;

    let state = loadCache();
    let cart = {};
    let currentCategory = 'all';
    let searchQuery = '';
    let manageSearchQuery = '';
    let manageView = 'products';
    let tempProducts = [];
    let tempCategories = [];
    let syncTimer = null;
    let pollTimer = null;
    let syncInFlight = false;
    let lastRemoteRevision = Number(state.revision || 0);
    let spreadsheetUrl = '';
    let syncConfig = loadConfig();

    function loadCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            if (cached && Array.isArray(cached.products) && Array.isArray(cached.categories)) {
                cached.orders = Array.isArray(cached.orders) ? cached.orders : [];
                cached.tombstones = Array.isArray(cached.tombstones) ? cached.tombstones : [];
                return cached;
            }
        } catch (error) {
            console.warn('本地快取無法解析', error);
        }
        let legacyOrders = [];
        try { legacyOrders = JSON.parse(localStorage.getItem(LEGACY_ORDER_KEY) || '[]'); } catch (_) {}
        const timestamp = now();
        return {
            products: FALLBACK_PRODUCTS.map(item => ({ ...item, updatedAt: timestamp })),
            categories: FALLBACK_CATEGORIES.map(item => ({ ...item, updatedAt: timestamp })),
            orders: legacyOrders.map(order => normalizeOrder(order, timestamp)),
            tombstones: [], revision: 0, updatedAt: timestamp,
            hasLocalChanges: legacyOrders.length > 0
        };
    }

    function loadConfig() {
        try {
            const value = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
            return { endpoint: String(value.endpoint || DEFAULT_SYNC_ENDPOINT), key: String(value.key || '') };
        } catch (_) {
            return { endpoint: DEFAULT_SYNC_ENDPOINT, key: '' };
        }
    }

    function normalizeOrder(order, fallbackTime = now()) {
        const updatedAt = order.updatedAt || order.date || fallbackTime;
        const items = Array.isArray(order.items) ? order.items.map(item => ({
            id: String(item.id || makeId('prod')),
            code: String(item.code || ''), name: String(item.name || '未命名商品'),
            qty: Math.max(0, Number(item.qty) || 0), updatedAt: item.updatedAt || updatedAt
        })) : [];
        return {
            id: String(order.id || makeId('ORD')).toUpperCase(),
            date: order.date || updatedAt, updatedAt,
            totalQty: items.reduce((sum, item) => sum + item.qty, 0), items
        };
    }

    function saveCache() {
        state.updatedAt = now();
        localStorage.setItem(CACHE_KEY, JSON.stringify(state));
        localStorage.setItem(LEGACY_ORDER_KEY, JSON.stringify(state.orders));
    }

    const els = Object.fromEntries([
        'product-list', 'order-list', 'order-summary', 'search-input', 'category-container', 'toast',
        'btn-batch-import', 'btn-manage-products', 'btn-export-excel', 'btn-save-order',
        'btn-order-history', 'btn-settings', 'import-file', 'drop-zone', 'modal-import',
        'close-import', 'import-status', 'modal-settings', 'close-settings', 'btn-cancel-settings',
        'btn-load-sheet', 'sync-endpoint', 'sync-key', 'btn-disconnect-sync', 'btn-manual-sync',
        'btn-open-sheet', 'modal-manage', 'close-manage', 'btn-cancel-manage', 'btn-save-manage',
        'manage-table-body', 'manage-search', 'btn-add-product', 'modal-add-product',
        'close-add-product', 'cancel-add-product', 'add-product-form', 'new-code', 'new-name',
        'new-category', 'modal-history', 'close-history', 'history-list', 'btn-manage-categories',
        'product-management-view', 'category-management-view', 'modal-title', 'manage-toolbar',
        'category-table-body', 'btn-add-category', 'product-count', 'data-status', 'data-source-text'
    ].map(id => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), document.getElementById(id)]));

    function showToast(message, duration = 2800) {
        els.toast.textContent = message;
        els.toast.classList.remove('opacity-0');
        window.setTimeout(() => els.toast.classList.add('opacity-0'), duration);
    }

    function setStatus(kind, text) {
        const color = { ok: 'bg-green-500', busy: 'bg-yellow-500 animate-pulse', error: 'bg-red-500', offline: 'bg-slate-400' }[kind] || 'bg-slate-400';
        els.dataStatus.className = `inline-block w-2 h-2 rounded-full ${color}`;
        els.dataSourceText.textContent = text;
    }

    function renderAll() {
        renderCategories();
        renderProducts();
        renderOrderDetails();
    }

    function renderCategories() {
        let html = '<button class="cat-btn active px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition" data-cat="all">全部</button>';
        state.categories.forEach(category => {
            const active = currentCategory === category.id ? ' active' : '';
            html += `<button class="cat-btn${active} px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition" data-cat="${escapeHtml(category.id)}">${escapeHtml(category.name)}</button>`;
        });
        els.categoryContainer.innerHTML = html;
        els.categoryContainer.querySelectorAll('.cat-btn').forEach(button => button.addEventListener('click', () => {
            currentCategory = button.dataset.cat;
            els.categoryContainer.querySelectorAll('.cat-btn').forEach(item => item.classList.toggle('active', item === button));
            renderProducts();
        }));
    }

    function renderProducts() {
        const query = searchQuery.toLowerCase();
        const filtered = state.products.filter(product => {
            const categoryMatch = currentCategory === 'all' || product.categoryId === currentCategory;
            return categoryMatch && (`${product.name} ${product.code}`.toLowerCase().includes(query));
        });
        els.productCount.textContent = `(${filtered.length})`;
        if (!filtered.length) {
            els.productList.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">找不到符合的商品</div>';
            return;
        }
        els.productList.innerHTML = filtered.map(product => {
            const qty = cart[product.id] || 0;
            return `<div class="group flex items-center justify-between p-4 bg-white border ${qty ? 'border-blue-200 bg-blue-50/30' : 'border-slate-200'} rounded-xl hover:border-slate-300 transition-all">
                <div class="flex-1 min-w-0 mr-4"><div class="text-xs text-slate-400 font-medium mb-0.5">${escapeHtml(product.code)}</div><div class="font-semibold text-slate-800 truncate">${escapeHtml(product.name)}</div></div>
                <div class="flex items-center gap-2">
                    <button class="w-8 h-8 rounded-lg border ${qty ? 'border-blue-200 bg-white text-blue-600' : 'border-slate-200 bg-slate-50 text-slate-300 cursor-not-allowed'}" data-qty-id="${escapeHtml(product.id)}" data-delta="-1" ${qty ? '' : 'disabled'}>−</button>
                    <span class="w-6 text-center text-sm font-medium ${qty ? 'text-blue-700' : 'text-slate-400'}">${qty}</span>
                    <button class="w-8 h-8 rounded-lg bg-blue-600 text-white hover:bg-blue-700" data-qty-id="${escapeHtml(product.id)}" data-delta="1">＋</button>
                </div></div>`;
        }).join('');
        els.productList.querySelectorAll('[data-qty-id]').forEach(button => button.addEventListener('click', () => updateCart(button.dataset.qtyId, Number(button.dataset.delta))));
    }

    function renderOrderDetails() {
        const active = state.products.filter(product => (cart[product.id] || 0) > 0);
        const totalQty = active.reduce((sum, product) => sum + cart[product.id], 0);
        els.orderSummary.textContent = `${active.length} 項商品 · 共 ${totalQty} 件`;
        if (!active.length) {
            els.orderList.innerHTML = '<div class="flex items-center justify-center h-full min-h-[120px]"><p class="text-slate-400 text-sm">尚未選擇任何商品</p></div>';
            return;
        }
        els.orderList.innerHTML = `<div class="p-4 w-full">${active.map(product => `<div class="flex justify-between items-center py-3 border-b border-slate-100 last:border-0">
            <div><div class="font-medium text-slate-800 text-sm">${escapeHtml(product.name)}</div><div class="text-xs text-slate-400">${escapeHtml(product.code)} × ${cart[product.id]}</div></div>
            <div class="flex items-center bg-white border border-slate-200 rounded-lg shadow-sm"><button class="w-7 h-7" data-order-id="${escapeHtml(product.id)}" data-delta="-1">−</button><span class="w-6 text-center text-sm">${cart[product.id]}</span><button class="w-7 h-7" data-order-id="${escapeHtml(product.id)}" data-delta="1">＋</button></div>
        </div>`).join('')}</div>`;
        els.orderList.querySelectorAll('[data-order-id]').forEach(button => button.addEventListener('click', () => updateCart(button.dataset.orderId, Number(button.dataset.delta))));
    }

    function updateCart(id, delta) {
        cart[id] = Math.max(0, (cart[id] || 0) + delta);
        if (!cart[id]) delete cart[id];
        renderProducts();
        renderOrderDetails();
    }

    function openModal(element) { element.classList.remove('hidden'); element.classList.add('flex'); }
    function closeModal(element) { element.classList.add('hidden'); element.classList.remove('flex'); }

    function recordTombstone(type, id, deletedAt = now()) {
        const key = `${type}|${id}`;
        const existing = state.tombstones.find(item => `${item.type}|${item.id}` === key);
        if (!existing) state.tombstones.push({ type, id, deletedAt });
        else if (timeValue(deletedAt) > timeValue(existing.deletedAt)) existing.deletedAt = deletedAt;
    }

    function markDirty(message = '資料已更新，等待同步') {
        state.hasLocalChanges = true;
        saveCache();
        setStatus(syncConfig.endpoint && syncConfig.key ? 'busy' : 'offline', syncConfig.endpoint && syncConfig.key ? message : '已離線儲存');
        schedulePush();
    }

    function schedulePush() {
        if (!syncConfig.endpoint || !syncConfig.key) return;
        window.clearTimeout(syncTimer);
        syncTimer = window.setTimeout(() => syncNow({ push: true, quiet: true }), 1200);
    }

    function openManageModal() {
        tempProducts = clone(state.products);
        tempCategories = clone(state.categories);
        manageView = 'products';
        switchManageView('products');
        openModal(els.modalManage);
    }

    function switchManageView(view) {
        manageView = view;
        const productsView = view === 'products';
        els.productManagementView.classList.toggle('hidden', !productsView);
        els.categoryManagementView.classList.toggle('hidden', productsView);
        els.manageToolbar.classList.toggle('hidden', !productsView);
        els.modalTitle.textContent = productsView ? '管理商品' : '管理類別';
        if (productsView) renderManageTable(); else renderManageCategories();
    }

    function renderManageTable() {
        const query = manageSearchQuery.toLowerCase();
        const filtered = tempProducts.filter(product => `${product.name} ${product.code}`.toLowerCase().includes(query));
        els.manageTableBody.innerHTML = filtered.length ? filtered.map(product => `<tr class="hover:bg-slate-50">
            <td class="px-4 py-3"><input value="${escapeHtml(product.code)}" class="w-full bg-transparent border-b text-sm py-1" data-product-id="${escapeHtml(product.id)}" data-field="code"></td>
            <td class="px-4 py-3"><input value="${escapeHtml(product.name)}" class="w-full bg-transparent border-b text-sm py-1" data-product-id="${escapeHtml(product.id)}" data-field="name"></td>
            <td class="px-4 py-3"><select class="w-full bg-transparent border-b text-sm py-1" data-product-id="${escapeHtml(product.id)}" data-field="categoryId">${tempCategories.map(category => `<option value="${escapeHtml(category.id)}" ${category.id === product.categoryId ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}</select></td>
            <td class="px-4 py-3 text-right"><button class="text-red-500" data-delete-product="${escapeHtml(product.id)}">刪除</button></td>
        </tr>`).join('') : '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400">無相符商品</td></tr>';
        els.manageTableBody.querySelectorAll('[data-product-id]').forEach(input => input.addEventListener('change', () => {
            const product = tempProducts.find(item => item.id === input.dataset.productId);
            if (product) { product[input.dataset.field] = input.value.trim(); product.updatedAt = now(); }
        }));
        els.manageTableBody.querySelectorAll('[data-delete-product]').forEach(button => button.addEventListener('click', () => {
            if (confirm('確定要刪除此商品嗎？')) {
                tempProducts = tempProducts.filter(item => item.id !== button.dataset.deleteProduct);
                renderManageTable();
            }
        }));
    }

    function renderManageCategories() {
        els.categoryTableBody.innerHTML = tempCategories.map((category, index) => `<tr class="hover:bg-slate-50">
            <td class="px-4 py-3"><input value="${escapeHtml(category.id)}" class="w-full bg-transparent border-b text-sm py-1 font-mono" data-category-index="${index}" data-field="id"></td>
            <td class="px-4 py-3"><input value="${escapeHtml(category.name)}" class="w-full bg-transparent border-b text-sm py-1" data-category-index="${index}" data-field="name"></td>
            <td class="px-4 py-3 text-right"><button class="text-red-500" data-delete-category="${index}">刪除</button></td>
        </tr>`).join('');
        els.categoryTableBody.querySelectorAll('[data-category-index]').forEach(input => input.addEventListener('change', () => {
            const category = tempCategories[Number(input.dataset.categoryIndex)];
            if (!category) return;
            const oldId = category.id;
            category[input.dataset.field] = input.value.trim();
            category.updatedAt = now();
            if (input.dataset.field === 'id' && oldId !== category.id) tempProducts.forEach(product => { if (product.categoryId === oldId) product.categoryId = category.id; });
        }));
        els.categoryTableBody.querySelectorAll('[data-delete-category]').forEach(button => button.addEventListener('click', () => {
            if (tempCategories.length <= 1) return showToast('至少需要保留一個類別');
            if (!confirm('確定要刪除此類別嗎？')) return;
            const index = Number(button.dataset.deleteCategory);
            const removed = tempCategories.splice(index, 1)[0];
            tempProducts.forEach(product => { if (product.categoryId === removed.id) { product.categoryId = tempCategories[0].id; product.updatedAt = now(); } });
            renderManageCategories();
        }));
    }

    function saveManagement() {
        const timestamp = now();
        state.products.filter(old => !tempProducts.some(item => item.id === old.id)).forEach(item => recordTombstone('product', item.id, timestamp));
        state.categories.filter(old => !tempCategories.some(item => item.id === old.id)).forEach(item => recordTombstone('category', item.id, timestamp));
        state.products = tempProducts.map(item => ({ ...item, updatedAt: item.updatedAt || timestamp }));
        state.categories = tempCategories.map(item => ({ ...item, updatedAt: item.updatedAt || timestamp }));
        closeModal(els.modalManage);
        renderAll();
        markDirty();
    }

    function addProduct(event) {
        event.preventDefault();
        state.updatedAt = now();
        tempProducts.push({ id: makeId('prod'), code: els.newCode.value.trim(), name: els.newName.value.trim(), categoryId: els.newCategory.value, updatedAt: state.updatedAt });
        closeModal(els.modalAddProduct);
        renderManageTable();
        showToast('商品已新增');
    }

    function renderHistory() {
        if (!state.orders.length) {
            els.historyList.innerHTML = '<div class="text-center py-8 text-slate-400"><p>目前尚無訂單記錄</p></div>';
            return;
        }
        els.historyList.innerHTML = state.orders.map(order => `<div class="order-history-item border border-slate-200 rounded-xl p-4 mb-3 bg-white">
            <div class="flex justify-between"><div><div class="font-medium text-sm">${escapeHtml(order.id)}</div><div class="text-xs text-slate-400">${escapeHtml(new Date(order.date).toLocaleString('zh-TW'))}</div></div><button class="text-red-500" data-delete-order="${escapeHtml(order.id)}">刪除</button></div>
            <div class="space-y-1 mt-3 pl-3 border-l-2">${order.items.map(item => `<div class="flex justify-between text-xs"><span>${escapeHtml(item.name)} × ${item.qty}</span><span>${escapeHtml(item.code)}</span></div>`).join('')}</div>
            <div class="mt-2 pt-2 border-t text-xs text-right">${order.items.length} 項商品 · 共 ${order.totalQty} 件</div>
        </div>`).join('');
        els.historyList.querySelectorAll('[data-delete-order]').forEach(button => button.addEventListener('click', () => {
            if (!confirm('確定要刪除此筆訂單嗎？')) return;
            const id = button.dataset.deleteOrder;
            state.orders = state.orders.filter(order => order.id !== id);
            recordTombstone('order', id);
            renderHistory();
            markDirty('訂單已刪除，等待同步');
        }));
    }

    function saveOrder() {
        const active = state.products.filter(product => (cart[product.id] || 0) > 0);
        if (!active.length) return showToast('購物車是空的');
        const timestamp = now();
        const order = normalizeOrder({
            id: `ORD-${Date.now().toString(36).toUpperCase()}`, date: timestamp, updatedAt: timestamp,
            items: active.map(product => ({ id: product.id, code: product.code, name: product.name, qty: cart[product.id], updatedAt: timestamp }))
        }, timestamp);
        state.orders.unshift(order);
        cart = {};
        renderOrderDetails(); renderProducts();
        markDirty('訂單已保存，等待同步');
        showToast(`訂單 ${order.id} 已保存`);
    }

    function exportToExcel() {
        const active = state.products.filter(product => (cart[product.id] || 0) > 0);
        if (!active.length) return showToast('購物車是空的');
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(active.map(product => ({ 貨號: product.code, 商品名稱: product.name, 數量: cart[product.id] })));
        ws['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 8 }];
        XLSX.utils.book_append_sheet(wb, ws, '訂單明細');
        XLSX.writeFile(wb, `訂單_${new Date().toISOString().slice(0, 10)}.xlsx`);
    }

    function parseImportedRows(rows) {
        if (!rows.length) throw new Error('資料為空');
        const keys = Object.keys(rows[0]);
        const findKey = words => keys.find(key => words.some(word => key.toLowerCase().includes(word.toLowerCase())));
        const codeKey = findKey(['code', '貨號', '編號']);
        const nameKey = findKey(['name', '商品名稱', '品名']);
        const catNameKey = findKey(['categoryname', '類別名稱', '分類']);
        const categoryMap = new Map(state.categories.map(item => [item.name, item]));
        const timestamp = now();
        rows.forEach(row => {
            const code = String(row[codeKey] || '').trim();
            const name = String(row[nameKey] || '').trim();
            if (!code && !name) return;
            const categoryName = String(row[catNameKey] || '未分類').trim();
            if (!categoryMap.has(categoryName)) categoryMap.set(categoryName, { id: makeId('cat'), name: categoryName, color: COLORS[categoryMap.size % COLORS.length], updatedAt: timestamp });
            const existing = state.products.find(item => item.code === code && code);
            if (existing) Object.assign(existing, { name: name || existing.name, categoryId: categoryMap.get(categoryName).id, updatedAt: timestamp });
            else state.products.push({ id: makeId('prod'), code, name: name || '未命名商品', categoryId: categoryMap.get(categoryName).id, updatedAt: timestamp });
        });
        state.categories = [...categoryMap.values()];
        renderAll();
        markDirty('匯入完成，等待同步');
    }

    function handleImport(file) {
        const reader = new FileReader();
        reader.onload = event => {
            try {
                if (file.name.toLowerCase().endsWith('.json')) {
                    const data = JSON.parse(event.target.result);
                    const timestamp = now();
                    if (Array.isArray(data.categories)) state.categories = data.categories.map(item => ({ ...item, updatedAt: item.updatedAt || timestamp }));
                    if (Array.isArray(data.products)) state.products = data.products.map(item => ({ ...item, updatedAt: item.updatedAt || timestamp }));
                    renderAll(); markDirty('匯入完成，等待同步');
                } else {
                    Papa.parse(event.target.result, { header: true, skipEmptyLines: true, complete: result => parseImportedRows(result.data) });
                }
                closeModal(els.modalImport);
                showToast('商品資料匯入成功');
            } catch (error) {
                els.importStatus.textContent = `匯入失敗：${error.message}`;
                els.importStatus.className = 'mt-4 text-sm text-red-500';
            }
        };
        reader.readAsText(file);
    }

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
            orders: mergeRecordLists((local.orders || []).map(order => normalizeOrder(order)), (remote.orders || []).map(order => normalizeOrder(order))),
            tombstones: [], revision: Math.max(Number(local.revision || 0), Number(remote.revision || 0)), updatedAt: now()
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

    function jsonpLoad(action = 'load', timeout = 15000) {
        return new Promise((resolve, reject) => {
            if (!syncConfig.endpoint || !syncConfig.key) return reject(new Error('尚未設定同步服務'));
            const callback = `__orderSync_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const script = document.createElement('script');
            const cleanup = () => { delete window[callback]; script.remove(); window.clearTimeout(timer); };
            const timer = window.setTimeout(() => { cleanup(); reject(new Error('同步服務逾時')); }, timeout);
            window[callback] = payload => { cleanup(); payload && payload.ok ? resolve(payload) : reject(new Error(payload?.error || '同步失敗')); };
            const url = new URL(syncConfig.endpoint);
            url.searchParams.set('action', action);
            url.searchParams.set('key', syncConfig.key);
            url.searchParams.set('callback', callback);
            url.searchParams.set('_', String(Date.now()));
            script.src = url.toString();
            script.onerror = () => { cleanup(); reject(new Error('無法連線同步服務')); };
            document.head.appendChild(script);
        });
    }

    async function pushState(baselineRevision) {
        await fetch(syncConfig.endpoint, {
            method: 'POST', mode: 'no-cors', cache: 'no-store',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'save', key: syncConfig.key, data: {
                products: state.products, categories: state.categories,
                orders: state.orders, tombstones: state.tombstones
            } })
        });
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
            await new Promise(resolve => window.setTimeout(resolve, 1200));
            const confirmed = await jsonpLoad('load');
            if (Number(confirmed.revision) > Number(baselineRevision)) return confirmed;
        }
        throw new Error('已送出資料，但尚未收到遠端確認');
    }

    async function syncNow({ push = false, quiet = false } = {}) {
        if (syncInFlight || !syncConfig.endpoint || !syncConfig.key) return false;
        push = push || Boolean(state.hasLocalChanges);
        syncInFlight = true;
        setStatus('busy', push ? '正在合併並上傳資料…' : '正在取得雲端資料…');
        try {
            const remote = await jsonpLoad('load');
            spreadsheetUrl = remote.spreadsheetUrl || spreadsheetUrl;
            const baseline = Number(remote.revision || 0);
            const remoteState = { ...(remote.data || {}), revision: baseline, updatedAt: remote.updatedAt || now(), hasLocalChanges: false };
            state = state.hasLocalChanges ? mergeStates(state, remoteState) : remoteState;
            state.revision = baseline;
            lastRemoteRevision = baseline;
            if (push) {
                const confirmed = await pushState(baseline);
                state = mergeStates(state, { ...(confirmed.data || {}), revision: confirmed.revision });
                state.revision = Number(confirmed.revision || baseline + 1);
                lastRemoteRevision = state.revision;
            }
            state.hasLocalChanges = false;
            saveCache(); renderAll();
            setStatus('ok', `雲端同步完成 · 版本 ${lastRemoteRevision}`);
            if (!quiet) showToast('Google Sheets 同步完成');
            return true;
        } catch (error) {
            console.error(error);
            setStatus(navigator.onLine ? 'error' : 'offline', `同步失敗：${error.message}`);
            if (!quiet) showToast(`同步失敗：${error.message}`, 4500);
            return false;
        } finally {
            syncInFlight = false;
        }
    }

    async function connectSync() {
        const endpoint = els.syncEndpoint.value.trim().replace(/\?.*$/, '');
        const key = els.syncKey.value.trim();
        if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(endpoint)) return showToast('請輸入有效的 Apps Script /exec 網址');
        if (!key) return showToast('請輸入同步金鑰');
        syncConfig = { endpoint, key };
        localStorage.setItem(CONFIG_KEY, JSON.stringify(syncConfig));
        const success = await syncNow({ push: Boolean(state.hasLocalChanges) });
        if (success) { closeModal(els.modalSettings); startPolling(); }
    }

    function disconnectSync() {
        if (!confirm('中斷同步後，本機資料仍會保留。確定要中斷嗎？')) return;
        syncConfig = { endpoint: '', key: '' };
        localStorage.removeItem(CONFIG_KEY);
        window.clearInterval(pollTimer);
        setStatus('offline', '離線模式（資料保留於此瀏覽器）');
        els.syncEndpoint.value = ''; els.syncKey.value = '';
    }

    function startPolling() {
        window.clearInterval(pollTimer);
        if (!syncConfig.endpoint || !syncConfig.key) return;
        pollTimer = window.setInterval(() => {
            if (!document.hidden && navigator.onLine) syncNow({ push: false, quiet: true });
        }, 30000);
    }

    function bindEvents() {
        els.searchInput.addEventListener('input', event => { searchQuery = event.target.value; renderProducts(); });
        els.btnSettings.addEventListener('click', () => { els.syncEndpoint.value = syncConfig.endpoint; els.syncKey.value = syncConfig.key; openModal(els.modalSettings); });
        els.closeSettings.addEventListener('click', () => closeModal(els.modalSettings));
        els.btnCancelSettings.addEventListener('click', () => closeModal(els.modalSettings));
        els.btnLoadSheet.addEventListener('click', connectSync);
        els.btnDisconnectSync.addEventListener('click', disconnectSync);
        els.btnManualSync.addEventListener('click', () => syncNow({ push: true }));
        els.btnOpenSheet.addEventListener('click', () => spreadsheetUrl ? window.open(spreadsheetUrl, '_blank', 'noopener') : showToast('請先連接同步服務'));
        els.btnBatchImport.addEventListener('click', () => openModal(els.modalImport));
        els.closeImport.addEventListener('click', () => closeModal(els.modalImport));
        els.dropZone.addEventListener('click', () => els.importFile.click());
        els.importFile.addEventListener('change', event => { if (event.target.files[0]) handleImport(event.target.files[0]); });
        ['dragover', 'drop'].forEach(name => els.dropZone.addEventListener(name, event => event.preventDefault()));
        els.dropZone.addEventListener('drop', event => { if (event.dataTransfer.files[0]) handleImport(event.dataTransfer.files[0]); });
        els.btnManageProducts.addEventListener('click', openManageModal);
        els.closeManage.addEventListener('click', () => closeModal(els.modalManage));
        els.btnCancelManage.addEventListener('click', () => closeModal(els.modalManage));
        els.btnSaveManage.addEventListener('click', saveManagement);
        els.manageSearch.addEventListener('input', event => { manageSearchQuery = event.target.value; renderManageTable(); });
        els.btnManageCategories.addEventListener('click', () => switchManageView('categories'));
        els.btnAddCategory.addEventListener('click', () => { tempCategories.push({ id: makeId('cat'), name: '新類別', color: COLORS[tempCategories.length % COLORS.length], updatedAt: now() }); renderManageCategories(); });
        els.btnAddProduct.addEventListener('click', () => { els.newCategory.innerHTML = tempCategories.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join(''); els.addProductForm.reset(); openModal(els.modalAddProduct); });
        els.closeAddProduct.addEventListener('click', () => closeModal(els.modalAddProduct));
        els.cancelAddProduct.addEventListener('click', () => closeModal(els.modalAddProduct));
        els.addProductForm.addEventListener('submit', addProduct);
        els.btnOrderHistory.addEventListener('click', () => { renderHistory(); openModal(els.modalHistory); });
        els.closeHistory.addEventListener('click', () => closeModal(els.modalHistory));
        els.btnSaveOrder.addEventListener('click', saveOrder);
        els.btnExportExcel.addEventListener('click', exportToExcel);
        document.addEventListener('visibilitychange', () => { if (!document.hidden && syncConfig.endpoint && syncConfig.key) syncNow({ quiet: true }); });
        window.addEventListener('online', () => { setStatus('busy', '網路已恢復，正在同步…'); syncNow({ push: true, quiet: true }); });
        window.addEventListener('offline', () => setStatus('offline', '目前離線，變更會保留於本機'));
    }

    async function init() {
        bindEvents();
        renderAll();
        saveCache();
        if (syncConfig.endpoint && syncConfig.key) {
            startPolling();
            await syncNow({ push: false, quiet: true });
        } else {
            setStatus('offline', '離線模式 · 請設定 Google Sheets 同步');
        }
    }

    init();
})();
