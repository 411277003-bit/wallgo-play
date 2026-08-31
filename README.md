# Wall Go 牆壁戰棋

線上／單機的牆壁戰棋（Wall Go），支援 2～4 人連線對戰、AI 對手、聊天室與 WebRTC 語音。

## 專案架構

```
.
├── index.html          # 大廳：登入註冊、房間、好友、戰績、覆盤
├── game.html           # 對局頁：棋盤、計時、聊天室、語音
├── app.py              # Flask + Socket.IO 伺服器（房間、對局同步、帳號 API）
├── requirements.txt    # Python 相依套件
├── assets/             # 靜態資源（背景音樂）
└── ai-training/        # 獨立的 AlphaZero 訓練專案（目前未被前端引用）
    ├── ai_agent.js         # 網路結構、MCTS 與推論
    ├── wallgo_logic.js     # 純邏輯版棋規，供自我對弈使用
    ├── train.js            # 自我對弈訓練主程式
    ├── worker.js           # 平行自我對局的子進程
    ├── model_io.js         # 模型讀寫
    ├── verify_fixes.mjs    # 17 項回歸測試
    ├── eval_vs_random.mjs  # 對隨機對手的健全性檢查
    ├── diag_visits.mjs     # 根節點訪問分佈診斷
    ├── sync_to_usb.sh      # 把訓練產物同步回隨身碟
    ├── FINDINGS.md         # 訓練診斷紀錄（含尚未解決的問題）
    ├── train.log           # 完整訓練輸出
    ├── alpha_model/        # 最新模型（第 10 輪）
    ├── alpha_model_best/   # 目前最強模型
    ├── alpha_model_ckpt5/  # 第 5 輪 checkpoint
    ├── alpha_model_ckpt10/ # 第 10 輪 checkpoint
    └── archive/            # 舊的（1 步移動 bug）模型，僅供對照
```

前端是純靜態頁面（可放 GitHub Pages），後端另外部署；前端以 `index.html` 內的 `API_URL` 指向後端網址。

## 本機執行

**後端**

```bash
pip install -r requirements.txt
export MONGO_URI="mongodb://localhost:27017/"   # 未設定時預設連本機
python app.py
```

**前端**

必須用 HTTP(S) 開啟，不能直接雙擊檔案。`file://` 協定下瀏覽器會擋掉麥克風：

```bash
python -m http.server 5500
# 然後開 http://localhost:5500/index.html
```

或使用 VS Code 的 Live Server。

**AI 訓練**

```bash
cd ai-training
npm install
node train.js            # 自我對弈訓練
node verify_fixes.mjs    # 回歸測試
node eval_vs_random.mjs alpha_model 20 100   # 對隨機對手評估
```

訓練現況與已知問題記在 `ai-training/FINDINGS.md`：MCTS 換手、破牆特徵、
2 步移動等五項 bug 已修正，但第 2–10 輪 180 局中新模型只有 36% 勝率，
策略熵持續上升 —— 詳細診斷與後續方向見該檔。

網頁端的 AI 對手目前用的是 `game.html` 內建的啟發式邏輯，
**尚未接上這裡訓練出來的模型**。

## 語音（WebRTC）

對局頁左下角的 🎤 按鈕會在進入連線房間後出現。語音走 PeerJS（P2P），訊令交換借用 Socket.IO 聊天頻道的 `[SYS_PEER_ID]:` 訊息。

麥克風只在 **https** 或 **localhost** 下可用，這是瀏覽器的安全限制。

## 授權

背景音樂 **Carefree** by Kevin MacLeod（[incompetech.com](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100199)），
授權 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。
