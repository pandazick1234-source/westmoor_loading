/*
  Westmoor RP — музыкальный движок загрузочного экрана и игры.
  Один и тот же файл используется на двух страницах одного сайта:
    index.html — загрузочный экран (sv_loadingurl),
    music.html — скрытая страница внутри игры (её открывает lua/rploading/cl_music.lua).
  Страницы одного адреса делят localStorage (пока запущена игра), поэтому игровая страница
  подхватывает тот же трек с той же секунды, а загрузочный экран плавно уступает ей звук.

  Против лагов:
   - каждый трек целиком скачивается в память (blob) ДО запуска, следующий — заранее, пока играет текущий;
     звук не зависит от сети и от загрузки игры (аудио Chromium работает в отдельном процессе);
   - громкость и затухания — таймером 50 мс, без анимаций и тяжёлого CSS.
  Код в стиле ES5 — на случай старого браузера в игре.
*/
(function () {
    "use strict";

    var TRACKS = [
        { file: "cyberninja.mp3",       title: "Cyberninja" },
        { file: "force_projection.mp3", title: "Force Projection" },
        { file: "gate_k9.mp3",          title: "P.T. Adamczyk — Gate K9" },
        { file: "the_rebel_path.mp3",   title: "The Rebel Path" },
        { file: "voyager.mp3",          title: "Voyager" }
    ];
    var MUSIC_DIR = "media/music/";
    var DEFAULT_VOLUME = 0.6;
    var KEY_STATE = "wm_music_state";  // { order, pos, time, ts, owner }
    var KEY_VOL = "wm_music_volume";   // "0.60"
    var KEY_TAKE = "wm_music_take";    // { owner, ts } — кто забрал звук
    var TICK = 50;

    function now() { return Date.now(); }
    function dlog(s) { try { console.log("[westmoor] " + s); } catch (e) {} }
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

    function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
    function lsJSON(k) { try { return JSON.parse(lsGet(k)); } catch (e) { return null; } }

    function shuffle(avoidFirst) {
        var a = [], i, j, t;
        for (i = 0; i < TRACKS.length; i++) a.push(i);
        for (i = a.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
        // новый круг не начинается с того же трека, которым закончился прошлый
        if (a.length > 1 && a[0] === avoidFirst) { t = a[0]; a[0] = a[1]; a[1] = t; }
        return a;
    }

    // ----- загрузка трека целиком в память -----
    var blobs = {}; // file -> { url, promise }
    function loadTrack(file) {
        if (blobs[file]) return blobs[file].promise;
        var entry = { url: null, promise: null };
        var src = MUSIC_DIR + file;
        entry.promise = new Promise(function (resolve) {
            var done = false;
            function finish(u) { if (done) return; done = true; entry.url = u; resolve(u); }
            // если fetch не работает (например, asset:// при тесте) или сеть тормозит — играем напрямую
            var timer = setTimeout(function () { finish(src); }, 15000);
            try {
                fetch(src).then(function (r) {
                    if (!r.ok) throw new Error("http " + r.status);
                    return r.blob();
                }).then(function (b) {
                    clearTimeout(timer);
                    finish(URL.createObjectURL(b));
                }).catch(function (e) { dlog("fetch failed " + src + ": " + e); clearTimeout(timer); finish(src); });
            } catch (e) { clearTimeout(timer); finish(src); }
        });
        blobs[file] = entry;
        return entry.promise;
    }
    function freeTrack(file) {
        var e = blobs[file];
        if (e && e.url && e.url.indexOf("blob:") === 0) { try { URL.revokeObjectURL(e.url); } catch (x) {} }
        delete blobs[file];
    }

    // ----- движок -----
    var WM = {
        role: "loading",
        volume: DEFAULT_VOLUME, // выбор игрока 0..1
        master: 1,              // общая громкость игры 0..1
        onTrack: null,          // function(title)
        onVolume: null,         // function(v) — громкость поменялась (сохранить)
        onDone: null,           // function() — затухание закончилось
        started: false,
        active: false,          // этот экземпляр сейчас владеет звуком
        stopped: false
    };

    var audio = new Audio();
    audio.preload = "auto";
    var order = [], pos = 0;
    var fade = 0, fadeFrom = 0, fadeTo = 0, fadeStart = 0, fadeLen = 0, fadeCb = null;
    var startedAt = now();
    var switching = false;
    var saveN = 0;

    function curFile() { return TRACKS[order[pos]].file; }

    function fadeTo_(target, seconds, cb) {
        fadeFrom = fade; fadeTo = target; fadeStart = now(); fadeLen = Math.max(1, seconds * 1000); fadeCb = cb || null;
    }

    function applyVolume() {
        // мягкое затухание в конце трека
        var tail = 1;
        if (audio.duration && isFinite(audio.duration)) {
            var left = audio.duration - audio.currentTime;
            if (left < 2.5) tail = clamp(left / 2.5, 0, 1);
        }
        // квадратичная кривая — громкость на слух меняется ровно
        var v = WM.volume * WM.volume * WM.master * fade * tail;
        try { audio.volume = clamp(v, 0, 1); } catch (e) {}
    }

    function tick() {
        if (fadeLen) {
            var k = clamp((now() - fadeStart) / fadeLen, 0, 1);
            fade = fadeFrom + (fadeTo - fadeFrom) * k;
            if (k >= 1) { fadeLen = 0; var cb = fadeCb; fadeCb = null; if (cb) cb(); }
        }
        applyVolume();
        if (WM.active && !WM.stopped && ++saveN % 5 === 0) saveState(); // раз в 250 мс
    }

    function saveState() {
        lsSet(KEY_STATE, JSON.stringify({ order: order, pos: pos, time: audio.currentTime || 0, ts: now(), owner: WM.role }));
    }

    // другой экземпляр (игра) забрал звук — плавно уходим
    function watchTake() {
        var t = lsJSON(KEY_TAKE);
        if (WM.active && t && t.owner !== WM.role && t.ts > startedAt) {
            WM.active = false;
            fadeTo_(0, 1.2, function () { audio.pause(); WM.stopped = true; });
        }
    }

    function playIndex(newPos, atTime, fadeIn) {
        switching = true;
        pos = newPos;
        var file = curFile();
        // трек уже в памяти (загружен заранее) — играем оттуда; иначе сразу потоком, без ожидания всего файла
        var ready = blobs[file] && blobs[file].url;
        (function (url) {
            if (WM.stopped) return;
            audio.src = url;
            var seek = function () {
                audio.removeEventListener("loadedmetadata", seek);
                if (atTime > 0 && audio.duration && atTime < audio.duration - 3) {
                    try { audio.currentTime = atTime; } catch (e) {}
                }
            };
            audio.addEventListener("loadedmetadata", seek);
            var p = audio.play();
            if (p && p.catch) p.catch(function (e) { dlog("music play() rejected: " + e); });
            if (fadeIn > 0) { fade = 0; fadeTo_(1, fadeIn); } else { fade = 1; }
            switching = false;
            dlog("music track " + file);
            if (WM.onTrack) WM.onTrack(TRACKS[order[pos]].title);
            prefetchNext();
        })(ready || (MUSIC_DIR + file));
    }

    function nextPos() {
        if (pos + 1 < order.length) return pos + 1;
        var last = order[order.length - 1];
        order = shuffle(last);
        return 0;
    }

    function prefetchNext() {
        var np = pos + 1 < order.length ? order[pos + 1] : null;
        // старые треки выгружаем из памяти, держим только текущий и следующий
        var keep = {}; keep[curFile()] = true;
        if (np !== null) keep[TRACKS[np].file] = true;
        for (var f in blobs) if (!keep[f]) freeTrack(f);
        if (np !== null) setTimeout(function () { loadTrack(TRACKS[np].file); }, 4000);
    }

    audio.addEventListener("ended", function () {
        if (WM.stopped || !WM.active) return;
        playIndex(nextPos(), 0, 0.8);
    });
    audio.addEventListener("error", function () {
        dlog("music error code=" + (audio.error && audio.error.code) + " src=" + String(audio.src).slice(0, 60));
        // битый файл — пропускаем
        if (WM.stopped || !WM.active || switching) return;
        setTimeout(function () { playIndex(nextPos(), 0, 0.8); }, 500);
    });

    // ----- API -----
    WM.setVolume = function (v, silent) {
        v = clamp(Number(v) || 0, 0, 1);
        WM.volume = v;
        lsSet(KEY_VOL, v.toFixed(2));
        applyVolume();
        if (!silent && WM.onVolume) WM.onVolume(v);
    };
    WM.setMaster = function (v) { WM.master = clamp(Number(v), 0, 1); if (isNaN(WM.master)) WM.master = 1; applyVolume(); };
    WM.storedVolume = function () {
        var s = lsGet(KEY_VOL);
        if (s === null || s === "") return null;
        var v = parseFloat(s);
        return isNaN(v) ? null : clamp(v, 0, 1);
    };
    WM.tracks = TRACKS;
    WM.audio = audio;
    WM.skip = function () { if (WM.active && !WM.stopped) playIndex(nextPos(), 0, 0.5); };

    // плавно заглушить и остановить (после выбора персонажа)
    WM.fadeOut = function (seconds) {
        if (WM.stopped) { if (WM.onDone) WM.onDone(); return; }
        fadeTo_(0, seconds || 5, function () {
            audio.pause();
            WM.stopped = true; WM.active = false;
            // загрузочный экран при следующем входе начнёт новый трек, а не продолжит этот
            lsSet(KEY_STATE, "");
            if (WM.onDone) WM.onDone();
        });
    };

    WM.start = function (role) {
        if (WM.started) return;
        WM.started = true;
        WM.role = role || "loading";
        startedAt = now();

        var st = lsJSON(KEY_STATE);
        var age = st && st.ts ? (now() - st.ts) / 1000 : 1e9;
        var valid = st && st.order && st.order.length === TRACKS.length && st.pos >= 0 && st.pos < TRACKS.length;

        WM.active = true;
        if (valid && age < 25) {
            // продолжаем с того же места (живой звук другой страницы или только что закрытый экран)
            order = st.order;
            var live = age < 1.5 && st.owner !== WM.role;
            var at = (st.time || 0) + age;
            if (live) lsSet(KEY_TAKE, JSON.stringify({ owner: WM.role, ts: now() }));
            pos = st.pos;
            // время пересчитываем в момент запуска: пока трек грузится, другая страница играет дальше
            var s2 = lsJSON(KEY_STATE);
            var t = at;
            if (s2 && s2.pos === pos && s2.owner !== WM.role) t = (s2.time || 0) + (now() - s2.ts) / 1000;
            // небольшой запас: пока поток догружается до нужной секунды, другая страница играет дальше
            playIndex(pos, t + (live ? 0.4 : 0), live ? 1.0 : 1.5);
        } else {
            order = shuffle(-1);
            pos = 0;
            playIndex(0, 0, 2.5);
        }
        setInterval(function () { tick(); watchTake(); }, TICK);
    };

    window.WM = WM;
})();
