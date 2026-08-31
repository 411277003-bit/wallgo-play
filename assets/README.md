# assets

## bgm.mp3

大廳背景音樂，由 `index.html` 右下角工具列的 🔈 按鈕開關（設定記在 localStorage）。

目前使用的曲目：

> **Carefree** — Kevin MacLeod ([incompetech.com](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100199))
> 授權：[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)

CC BY 4.0 要求標示出處，署名已放在 `index.html` 的「系統資訊」視窗中。
換掉這首歌時請一併更新那裡的署名，或改用不需署名的授權（CC0／public domain）。

檔案約 6.3 MB，因此 `<audio>` 設為 `preload="none"` —— 沒開音樂的使用者不會被迫下載。
瀏覽器政策禁止自動播放，音樂會在使用者第一次點擊或按鍵時才開始。

想換成自己的音樂，直接覆蓋 `bgm.mp3` 即可，不用改程式。
檔案不存在或載入失敗時頁面不會壞掉，只是沒有聲音（錯誤會記在 console）。

---

## sfx/

大廳背景對局動畫的音效，跟背景音樂共用同一顆 🔈 開關（`musicOn()`）。
瀏覽器政策同樣禁止自動播放，因此第一次點擊或按鍵前 `playSfx()` 直接略過，
不浪費一次會被擋下的 `play()`。

| 檔案 | 觸發時機 | 原始檔 |
|---|---|---|
| `piece-move.ogg` | 棋子開始移動（`startMove()`） | `chip-lay-1` — Casino Audio |
| `wall-build.ogg` | 牆蓋起來（move 動畫結束、`walls.set()`） | `impactWood_medium_000` — Impact Sounds |
| `wall-break.ogg` | 破牆（`smashWall()`，回合中破牆與開場動畫的手臂砸牆都會走這裡） | `impactMining_000` — Impact Sounds |

全部出自 [Kenney](https://kenney.nl) 的音效包，授權
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)（公共領域，
署名非必要但已在「系統資訊」視窗中標示）。

格式是 Ogg Vorbis —— Kenney 只提供這個格式。Chrome、Firefox、Edge 都原生支援；
Safari 要 17.4 以上。若要支援更舊的 Safari，需另外轉檔成 m4a 並用
`<source>` 提供備援。
