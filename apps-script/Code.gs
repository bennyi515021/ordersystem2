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



  replaceValues_(ss.getSheetByName(SHEETS.products),
