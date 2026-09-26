# DeskNotes — Windows 桌面筆記

一個類似 Samsung Notes 的 Windows 桌面筆記 App，不需要帳號、資料全部存在自己電腦。

## 功能

- **隨時記事**：關閉視窗會縮到系統匣，任何時候按 **Ctrl + Alt + N** 就會跳出並開一則新筆記
- **貼圖**：在編輯器 **Ctrl + V** 直接貼上截圖（Win + Shift + S 截完直接貼）、拖曳圖片進來、或按工具列的圖片按鈕
  - 在筆記列表畫面直接 Ctrl + V，會自動用剪貼簿內容（圖片或文字）建立新筆記
  - 點圖片可調整大小（25% / 50% / 75% / 100% / 原始）或刪除，雙擊放大檢視
- **編輯**：標題、粗體、斜體、底線、刪除線、文字顏色、螢光筆、項目符號、編號、待辦清單（可打勾）、縮排、分隔線
- **整理**：所有筆記 / 我的最愛 / 資料夾（可拖曳筆記到資料夾）/ 垃圾筒（保留 30 天，可還原）
- **瀏覽**：卡片 / 清單檢視、依修改日期 / 建立日期 / 標題排序、全文搜尋
- **其他**：多選批次移動或刪除、視窗置頂、匯出成 HTML（圖片內嵌）、開機自動啟動（系統匣右鍵）

## 快捷鍵

| 按鍵 | 功能 |
|---|---|
| Ctrl + Alt + N | 在任何地方叫出 App 並新增筆記 |
| Ctrl + N | 新增筆記 |
| Ctrl + F | 搜尋 |
| Ctrl + V | 貼上圖片／文字 |
| Ctrl + 點卡片 | 多選 |
| Esc | 返回列表 |

## 下載安裝檔（不用自己編譯）

每次推送到 GitHub，Actions 會自動在 Windows 上建置：

1. 打開 GitHub 專案的 **Actions** 分頁 → 點最新一次 **Build Windows app**
2. 下方 **Artifacts** 下載 `DeskNotes-windows`，解壓後有兩個檔：
   - `DeskNotes Setup x.x.x.exe`：安裝版（有桌面捷徑、開始功能表）
   - `DeskNotes x.x.x.exe`：免安裝版，點兩下就能用

> 因為沒有程式碼簽章，第一次執行 Windows SmartScreen 可能會警告，按「其他資訊」→「仍要執行」即可。

## 自己編譯

需要先安裝 [Node.js](https://nodejs.org/)（LTS 版）。

```bash
npm install
npm start          # 直接執行
npm run dist       # 產生 Windows 安裝檔到 dist/
```

## 資料存放位置

`%APPDATA%\DeskNotes\data\`

- `notes.json`：所有筆記與資料夾（每次存檔會留一份 `notes.json.bak`）
- `images\`：貼上的圖片

備份只要複製整個 `data` 資料夾即可。系統匣右鍵選單有「開啟資料夾位置」。
