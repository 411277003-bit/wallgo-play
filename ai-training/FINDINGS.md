# Wall Go AlphaZero 訓練診斷紀錄

日期：2026-08-26

## 環境

原專案在 FAT32 隨身碟上，**無法安裝 `@tensorflow/tfjs-node`**——libtensorflow 的
壓縮檔內含 symlink（`libtensorflow_framework.so` → `.so.2`），FAT32 不支援。

因此訓練改在 ext4 的 `~/wallgo-training/` 進行，用 `sync_to_usb.sh` 同步回隨身碟。
Node.js v22.14.0 裝在 `~/.local/share/nodejs/`（免 sudo）。

效能：改用 `tfjs-node` 原生 backend ＋ 12 進程平行後，自我對局從 65 秒/局
降到 1.4 秒/局（200 次模擬時為 3.5 秒/局），約 45 倍。

**GPU（RTX 5090）沒有被使用，也不值得使用**：MCTS 是 batch-size=1 的序列推論，
模型只有 344,680 參數，屬於延遲瓶頸而非算力瓶頸。真正的資源是 24 核 CPU。

## 已修正的問題

| # | 問題 | 位置 | 修正 |
|---|---|---|---|
| ① | MCTS 搜尋樹中對手從不出手，且反向傳播不變號 | `ai_agent.js` `_simulate`/`_expand`/`_evaluate` | `MCTSNode` 加 `toMove`，逐層換手；backprop 每層 `value = -value`；`ucb()` 改標準 PUCT 並對子節點取負號 |
| ② | `turnIndex` 取模 2，導致「回合進度」特徵退化成奇偶位元 | `wallgo_logic.js:84` | 改為單調遞增（取用當前玩家處本來就有再取模） |
| ③ | 破牆者 `applyBreaker` 從未被呼叫，特徵平面 5/6 恆為 1 | `wallgo_logic.js`, `worker.js` | 新增 `getMobility()` / `maybeUseBreaker()`，對局迴圈每回合呼叫（時機同 `game(new).html` 內建 AI：行動力 ≤ 2） |
| ④ | 訓練用 1 步移動，真實遊戲是最多 2 步 | `wallgo_logic.js` `getValidMoves` | 改 BFS 深度 2，正確處理穿牆與棋子阻擋。動作空間仍為 392 |
| ⑤ | Dirichlet 探索雜訊在評估與實戰時也會加入 | `ai_agent.js` `_expand` | 加 `addNoise` 參數，只有 `getMCTSPolicy`（自我對局）傳 true |

⑤ 會系統性偏袒策略平坦的模型：未訓練的網路輸出接近均勻，混入 25% 雜訊幾乎無影響；
訓練過的網路策略尖銳，同樣雜訊會把好手打散。

回歸測試：`node verify_fixes.mjs`（17 項）。

## 尚未解決的核心問題

修正 ①–④ 後重新從零訓練 10 輪，**沒有改善**：

| 輪次 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| 新模型勝率 | 55%* | 30% | 45% | 30% | 45% | 45% | 45% | 30% | 25% | 30% |

\* 第 1 輪 `alpha_model_best/` 尚不存在，`train.js` 的 fallback 讓模型跟自己對打，
此數據無意義，僅用於建立基準模型。

第 2–10 輪共 180 局，新模型 65 勝，**勝率 36%**。標準誤 3.7pp，
離 50% 有 3.7 個標準差（p < 0.001）——不是雜訊，是真的比較弱。

### 診斷：自我強化的惡性迴圈

對隨機對手的健全性檢查（`node eval_vs_random.mjs <模型> 20 100`）：

- `alpha_model_best`（第 1 輪）：95% 勝率
- `alpha_model`（第 10 輪）：90% 勝率

兩者都遠勝隨機（代表 MCTS 有效），但**訓練 9 輪後反而退步**。

根節點訪問分佈（`node diag_visits.mjs`），有效選項數 = exp(熵)，
越接近分支數 46 代表越接近均勻雜訊：

| 模型 | 200 次模擬 | 800 次模擬 |
|---|---|---|
| 第 1 輪 | 37.7 / 46（幾乎均勻） | 25.8 / 46 |
| 第 10 輪 | 11.3 / 46（很集中） | 7.9 / 46 |

迴圈的形成：

1. 第 1 輪網路隨機初始化，先驗近似均勻。200 次模擬分給 46 個子節點，
   平均每個 4.3 次 → 訪問分佈是雜訊（37.7/46），policy 目標不含資訊
2. `epochs: 5` 把這團雜訊狠狠背下來，網路學到一組任意但尖銳的偏好
3. 這些偏好成為 MCTS 先驗，PUCT 把搜尋集中過去
4. 下一輪的訪問統計「確認」了這些偏好 → 鎖死

第 10 輪的模型不是沒學到東西，是**自信地學錯了**。第 1 輪那個接近均勻的先驗
反而讓 MCTS 能廣泛探索，所以下得比較好。

### 建議的下一步

關鍵是讓早期的 policy 目標有訊息量：

| 參數 | 現值 | 建議 | 理由 |
|---|---|---|---|
| `mctsSimulations` | 200 | **800** | 模擬次數必須遠大於分支數（46~96），否則訪問統計是雜訊 |
| `epochs` | 5 | **1** | 別把雜訊目標背起來 |
| `gamesPerIteration` | 30 | **50** | 多樣本平均掉雜訊 |
| `evalGames` | 20 | **60~100** | 20 局的標準誤 11pp，無法支撐 55% 的晉升門檻 |

預估：約 15 分鐘一輪，10 輪約 2.5 小時。

其他次要項（尚未處理）：

- `replayBuffer` 是區域變數，重啟程式就清空，未持久化到磁碟
- policy/value head 的 `dropout: 0.3`，AlphaZero 通常不用 dropout
- `targetScore: 100` 只是停止條件，與模型強度無關。
  真正該當停止條件的是「連續 N 輪無法晉升」
- `train.js` 第 1 輪的 self-vs-self fallback 會產生無意義的晉升

## 檔案

| 檔案 | 用途 |
|---|---|
| `train.js` | 主訓練迴圈（多進程平行） |
| `worker.js` | 自我對局／評估的子進程 |
| `model_io.js` | 模型讀寫（train 與 worker 共用） |
| `ai_agent.js` | MCTS ＋ 狀態編碼 |
| `wallgo_logic.js` | 遊戲規則 |
| `verify_fixes.mjs` | 修正項的回歸測試（17 項） |
| `eval_vs_random.mjs` | 診斷：模型 vs 隨機對手 |
| `diag_visits.mjs` | 診斷：MCTS 根節點訪問分佈 |
| `sync_to_usb.sh` | 同步到隨身碟（`--force` 可在訓練中執行，會驗證權重完整性） |
| `archive/*_1step_buggy/` | 修正前的舊模型（1 步規則、MCTS 不換手），紅 91 / 藍 111 |
