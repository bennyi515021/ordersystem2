const SPREADSHEET_ID = '1PraWGjExwmu4jfNT3Z4fXuwJBx-kU3e-gJsUUBj4uG8';
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID + '/edit';
const SYNC_KEY_HASH = '__SYNC_KEY_HASH__';
const SCHEMA_VERSION = 3;

const SHEETS = {
  legacyProducts: '商品名單',
  products: '商品',
  categories: '類別',
  orders: '訂單',
  orderItems: '訂單明細',
  tombstones: '刪除紀錄',
  settings: '設定'
};

const HEADERS = {
  products: ['商品ID', '貨號', '商品名稱', '類別ID', '更新時間'],
  categories: ['類別ID', '類別名稱', '顏色樣式', '更新時間'],
  orders: ['訂單編號', '訂單日期', '總數量', '更新時間'],
  orderItems: ['訂單編號', '商品ID', '貨號', '商品名稱', '數量', '更新時間'],
  tombstones: ['資料類型', '資料ID', '刪除時間'],
  settings: ['設定項目', '值']
};

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    assertAuthorized_(params.key || '');
    ensureSheets_();
    const action = params.action || 'load';
    if (action === 'ping') {
      return output_({
        ok: true,
        action: 'ping',
        revision: getRevision_(),
        schemaVersion: SCHEMA_VERSION,
        spreadsheetUrl: SPREADSHEET_URL
      }, params.callback);
    }
    if (action === 'load') {
      return output_({
        ok: true,
        action: 'load',
        ...readState_(),
        spreadsheetUrl: SPREADSHEET_URL
      }, params.callback);
    }
    throw new Error('不支援的操作：' + action);
  } catch (error) {
    return output_({ ok: false, error: error.message || String(error) }, e && e.parameter && e.parameter.callback);
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    assertAuthorized_(payload.key || '');
    if (payload.action !== 'save') throw new Error('不支援的操作');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      ensureSheets_();
      const result = writeState_(payload.data || {});
      return output_({ ok: true, action: 'save', ...result, spreadsheetUrl: SPREADSHEET_URL });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return output_({ ok: false, error: error.message || String(error) });
  }
}

function onEdit(e) {
  try {
    if (!e || !e.range || e.range.getRow() <= 1) return;
    const sheet = e.range.getSheet();
    const timestampColumns = {};
    timestampColumns[SHEETS.products] = 5;
    timestampColumns[SHEETS.categories] = 4;
    timestampColumns[SHEETS.orders] = 4;
    timestampColumns[SHEETS.orderItems] = 6;
    timestampColumns[SHEETS.tombstones] = 3;
    const timestampColumn = timestampColumns[sheet.getName()];
    if (!timestampColumn) return;
    if (e.range.getColumn() !== timestampColumn) {
      sheet.getRange(e.range.getRow(), timestampColumn).setValue(new Date().toISOString());
    }
    bumpRevision_();
  } catch (error) {
    console.error(error);
  }
}

function readState_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const categories = readRows_(ss.getSheetByName(SHEETS.categories)).map(row => ({
    id: string_(row[0]),
    name: string_(row[1]),
    color: string_(row[2]) || 'bg-slate-100 text-slate-800',
    updatedAt: iso_(row[3])
  })).filter(item => item.id && item.name);

  const products = readRows_(ss.getSheetByName(SHEETS.products)).map(row => ({
    id: string_(row[0]),
    code: string_(row[1]),
    name: string_(row[2]),
    categoryId: string_(row[3]),
    updatedAt: iso_(row[4])
  })).filter(item => item.id && item.name);

  const orderMap = {};
  readRows_(ss.getSheetByName(SHEETS.orders)).forEach(row => {
    const id = string_(row[0]);
    if (!id) return;
    orderMap[id] = {
      id,
      date: iso_(row[1]),
      totalQty: number_(row[2]),
      updatedAt: iso_(row[3]),
      items: []
    };
  });

  readRows_(ss.getSheetByName(SHEETS.orderItems)).forEach(row => {
    const orderId = string_(row[0]);
    if (!orderMap[orderId]) return;
    orderMap[orderId].items.push({
      id: string_(row[1]),
      code: string_(row[2]),
      name: string_(row[3]),
      qty: number_(row[4]),
      updatedAt: iso_(row[5])
    });
  });

  const tombstones = readRows_(ss.getSheetByName(SHEETS.tombstones)).map(row => ({
    type: string_(row[0]),
    id: string_(row[1]),
    deletedAt: iso_(row[2])
  })).filter(item => item.type && item.id);

  return {
    revision: getRevision_(),
    updatedAt: getSetting_('updatedAt') || '',
    schemaVersion: SCHEMA_VERSION,
    data: { products, categories, orders: Object.values(orderMap), tombstones }
  };
}

function writeState_(data) {
  const products = array_(data.products);
  const categories = array_(data.categories);
  const orders = array_(data.orders);
  const tombstones = array_(data.tombstones);
  validateState_(products, categories, orders, tombstones);

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const now = new Date().toISOString();
  const productValues = [HEADERS.products];
  const categoryValues = [HEADERS.categories];
  const orderValues = [HEADERS.orders];
  const orderItemValues = [HEADERS.orderItems];
  const tombstoneValues = [HEADERS.tombstones];

  categories.forEach(item => categoryValues.push([
    string_(item.id), string_(item.name), string_(item.color), iso_(item.updatedAt) || now
  ]));
  products.forEach(item => productValues.push([
    string_(item.id), string_(item.code), string_(item.name), string_(item.categoryId), iso_(item.updatedAt) || now
  ]));
  orders.forEach(order => {
    const items = array_(order.items);
    const totalQty = items.reduce((sum, item) => sum + number_(item.qty), 0);
    orderValues.push([string_(order.id), iso_(order.date) || now, totalQty, iso_(order.updatedAt) || now]);
    items.forEach(item => orderItemValues.push([
      string_(order.id), string_(item.id), string_(item.code), string_(item.name), number_(item.qty),
      iso_(item.updatedAt) || iso_(order.updatedAt) || now
    ]));
  });
  tombstones.forEach(item => tombstoneValues.push([
    string_(item.type), string_(item.id), iso_(item.deletedAt) || now
  ]));

  replaceValues_(ss.getSheetByName(SHEETS.products), productValues);
  replaceValues_(ss.getSheetByName(SHEETS.categories), categoryValues);
  replaceValues_(ss.getSheetByName(SHEETS.orders), orderValues);
  replaceValues_(ss.getSheetByName(SHEETS.orderItems), orderItemValues);
  replaceValues_(ss.getSheetByName(SHEETS.tombstones), tombstoneValues);
  const revision = bumpRevision_(now);
  formatSheets_();
  SpreadsheetApp.flush();
  return { revision, updatedAt: now, schemaVersion: SCHEMA_VERSION };
}

function validateState_(products, categories, orders, tombstones) {
  if (products.length > 10000) throw new Error('商品數量超過上限');
  if (categories.length > 1000) throw new Error('類別數量超過上限');
  if (orders.length > 5000) throw new Error('訂單數量超過上限');
  if (tombstones.length > 30000) throw new Error('刪除紀錄超過上限');
  assertUnique_(products, '商品');
  assertUnique_(categories, '類別');
  assertUnique_(orders, '訂單');
  const categoryIds = new Set(categories.map(item => string_(item.id)));
  products.forEach(item => {
    if (!string_(item.id) || !string_(item.name)) throw new Error('商品 ID 與名稱不可空白');
    if (string_(item.categoryId) && !categoryIds.has(string_(item.categoryId))) {
      throw new Error('商品找不到對應類別：' + string_(item.name));
    }
  });
  let itemCount = 0;
  orders.forEach(order => {
    if (!string_(order.id)) throw new Error('訂單編號不可空白');
    itemCount += array_(order.items).length;
  });
  if (itemCount > 50000) throw new Error('訂單明細超過上限');
}

function assertUnique_(items, label) {
  const ids = {};
  items.forEach(item => {
    const id = string_(item.id);
    if (!id) throw new Error(label + ' ID 不可空白');
    if (ids[id]) throw new Error(label + ' ID 重複：' + id);
    ids[id] = true;
  });
}

function ensureSheets_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const isNew = !ss.getSheetByName(SHEETS.products);
  Object.entries(SHEETS).forEach(([key, name]) => {
    if (key !== 'legacyProducts' && !ss.getSheetByName(name)) ss.insertSheet(name);
  });
  const pairs = [
    [SHEETS.products, HEADERS.products],
    [SHEETS.categories, HEADERS.categories],
    [SHEETS.orders, HEADERS.orders],
    [SHEETS.orderItems, HEADERS.orderItems],
    [SHEETS.tombstones, HEADERS.tombstones],
    [SHEETS.settings, HEADERS.settings]
  ];
  pairs.forEach(([name, headers]) => {
    const sheet = ss.getSheetByName(name);
    if (!sheet.getRange(1, 1).getValue()) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  });
  const settings = ss.getSheetByName(SHEETS.settings);
  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, 3, 2).setValues([
      ['revision', 1], ['updatedAt', new Date().toISOString()], ['schemaVersion', SCHEMA_VERSION]
    ]);
  }
  if (isNew || ss.getSheetByName(SHEETS.products).getLastRow() <= 1) migrateLegacyProducts_(ss);
  formatSheets_();
}

function migrateLegacyProducts_(ss) {
  const legacy = ss.getSheetByName(SHEETS.legacyProducts);
  if (!legacy || legacy.getLastRow() <= 1) return;
  const rows = legacy.getRange(2, 1, legacy.getLastRow() - 1, Math.min(3, legacy.getLastColumn())).getDisplayValues();
  const now = new Date().toISOString();
  const colors = [
    'bg-blue-100 text-blue-800', 'bg-green-100 text-green-800', 'bg-orange-100 text-orange-800',
    'bg-purple-100 text-purple-800', 'bg-pink-100 text-pink-800', 'bg-yellow-100 text-yellow-800'
  ];
  const categories = {};
  const products = [];
  rows.forEach((row, index) => {
    const code = string_(row[0]);
    const name = string_(row[1]);
    const categoryName = string_(row[2]) || '未分類';
    if (!code && !name) return;
    if (!categories[categoryName]) {
      const catIndex = Object.keys(categories).length;
      categories[categoryName] = {
        id: stableId_('cat', categoryName),
        name: categoryName,
        color: colors[catIndex % colors.length]
      };
    }
    products.push([
      stableId_('prod', code || name + '-' + index),
      code,
      name || '未命名商品',
      categories[categoryName].id,
      now
    ]);
  });
  const categoryValues = [HEADERS.categories].concat(Object.values(categories).map(item => [item.id, item.name, item.color, now]));
  replaceValues_(ss.getSheetByName(SHEETS.categories), categoryValues);
  replaceValues_(ss.getSheetByName(SHEETS.products), [HEADERS.products].concat(products));
  setSetting_('updatedAt', now);
}

function formatSheets_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Object.entries(HEADERS).forEach(([key, headers]) => {
    const sheet = ss.getSheetByName(SHEETS[key]);
    if (!sheet) return;
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground('#1D4ED8')
      .setFontColor('#FFFFFF')
      .setFontWeight('bold');
    sheet.autoResizeColumns(1, headers.length);
  });
}

function replaceValues_(sheet, values) {
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
}

function readRows_(sheet) {
  if (!sheet || sheet.getLastRow() <= 1) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getDisplayValues();
}

function getRevision_() {
  return Math.max(1, parseInt(getSetting_('revision'), 10) || 1);
}

function bumpRevision_(timestamp) {
  const next = getRevision_() + 1;
  setSetting_('revision', next);
  setSetting_('updatedAt', timestamp || new Date().toISOString());
  setSetting_('schemaVersion', SCHEMA_VERSION);
  return next;
}

function getSetting_(key) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.settings);
  if (!sheet || sheet.getLastRow() < 2) return '';
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
  const row = rows.find(item => string_(item[0]) === key);
  return row ? row[1] : '';
}

function setSetting_(key, value) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.settings);
  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues() : [];
  const index = rows.findIndex(item => string_(item[0]) === key);
  if (index >= 0) sheet.getRange(index + 2, 2).setValue(value);
  else sheet.appendRow([key, value]);
}

function assertAuthorized_(key) {
  if (!key || hash_(String(key)) !== SYNC_KEY_HASH) throw new Error('同步金鑰錯誤');
}

function hash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2))
    .join('');
}

function output_(data, callback) {
  const json = JSON.stringify(data);
  const validCallback = callback && /^[A-Za-z_$][0-9A-Za-z_$\.]*$/.test(callback) ? callback : '';
  if (validCallback) {
    return ContentService.createTextOutput(validCallback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function stableId_(prefix, value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return prefix + '-' + bytes.slice(0, 8).map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('');
}

function array_(value) { return Array.isArray(value) ? value : []; }
function string_(value) { return value === null || value === undefined ? '' : String(value).trim(); }
function number_(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}
function iso_(value) {
  const text = string_(value);
  if (!text) return '';
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : text;
}
