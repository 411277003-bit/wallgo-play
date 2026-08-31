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
