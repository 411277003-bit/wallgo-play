// ai_agent.js — 升級版（AlphaZero 風格 MCTS + Policy/Value Network）
import * as tf from '@tensorflow/tfjs-node';

// ═══════════════════════════════════════════════════════
//  MCTS 節點
// ═══════════════════════════════════════════════════════
class MCTSNode {
    constructor(game, toMove, parent = null, action = null, prior = 0) {
        this.game     = game;       // WallGoGame clone
        this.toMove   = toMove;     // 此節點輪到誰走（樹每往下一層就換手）
        this.parent   = parent;
        this.action   = action;     // 導致此節點的動作 {pIdx,mr,mc,wr,wc}
        this.prior    = prior;      // policy network 給的先驗概率
        this.visits   = 0;
        this.value    = 0;          // 累積價值，以 this.toMove 的視角計
        this.children = [];
        this.expanded = false;
    }

    // PUCT。子節點的 value 是「子節點該走的人」的視角，
    // 對父節點來說是對手的期望值，所以取負號才是自己的 Q。
    ucb(cPuct = 1.5) {
        const q = this.visits === 0 ? 0 : -this.value / this.visits;
        const parentVisits = Math.max(1, this.parent ? this.parent.visits : 1);
        const u = cPuct * this.prior * Math.sqrt(parentVisits) / (1 + this.visits);
        return q + u;
    }
}

// ═══════════════════════════════════════════════════════
//  主 AI 類別
// ═══════════════════════════════════════════════════════
export class WallGoAI {
    constructor(model = null) {
        this.model = model;
        // 行動空間：2棋子 × 49目標格 × 4牆方向 = 392
        this.numActions = 392;
    }

    // ───────────────────────────────────────────────────
    //  狀態編碼 → [7,7,8] tensor（比原版多3個平面）
    //  平面0: 我方棋子
    //  平面1: 對方棋子
    //  平面2: 水平牆（行奇、列偶）
    //  平面3: 垂直牆（行偶、列奇）
    //  平面4: 全1（偏置）
    //  平面5: 我方破牆剩餘（0或1）
    //  平面6: 對方破牆剩餘
    //  平面7: 回合數（標準化）
    // ───────────────────────────────────────────────────
    encodeState(game, aiColor) {
        return tf.tidy(() => {
            const buffer = tf.buffer([7, 7, 8]);
            const opp = aiColor === 'red' ? 'blue' : 'red';

            // 棋子
            game.pieces.forEach(p => {
                const gridR = Math.floor(p.r / 2);
                const gridC = Math.floor(p.c / 2);
                if (gridR >= 0 && gridR < 7 && gridC >= 0 && gridC < 7) {
                    buffer.set(1, gridR, gridC, p.color === aiColor ? 0 : 1);
                }
            });

            // 牆壁
            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 7; c++) {
                    const realR = r * 2, realC = c * 2;
                    if (game.walls.has(`${realR - 1},${realC}`)) buffer.set(1, r, c, 2); // 水平牆（北）
                    if (game.walls.has(`${realR + 1},${realC}`)) buffer.set(1, r, c, 2); // 水平牆（南）
                    if (game.walls.has(`${realR},${realC - 1}`)) buffer.set(1, r, c, 3); // 垂直牆（西）
                    if (game.walls.has(`${realR},${realC + 1}`)) buffer.set(1, r, c, 3); // 垂直牆（東）
                }
            }

            // 全1 偏置
            for (let r = 0; r < 7; r++)
                for (let c = 0; c < 7; c++)
                    buffer.set(1, r, c, 4);

            // 破牆剩餘
            const myBreaker  = game.playersInfo[aiColor]?.hasBreaker  ? 1 : 0;
            const oppBreaker = game.playersInfo[opp]?.hasBreaker ? 1 : 0;
            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 7; c++) {
                    buffer.set(myBreaker,  r, c, 5);
                    buffer.set(oppBreaker, r, c, 6);
                }
            }

            // 回合數估計（標準化）
            const turnNorm = Math.min(game.turnIndex / 60, 1);
            for (let r = 0; r < 7; r++)
                for (let c = 0; c < 7; c++)
                    buffer.set(turnNorm, r, c, 7);

            return buffer.toTensor().expandDims(0);
        });
    }

    // ───────────────────────────────────────────────────
    //  動作 ↔ 索引 轉換
    // ───────────────────────────────────────────────────
    encodeAction(relPIdx, mr, mc, wr, wc) {
        const targetSquare = Math.floor(mr / 2) * 7 + Math.floor(mc / 2);
        let wallDir = 0;
        if (wr === mr - 1) wallDir = 0; // 北
        if (wr === mr + 1) wallDir = 1; // 南
        if (wc === mc - 1) wallDir = 2; // 西
        if (wc === mc + 1) wallDir = 3; // 東
        return (relPIdx * 49 * 4) + (targetSquare * 4) + wallDir;
    }

    decodeAction(idx, game, aiColor) {
        const myPieces = game.pieces
            .map((p, i) => ({ ...p, pArrIdx: i }))
            .filter(p => p.color === aiColor);

        const pIdx = Math.floor(idx / 196);
        const remainder = idx % 196;
        const targetSquare = Math.floor(remainder / 4);
        const wallDir = remainder % 4;

        const mr = Math.floor(targetSquare / 7) * 2;
        const mc = (targetSquare % 7) * 2;

        let wr = mr, wc = mc;
        if (wallDir === 0) wr = mr - 1;
        if (wallDir === 1) wr = mr + 1;
        if (wallDir === 2) wc = mc - 1;
        if (wallDir === 3) wc = mc + 1;

        const targetPiece = myPieces[pIdx] || myPieces[0];
        return { pIdx: targetPiece?.pArrIdx ?? 0, mr, mc, wr, wc };
    }

    // ───────────────────────────────────────────────────
    //  合法動作遮罩
    // ───────────────────────────────────────────────────
    getActionMask(game, aiColor) {
        const mask = new Array(this.numActions).fill(0);
        const myPieces = game.pieces
            .map((p, i) => ({ ...p, pArrIdx: i }))
            .filter(p => p.color === aiColor);

        myPieces.forEach((p, relIdx) => {
            const moves = game.getValidMoves(p.r, p.c);
            moves.forEach(m => {
                if (m.r === p.r && m.c === p.c) return; // 略過原地「確認」選項
                game.getValidWalls(m.r, m.c).forEach(w => {
                    const idx = this.encodeAction(relIdx, m.r, m.c, w.r, w.c);
                    if (idx >= 0 && idx < this.numActions) mask[idx] = 1;
                });
            });
        });
        return mask;
    }

    // ───────────────────────────────────────────────────
    //  隨機合法動作
    // ───────────────────────────────────────────────────
    getRandomMove(game, aiColor) {
        const myPieces = game.pieces
            .map((p, i) => ({ ...p, idx: i }))
            .filter(p => p.color === aiColor);
        const validActions = [];
        myPieces.forEach(p => {
            const moves = game.getValidMoves(p.r, p.c).filter(m => !(m.r === p.r && m.c === p.c));
            moves.forEach(m => {
                game.getValidWalls(m.r, m.c).forEach(w => {
                    validActions.push({ pIdx: p.idx, mr: m.r, mc: m.c, wr: w.r, wc: w.c });
                });
            });
        });
        if (validActions.length === 0) return null;
        return validActions[Math.floor(Math.random() * validActions.length)];
    }

    // ───────────────────────────────────────────────────
    //  MCTS 主入口（AlphaZero 風格）
    //  simulations: 模擬次數（訓練用80，對戰可用200+）
    //  epsilon: 訓練時探索率（建議0.15～0.25）
    // ───────────────────────────────────────────────────
    async getBestMove(game, aiColor, simulations = 80, epsilon = 0.0) {
        if (!this.model) return this.getRandomMove(game, aiColor);
        if (Math.random() < epsilon) return this.getRandomMove(game, aiColor);

        const root = new MCTSNode(game.clone(), aiColor);
        await this._expand(root);

        for (let i = 0; i < simulations; i++) {
            await this._simulate(root);
        }

        if (root.children.length === 0) return this.getRandomMove(game, aiColor);

        // 選最多訪問次數的子節點
        let best = root.children[0];
        for (const child of root.children) {
            if (child.visits > best.visits) best = child;
        }
        return best.action;
    }

    async _simulate(node) {
        // 選擇
        let curr = node;
        while (curr.expanded && curr.children.length > 0) {
            curr = curr.children.reduce((a, b) => a.ucb() > b.ucb() ? a : b);
        }
        // 擴展
        if (!curr.expanded && curr.game.phase !== 'game_over') {
            await this._expand(curr);
        }
        // 評估（以 curr.toMove 的視角）
        let value = await this._evaluate(curr);
        // 反向傳播：每往上一層就換手，價值取負號
        let n = curr;
        while (n !== null) {
            n.visits++;
            n.value += value;
            value = -value;
            n = n.parent;
        }
    }

    // addNoise 只在自我對局（產生訓練資料）的根節點為 true。
    // 評估與實際對戰時必須關閉，否則會系統性地偏袒「策略越平坦」的模型：
    // 未訓練的網路輸出接近均勻分佈，混入 25% 雜訊幾乎不受影響；
    // 訓練過的網路策略很尖銳，同樣的雜訊會把它的好手打散。
    async _expand(node, addNoise = false) {
        node.expanded = true;
        const color = node.toMove;
        const opp   = color === 'red' ? 'blue' : 'red';

        const mask = this.getActionMask(node.game, color);
        const validIndices = mask.reduce((a, v, i) => { if (v) a.push(i); return a; }, []);
        if (validIndices.length === 0) return;

        // Policy network 給先驗
        let priors;
        try {
            priors = tf.tidy(() => {
                const input = this.encodeState(node.game, color);
                const [pOut] = this.model.predict(input);
                return Array.from(pOut.dataSync());
            });
        } catch {
            priors = new Array(this.numActions).fill(1 / this.numActions);
        }

        // Dirichlet noise（僅自我對局的根節點）
        if (addNoise && !node.parent) {
            const noise = this._dirichletNoise(validIndices.length, 0.3);
            validIndices.forEach((idx, i) => {
                priors[idx] = 0.75 * priors[idx] + 0.25 * noise[i];
            });
        }

        // 建子節點：子節點輪到對手走
        for (const idx of validIndices) {
            const action = this.decodeAction(idx, node.game, color);
            const childGame = node.game.clone();
            childGame.applyMove(action.pIdx, action.mr, action.mc, action.wr, action.wc, color);
            childGame.checkEndGame();
            node.children.push(new MCTSNode(childGame, opp, node, action, priors[idx]));
        }
    }

    async _evaluate(node) {
        const me = node.toMove;
        if (node.game.phase === 'game_over') {
            if (!node.game.winner || node.game.winner === 'Draw') return 0;
            return node.game.winner === me ? 1 : -1;
        }
        // Value network 評估（value head 的語意就是「該走的人」的勝率）
        try {
            return tf.tidy(() => {
                const input = this.encodeState(node.game, me);
                const [, vOut] = this.model.predict(input);
                return vOut.dataSync()[0];
            });
        } catch {
            return 0;
        }
    }

    _dirichletNoise(n, alpha) {
        // 近似 Dirichlet 分佈（用 Gamma 分佈）
        const samples = Array.from({ length: n }, () => {
            let s = 0;
            for (let i = 0; i < 4; i++) s -= Math.log(Math.random() + 1e-10);
            return s * alpha;
        });
        const sum = samples.reduce((a, b) => a + b, 0) + 1e-10;
        return samples.map(x => x / sum);
    }

    // ───────────────────────────────────────────────────
    //  取得 MCTS 後的動作概率（訓練用）
    // ───────────────────────────────────────────────────
    async getMCTSPolicy(game, aiColor, simulations = 80, temperature = 1.0) {
        if (!this.model) {
            const mask = this.getActionMask(game, aiColor);
            const valid = mask.reduce((a, v, i) => { if (v) a.push(i); return a; }, []);
            const policy = new Array(this.numActions).fill(0);
            if (valid.length) policy[valid[Math.floor(Math.random() * valid.length)]] = 1;
            return policy;
        }

        const root = new MCTSNode(game.clone(), aiColor);
        await this._expand(root, true);   // 自我對局：根節點加探索雜訊
        for (let i = 0; i < simulations; i++) await this._simulate(root);

        const policy = new Array(this.numActions).fill(0);
        if (root.children.length === 0) return policy;

        if (temperature < 0.01) {
            // 貪婪：只給最多訪問的動作概率1
            const best = root.children.reduce((a, b) => a.visits > b.visits ? a : b);
            const idx = this.encodeAction(
                best.action.pIdx % 2,
                best.action.mr, best.action.mc,
                best.action.wr, best.action.wc
            );
            if (idx >= 0 && idx < this.numActions) policy[idx] = 1;
        } else {
            // 溫度軟化
            const visits = root.children.map(c => Math.pow(c.visits, 1 / temperature));
            const total = visits.reduce((a, b) => a + b, 0) + 1e-10;
            root.children.forEach((child, i) => {
                const idx = this.encodeAction(
                    child.action.pIdx % 2,
                    child.action.mr, child.action.mc,
                    child.action.wr, child.action.wc
                );
                if (idx >= 0 && idx < this.numActions) policy[idx] = visits[i] / total;
            });
        }
        return policy;
    }
}