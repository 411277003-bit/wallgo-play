// wallgo_logic.js — 升級版
// 完整保留原始遊戲規則，補強：clone()、破牆追蹤、局面擴增輔助
export class WallGoGame {
    constructor() {
        this.boardSize = 13;
        this.pieces = [];
        this.walls = new Map();
        this.territories = new Map();
        this.phase = 'placement';
        this.turnIndex = 0;
        this.players = ['red', 'blue'];
        this.playersInfo = {
            red:  { hasBreaker: true },
            blue: { hasBreaker: true }
        };
        this.winner = null;
        this.scores = {};
    }

    clone() {
        const g = new WallGoGame();
        g.boardSize   = this.boardSize;
        g.pieces      = this.pieces.map(p => ({ ...p }));
        g.walls       = new Map(this.walls);
        g.territories = new Map(this.territories);
        g.phase       = this.phase;
        g.turnIndex   = this.turnIndex;
        g.players     = [...this.players];
        g.playersInfo = {
            red:  { hasBreaker: this.playersInfo.red.hasBreaker },
            blue: { hasBreaker: this.playersInfo.blue.hasBreaker }
        };
        g.winner = this.winner;
        g.scores = { ...this.scores };
        return g;
    }

    // 每回合最多走 maxSteps 格（真實遊戲為 2 步，可中途停下）。
    // 用 BFS 展開：中途格子必須是空的、且每一步不能穿牆。
    // 回傳含起點本身（代表「不再移動」的確認選項）。
    getValidMoves(startR, startC, maxSteps = 2) {
        const startKey = `${startR},${startC}`;
        const reached = new Map([[startKey, { r: startR, c: startC }]]);
        let frontier = [{ r: startR, c: startC }];

        for (let step = 0; step < maxSteps && frontier.length > 0; step++) {
            const next = [];
            for (const cur of frontier) {
                for (const [dr, dc] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
                    const nr = cur.r + dr, nc = cur.c + dc;
                    if (nr < 0 || nr >= this.boardSize || nc < 0 || nc >= this.boardSize) continue;
                    if (this.hasWallBetween(cur.r, cur.c, nr, nc)) continue;

                    const key = `${nr},${nc}`;
                    if (reached.has(key)) continue;
                    // 不能停在／穿過別的棋子（起點是自己，不算阻擋）
                    if (this.getPieceIndexAt(nr, nc) !== -1) continue;

                    reached.set(key, { r: nr, c: nc });
                    next.push({ r: nr, c: nc });
                }
            }
            frontier = next;
        }
        return Array.from(reached.values());
    }

    // 某方的行動力：可移動且移動後仍有牆可蓋的走法數
    getMobility(color) {
        let count = 0;
        for (const p of this.pieces) {
            if (p.color !== color) continue;
            for (const m of this.getValidMoves(p.r, p.c)) {
                if (m.r === p.r && m.c === p.c) continue;
                if (this.getValidWalls(m.r, m.c).length > 0) count++;
            }
        }
        return count;
    }

    // 啟發式破牆：行動力低於門檻時，拆掉自己那道「拆了行動力最高」的牆。
    // 行為對應 game(new).html 內建 AI 的破牆時機（行動力 ≤ 2）。
    // 回傳被拆的牆 key，沒使用則回傳 null。
    maybeUseBreaker(color, mobilityThreshold = 2) {
        if (!this.playersInfo[color]?.hasBreaker) return null;
        if (this.getMobility(color) > mobilityThreshold) return null;

        const myWalls = this.getMyWalls(color);
        if (myWalls.length === 0) return null;

        let bestKey = null, bestMobility = -1;
        for (const key of myWalls) {
            const probe = this.clone();
            probe.walls.delete(key);
            const m = probe.getMobility(color);
            if (m > bestMobility) { bestMobility = m; bestKey = key; }
        }
        return this.applyBreaker(color, bestKey) ? bestKey : null;
    }

    getValidWalls(pR, pC) {
        const validWalls = [];
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const wr = pR + dr, wc = pC + dc;
            if (wr >= 0 && wr < this.boardSize &&
                wc >= 0 && wc < this.boardSize &&
                !this.walls.has(`${wr},${wc}`)) {
                validWalls.push({ r: wr, c: wc });
            }
        }
        return validWalls;
    }

    hasWallBetween(r1, c1, r2, c2) {
        if (r1 === r2 && c1 === c2) return false;
        const wallR = (r1 + r2) / 2;
        const wallC = (c1 + c2) / 2;
        return this.walls.has(`${wallR},${wallC}`);
    }

    getPieceIndexAt(r, c) {
        return this.pieces.findIndex(p => p.r === r && p.c === c);
    }

    applyMove(pieceIndex, targetR, targetC, wallR, wallC, color) {
        this.pieces[pieceIndex].r = targetR;
        this.pieces[pieceIndex].c = targetC;
        this.walls.set(`${wallR},${wallC}`, color);
        // 單調遞增的回合計數。取用當前玩家的地方都有再取 % players.length，
        // 這裡不能先取模，否則 encodeState 的「回合進度」特徵會退化成 0/1 的奇偶位元。
        this.turnIndex++;
    }

    applyBreaker(color, wallKey) {
        if (!this.playersInfo[color].hasBreaker) return false;
        if (!this.walls.has(wallKey)) return false;
        if (this.walls.get(wallKey) !== color) return false;
        this.walls.delete(wallKey);
        this.playersInfo[color].hasBreaker = false;
        return true;
    }

    getMyWalls(color) {
        return Array.from(this.walls.entries())
            .filter(([, v]) => v === color)
            .map(([k]) => k);
    }

    checkEndGame() {
        if (this.phase === 'placement') return;
        this.players.forEach(c => { this.scores[c] = 0; });
        const visited = new Set();
        let hasMixedTerritory = false;
        this.territories.clear();

        for (let r = 0; r < this.boardSize; r += 2) {
            for (let c = 0; c < this.boardSize; c += 2) {
                if (visited.has(`${r},${c}`)) continue;
                const queue = [{ r, c }];
                visited.add(`${r},${c}`);
                let regionSize = 0;
                const colorsInRegion = new Set();
                const regionCells = [];

                while (queue.length > 0) {
                    const curr = queue.shift();
                    regionSize++;
                    regionCells.push(curr);
                    const pieceIdx = this.getPieceIndexAt(curr.r, curr.c);
                    if (pieceIdx !== -1) colorsInRegion.add(this.pieces[pieceIdx].color);

                    for (const [dr, dc, wr, wc] of [[-2,0,-1,0],[2,0,1,0],[0,-2,0,-1],[0,2,0,1]]) {
                        const nr = curr.r + dr, nc = curr.c + dc;
                        const w_r = curr.r + wr, w_c = curr.c + wc;
                        if (nr >= 0 && nr < this.boardSize && nc >= 0 && nc < this.boardSize &&
                            !this.walls.has(`${w_r},${w_c}`) && !visited.has(`${nr},${nc}`)) {
                            visited.add(`${nr},${nc}`);
                            queue.push({ r: nr, c: nc });
                        }
                    }
                }

                if (colorsInRegion.size > 1) {
                    hasMixedTerritory = true;
                } else if (colorsInRegion.size === 1) {
                    const color = Array.from(colorsInRegion)[0];
                    this.scores[color] += regionSize;
                    regionCells.forEach(cell => this.territories.set(`${cell.r},${cell.c}`, color));
                }
            }
        }

        let anyPlayerCanMove = false;
        for (const color of this.players) {
            if (this.playersInfo[color].hasBreaker && this.getMyWalls(color).length > 0) {
                anyPlayerCanMove = true; break;
            }
            const playerPieces = this.pieces.filter(p => p.color === color);
            for (const p of playerPieces) {
                const moves = this.getValidMoves(p.r, p.c);
                for (const m of moves) {
                    if (this.getValidWalls(m.r, m.c).length > 0) {
                        anyPlayerCanMove = true; break;
                    }
                }
                if (anyPlayerCanMove) break;
            }
            if (anyPlayerCanMove) break;
        }

        if (!hasMixedTerritory || !anyPlayerCanMove) {
            this.phase = 'game_over';
            let maxScore = -1, winner = null;
            for (const color of this.players) {
                if (this.scores[color] > maxScore) {
                    maxScore = this.scores[color]; winner = color;
                } else if (this.scores[color] === maxScore) {
                    winner = 'Draw';
                }
            }
            this.winner = winner;
        }
    }

    getCurrentPlayer() {
        return this.players[this.turnIndex % this.players.length];
    }

    getBoardScore(color) {
        const opp = color === 'red' ? 'blue' : 'red';
        return (this.scores[color] || 0) - (this.scores[opp] || 0);
    }
}