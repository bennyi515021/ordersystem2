# ordersystem2

以 GitHub Pages 提供的繁體中文訂貨系統，支援離線操作，以及透過 Google Apps Script 與 Google Sheets 進行商品、類別及訂單的雙向同步。

## 架構

| 元件 | 用途 |
|---|---|
| GitHub Pages | 靜態前端、離線快取、Excel 匯出與同步狀態介面 |
| Apps Script Web App | 金鑰驗證、資料檢核、鎖定、版本控制與讀寫橋接 |
| Google Sheets | 共用且可人工檢視的商品、類別、訂單與刪除紀錄資料庫 |
| 私人同步金鑰 | 只儲存在使用者瀏覽器及私人金鑰檔，不提交到 GitHub |

## 同步行為

每筆商品、類別及訂單都有穩定 ID 與 ISO-8601 `updatedAt`。前端上傳前會先取得遠端 `revision`，依最新時間合併資料，再上傳並輪詢到版本增加才判定成功。刪除操作會寫入墓碑紀錄，防止舊的離線資料重新出現。

前端每 30 秒在頁面可見且有網路時拉取遠端資料；本機變更會防抖後上傳。離線時變更保留在瀏覽器，網路恢復後自動同步。

## 設定

正式 Apps Script Web App 已部署於：

`https://script.google.com/macros/s/AKfycbw_a1f65bsv5FA2fVt0dLv8HApIgiSN4M9d2gJNzqkH3vbU1oCvO93EZxyOfJ5A6z8A/exec`

前端已預填此網址。首次使用時，只需在網站的「雲端同步設定」輸入私人同步金鑰並連接；設定會保存在該瀏覽器的 `localStorage`。

如需重新部署，請將 `apps-script/Code.gs` 中的 `__SYNC_KEY_HASH__` 替換為私人同步金鑰的 SHA-256 雜湊後部署；不要將替換後的檔案提交到 Git。部署設定為由擁有者執行、允許任何人存取；所有 API 操作仍會驗證同步金鑰。

> `/exec` 網址不是秘密；私人同步金鑰才是存取憑證。請勿把金鑰放在 README、程式碼、網址、試算表或 Git 紀錄中。

## 本機驗證

```bash
node --check app.js
node --check test-sync.js
node test-sync.js
cp apps-script/Code.gs /tmp/Code.gs.js
node --check /tmp/Code.gs.js
```

部署前另執行 `git diff --check` 並掃描憑證；部署後需驗證有效金鑰可執行 `ping`、`load`，且錯誤金鑰會被拒絕。
