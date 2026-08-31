// wallgo_logic.js
export class WallGoGame {
    constructor() {
        this.boardSize = 13;
        this.pieces = []; 
        this.walls = new Map(); // 記錄牆壁 "r,c" -> color
        this.territories = new Map();
        this.phase = 'placement'; // placement, movement, wall_building, game_over
        this.turnIndex = 0;
        this.players = ['red', 'blue']; // 預設訓練用 1v1
        this.winner = null;
    }

    // 將你原本的規則邏輯搬過來，並稍微改寫成類別方法
    getValidMoves(startR, startC) {
        const validMoves = [];
        for (let r = 0; r < this.boardSize; r += 2) {
            for (let c = 0; c < this.boardSize; c += 2) {
                const dr = Math.abs(startR - r); 
                const dc = Math.abs(startC - c);
                // L 型走法判斷
                if ((dr === 2 && dc === 0) || (dr === 0 && dc === 2) || (dr === 0 && dc === 0)) {
                    if (this.getPieceIndexAt(r, c) === -1 || (r === startR && c === startC)) {
                        if (!this.hasWallBetween(startR, startC, r, c)) {
                            validMoves.push({ r, c });
                        }
                    }
                }
            }
        }
        return validMoves;
    }

    getValidWalls(pR, pC) {
        const validWalls = [];
        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (let [dr, dc] of dirs) {
            const wr = pR + dr, wc = pC + dc;
            if (wr >= 0 && wr < this.boardSize && wc >= 0 && wc < this.boardSize && !this.walls.has(`${wr},${wc}`)) {
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

    // 完整的結算邏輯 (包含 BFS 領土計算)
    checkEndGame() {
        if (this.phase === 'placement') return;
        
        let gameOver = false;
        let scores = {}; 
        
        // 初始化分數
        this.players.forEach(c => scores[c] = 0);
        
        let visited = new Set(); 
        let hasMixedTerritory = false; 
        this.territories.clear(); 

        // 1. 執行 BFS 掃描所有領土與封閉區域
        for (let r = 0; r < this.boardSize; r += 2) {
            for (let c = 0; c < this.boardSize; c += 2) {
                if (visited.has(`${r},${c}`)) continue;
                
                let queue = [{r, c}]; 
                visited.add(`${r},${c}`);
                let regionSize = 0; 
                let colorsInRegion = new Set(); 
                let regionCells = []; 

                while(queue.length > 0) {
                    const curr = queue.shift(); 
                    regionSize++; 
                    regionCells.push(curr); 
                    
                    const pieceIdx = this.getPieceIndexAt(curr.r, curr.c);
                    if (pieceIdx !== -1) {
                        colorsInRegion.add(this.pieces[pieceIdx].color);
                    }

                    const dirs = [[-2, 0, -1, 0], [2, 0, 1, 0], [0, -2, 0, -1], [0, 2, 0, 1]];
                    for (const [dr, dc, wr, wc] of dirs) {
                        const nr = curr.r + dr;
                        const nc = curr.c + dc; 
                        const w_r = curr.r + wr;
                        const w_c = curr.c + wc;
                        
                        // 如果沒有越界、沒有撞到牆壁、且還沒走訪過，就加入佇列
                        if (nr >= 0 && nr < this.boardSize && nc >= 0 && nc < this.boardSize && 
                            !this.walls.has(`${w_r},${w_c}`) && !visited.has(`${nr},${nc}`)) {
                            visited.add(`${nr},${nc}`); 
                            queue.push({r: nr, c: nc});
                        }
                    }
                }
                
                // 判斷這塊區域的歸屬
                if (colorsInRegion.size > 1) {
                    hasMixedTerritory = true; // 還有混戰區域，遊戲通常還沒結束
                } else if (colorsInRegion.size === 1) {
                    const color = Array.from(colorsInRegion)[0];
                    scores[color] += regionSize;
                    regionCells.forEach(cell => this.territories.set(`${cell.r},${cell.c}`, color));
                }
            }
        }

        // 2. 檢查是否所有玩家都無法再移動 (死局檢查)
        let anyPlayerCanMove = false;
        for (const color of this.players) {
            const playerPieces = this.pieces.filter(p => p.color === color);
            for (const p of playerPieces) {
                const moves = this.getValidMoves(p.r, p.c);
                for (const m of moves) {
                    if (this.getValidWalls(m.r, m.c).length > 0) { 
                        anyPlayerCanMove = true; 
                        break; 
                    }
                }
                if (anyPlayerCanMove) break;
            }
            if (anyPlayerCanMove) break;
        }

        // 3. 判斷遊戲是否達到結束條件
        if (!hasMixedTerritory || !anyPlayerCanMove) {
            gameOver = true;
        }

        // 4. 結算並決定贏家
        if (gameOver) {
            this.phase = 'game_over';
            this.scores = scores;
            
            // 找出最高分的陣營
            let maxScore = -1;
            let currentWinner = null;
            
            for (const color of this.players) {
                if (scores[color] > maxScore) {
                    maxScore = scores[color];
                    currentWinner = color;
                } else if (scores[color] === maxScore) {
                    currentWinner = 'Draw'; // 同分平手
                }
            }
            
            this.winner = currentWinner;
        }
    }

    // 提供給外部強制執行的動作
    applyMove(pieceIndex, targetR, targetC, wallR, wallC, color) {
        this.pieces[pieceIndex].r = targetR;
        this.pieces[pieceIndex].c = targetC;
        this.walls.set(`${wallR},${wallC}`, color);
        // 切換回合
        this.turnIndex = (this.turnIndex + 1) % this.players.length;
    }
}