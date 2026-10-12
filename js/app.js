'use strict';
/* app.js — 画布、交互、动画、导出流程 */
(function () {
  var BASE_W = 960, BASE_H = 600, BEAT_HZ = 130 / 60;   /* 节奏固定 130 BPM */

  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');

  var S = {
    bgImg: null, bgRect: null,
    subjs: [],
    speed: 1, amp: 0.5,
    playing: true,
    bgMode: 'image',
    bgColor: '#ffffff',
    dither: true,
    shadow: true,
    ratio: 1,
    spin: false, spinRate: 0.5, thick: 0,
    pauseT: 0,
    sel: null
  };

  /* ---- DOM ---- */
  var $ = function (id) { return document.getElementById(id); };
  var nameBg = $('nameBg'), nameSubj = $('nameSubj');
  var spSpeed = $('spSpeed'), spAmp = $('spAmp'), spSubjSize = $('spSubjSize'), spBgSize = $('spBgSize');
  var spSpin = $('spSpin'), spThick = $('spThick');
  var rdSpeed = $('rdSpeed'), rdAmp = $('rdAmp'), rdHz = $('rdHz');
  var rdSubjSize = $('rdSubjSize'), rdBgSize = $('rdBgSize');
  var rdSpin = $('rdSpin'), rdThick = $('rdThick');
  var btnPause = $('btnPause'), btnExport = $('btnExport');
  var progressWrap = $('progressWrap'), progressFill = $('progressFill');
  var stLeft = $('stLeft'), stRight = $('stRight');
  var dlgAbout = $('dlgAbout');

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function say(msg) { stLeft.textContent = msg; }

  /* ---- 摇动模型 ---- */
  /* 原地挤压拉伸：底边贴地不动，不跳起来。
     一拍内先整体下压变矮、同时变宽，再反弹拉高变窄。 */
  function bounceAt(t) {
    var beats = t * BEAT_HZ * S.speed;
    var tau = beats - Math.floor(beats);
    var d = -Math.sin(2 * Math.PI * tau) * S.amp;   /* <0 压扁变宽，>0 拉高变窄 */
    /* 压得狠弹得高：默认幅度下压到一半高、拉到 1.5 倍高 */
    return { scaleY: Math.max(0.18, 1 + 1.0 * d), scaleX: 1 - 0.8 * d };
  }
  var IDLE = { scaleX: 1, scaleY: 1 };

  /* ---- 绘制 ---- */
  /* 主体轮廓蒙版：用于生成贴合图片边缘的地面投影 */
  function makeSilhouette(img) {
    var cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    var g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#000';
    g.fillRect(0, 0, cv.width, cv.height);
    return cv;
  }

  function drawScene(c, W, H, t, forExport, rate) {
    /* 画面按导出比例居中裁切（cover），比例变化时主体尽量不丢 */
    var s = Math.max(W / BASE_W, H / BASE_H);
    var ox = (W - BASE_W * s) / 2, oy = (H - BASE_H * s) / 2;
    c.clearRect(0, 0, W, H);
    if (S.bgMode === 'color' || (S.bgMode === 'image' && !S.bgImg)) {
      c.fillStyle = S.bgColor;
      c.fillRect(0, 0, W, H);
    }
    c.save();
    c.translate(ox, oy);
    if (S.bgMode === 'image' && S.bgRect) {
      c.drawImage(S.bgImg, S.bgRect.x * s, S.bgRect.y * s, S.bgRect.w * s, S.bgRect.h * s);
    }
    for (var si = 0; si < S.subjs.length; si++) drawSubject(c, s, S.subjs[si], t, rate);
    c.restore();
    if (!forExport) {
      if (S.sel) drawSel(c, s, ox, oy);
      drawCropGuide(c);
    }
  }

  /* 画单个主体：底边贴地挤压拉伸 + 可选 3D 转/挤出。多主体时逐个调用，同一拍大家一起弹。 */
  function drawSubject(c, s, sub, t, rate) {
    var q = sub.rect;
    var b = t === null ? IDLE : bounceAt(t);
    var bcx = (q.x + q.w / 2) * s, gY = (q.y + q.h) * s;
    var qw = q.w * s, qh = q.h * s;
    /* 3D 旋转角：由时间推导，预览暂停时冻结在 pauseT，导出可传入 rate 覆盖转速 */
    var tt = t === null ? S.pauseT : t;
    var ang = S.spin ? tt * (rate == null ? S.spinRate : rate) * Math.PI * 2 : 0;
    var per = Math.cos(ang), sn = Math.sin(ang);
    if (S.shadow && sub.sil && S.bgMode !== 'none') {   /* 透明底不画影子，方便抠图复用 */
      /* 轮廓投影：把主体剪影压扁贴到地面，压矮时更宽更实，拉高时更窄更淡；侧转时影子收窄 */
      c.save();
      c.globalAlpha = clamp(0.30 + (1 - b.scaleY) * 0.4, 0.08, 0.6);
      if ('filter' in c) c.filter = 'blur(' + Math.max(1, q.h * 0.02 * s).toFixed(1) + 'px)';
      c.translate(bcx, gY);
      c.scale(b.scaleX * Math.abs(per), 1);
      var shH = q.h * s * 0.16;
      c.drawImage(sub.sil, -qw / 2, -shH / 2, qw, shH);
      c.restore();
    }
    if (!S.spin) {
      /* 底边贴地：只做原地挤压拉伸，不起跳 */
      c.save();
      c.translate(bcx, gY);
      c.scale(b.scaleX, b.scaleY);
      c.drawImage(sub.img, -qw / 2, -qh, qw, qh);
      c.restore();
    } else if (S.thick <= 0) {
      /* 零厚度也要转：整张图绕竖轴转，转过去就是镜像的自己 */
      c.save();
      c.translate(bcx, gY);
      c.scale(b.scaleX * per, b.scaleY);
      c.drawImage(sub.img, -qw / 2, -qh, qw, qh);
      c.restore();
    } else {
      /* 挤出体：厚度沿竖轴向后延伸，按 |sin| 投影成侧壁切片；双面贴图，正反两面都是图片。
         侧壁切片直接用图片本身：每层露出的 1px 窄条正好是该行从轮廓边缘往里数的几列像素，
         一圈侧壁因此全是取自图片边缘的颜色——逐行成百上千种杂色，而不是一坨平均色。
         正交投影：点 (x,z) → X = x*cos + z*sin，每层各自水平缩放 cos 并平移 z*sin。 */
      var T = S.thick;
      var K = clamp(Math.ceil(Math.abs(sn) * T * s), 1, 48);  /* 约 1px 一层，细线条才接得上 */
      /* 切片把 |cos| 抬到下限：正侧立（cos≈0）时每片塌成零宽会整条消失（导出闪白帧）。
         贴图仍用真实 cos —— 零厚度或侧面贴图在侧立时看不见是对的。 */
      var wallPer = per >= 0 ? Math.max(per, 0.012) : Math.min(per, -0.012);
      var layerAt = function (z, img, xScale) {
        c.save();
        c.translate(bcx + z * sn * s, gY);
        c.scale(xScale == null ? b.scaleX * per : xScale, b.scaleY);
        c.drawImage(img, -qw / 2, -qh, qw, qh);
        c.restore();
      };
      if (per >= 0) {
        /* 正面朝外：侧壁切片从后往前（z 由 -T 到 0），正面图盖在最上面 */
        for (var j = 0; j <= K; j++) layerAt(-T + T * j / K, sub.img, b.scaleX * wallPer);
        layerAt(0, sub.img);
      } else {
        /* 背面朝外：侧壁从远（z=0）画到近（z=-T），背面图盖在最上面（镜像） */
        for (var k = K; k >= 0; k--) layerAt(-T + T * k / K, sub.img, b.scaleX * wallPer);
        layerAt(-T, sub.img);
      }
    }
  }

  /* 预览里标出导出比例的裁切范围 */
  function drawCropGuide(c) {
    var R = S.ratio;
    if (Math.abs(R - BASE_W / BASE_H) < 0.001) return;
    var gw, gh;
    if (R >= BASE_W / BASE_H) { gw = BASE_W; gh = gw / R; }
    else { gh = BASE_H; gw = gh * R; }
    var gx = (BASE_W - gw) / 2, gy = (BASE_H - gh) / 2;
    c.save();
    c.fillStyle = 'rgba(23,23,19,0.10)';
    c.fillRect(0, 0, BASE_W, gy);
    c.fillRect(0, gy + gh, BASE_W, BASE_H - gy - gh);
    c.fillRect(0, gy, gx, gh);
    c.fillRect(gx + gw, gy, BASE_W - gx - gw, gh);
    c.strokeStyle = 'rgba(23,23,19,0.55)';
    c.lineWidth = 1;
    c.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);
    c.restore();
  }

  function drawSel(c, s, ox, oy) {
    var r = selRect();
    if (!r) return;
    c.save();
    c.strokeStyle = '#111';
    c.lineWidth = 1;
    c.setLineDash([4, 3]);
    c.strokeRect(ox + r.x * s + 0.5, oy + r.y * s + 0.5, r.w * s, r.h * s);
    c.setLineDash([]);
    c.fillStyle = '#111';
    c.font = '11px "SimSun", serif';
    c.fillText(S.sel.k === 'subj' ? subjLabel() : '背景', ox + r.x * s + 2, oy + r.y * s - 3);
    c.restore();
  }

  var t0 = performance.now();
  (function loop() {
    var e = (performance.now() - t0) / 1000;
    if (S.playing) S.pauseT = e;   /* 暂停时旋转角度冻结在最后一刻 */
    drawScene(ctx, BASE_W, BASE_H, S.playing ? e : null, false);
    requestAnimationFrame(loop);
  })();

  /* ---- 坐标与拖动 ---- */
  function toBase(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * BASE_W / rect.width, y: (e.clientY - rect.top) * BASE_H / rect.height };
  }
  function inRect(px, py, r) { return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; }
  function hitLayer(px, py) {
    for (var i = S.subjs.length - 1; i >= 0; i--) {     /* 后放的盖在上面，先命中上面的 */
      if (inRect(px, py, S.subjs[i].rect)) return { k: 'subj', i: i };
    }
    if (S.bgRect && inRect(px, py, S.bgRect)) return { k: 'bg' };
    return null;
  }
  function selSubj() { return (S.sel && S.sel.k === 'subj') ? S.subjs[S.sel.i] : null; }
  function selRect() {
    var sub = selSubj();
    return sub ? sub.rect : (S.sel && S.sel.k === 'bg' ? S.bgRect : null);
  }
  function subjLabel() { return S.subjs.length > 1 ? '主体#' + (S.sel.i + 1) : '主体'; }
  function select(hit) { S.sel = hit; updateHUD(); }

  var drag = null;
  canvas.addEventListener('pointerdown', function (e) {
    var p = toBase(e);
    var hit = hitLayer(p.x, p.y);
    if (!hit) { S.sel = null; updateHUD(); return; }
    select(hit);
    var r = selRect();
    drag = { r: r, dx: p.x - r.x, dy: p.y - r.y };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    var p = toBase(e);
    if (drag) {
      var r = drag.r;
      r.x = clamp(p.x - drag.dx, -r.w * 0.8, BASE_W - r.w * 0.2);
      r.y = clamp(p.y - drag.dy, -r.h * 0.8, BASE_H - r.h * 0.2);
      updateHUD();
    }
    stRight.textContent = '指针 ' + Math.round(p.x) + ',' + Math.round(p.y) + selInfo();
  });
  function endDrag() { drag = null; }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = toBase(e);
    var hit = hitLayer(p.x, p.y);
    if (hit) S.sel = hit;                        /* 悬停谁就缩放谁（并顺手选中） */
    var r = selRect();
    if (!r) return;
    scaleLayer(r, Math.exp(-e.deltaY * 0.0012), p);
    updateHUD();
  }, { passive: false });

  function scaleLayer(r, f, pivot) {
    var nw = clamp(r.w * f, 20, BASE_W * 4), nh = r.h * (nw / r.w);
    var fx = (pivot.x - r.x) / r.w, fy = (pivot.y - r.y) / r.h;
    r.x = pivot.x - fx * nw; r.y = pivot.y - fy * nh;
    r.w = nw; r.h = nh;
    syncSizeSliders();
  }

  function selInfo() {
    var r = selRect();
    if (!S.sel || !r) return '';
    return ' · ' + (S.sel.k === 'subj' ? subjLabel() : '背景') + ' ' + Math.round(r.x) + ',' + Math.round(r.y) + ' 宽' + Math.round(r.w);
  }
  function updateHUD() {
    stRight.textContent = (S.sel ? (S.sel.k === 'subj' ? '选中主体' : '选中背景') : '没选中东西') + selInfo();
  }

  /* 方向键微调选中图层；Delete/Backspace 删掉选中的主体 */
  document.addEventListener('keydown', function (e) {
    if (!S.sel || e.target.tagName === 'INPUT') return;
    if (S.sel.k === 'subj' && (e.key === 'Delete' || e.key === 'Backspace')) {
      removeSelectedSubject();
      e.preventDefault();
      return;
    }
    var step = e.shiftKey ? 10 : 1, r = selRect();
    if (!r) return;
    if (e.key === 'ArrowLeft') r.x -= step;
    else if (e.key === 'ArrowRight') r.x += step;
    else if (e.key === 'ArrowUp') r.y -= step;
    else if (e.key === 'ArrowDown') r.y += step;
    else return;
    e.preventDefault();
    updateHUD();
  });

  /* ---- 装图 ---- */
  function defaultRect(iw, ih, layer) {
    if (layer === 'bg') {
      var k = Math.max(BASE_W / iw, BASE_H / ih);
      return { w: iw * k, h: ih * k, x: (BASE_W - iw * k) / 2, y: (BASE_H - ih * k) / 2 };
    }
    var kh = BASE_H * 0.5 / ih;
    return { w: iw * kh, h: ih * kh, x: (BASE_W - iw * kh) / 2, y: BASE_H * 0.78 - ih * kh };
  }

  function setBg(src, label) {
    S.bgImg = src;
    S.bgRect = defaultRect(src.width, src.height, 'bg');
    nameBg.textContent = label;
    S.sel = { k: 'bg' };
    syncSizeSliders();
    updateHUD();
    say('放好了，背景已就位。');
  }

  /* 加一个主体：挨个均分站位，大家一起弹 */
  function addSubject(src, label) {
    S.subjs.push({ img: src, rect: defaultRect(src.width, src.height, 'subj'), sil: makeSilhouette(src), label: label });
    spreadSubjects();
    S.sel = { k: 'subj', i: S.subjs.length - 1 };
    refreshSubjName();
    syncSizeSliders();
    updateHUD();
    say('放好了，主体已就位（第 ' + S.subjs.length + ' 个）。');
  }

  /* 主体名条：1 个显示它的名字，多个显示个数 */
  function refreshSubjName() {
    if (!S.subjs.length) { nameSubj.textContent = '未选择'; return; }
    nameSubj.textContent = S.subjs.length === 1 ? S.subjs[0].label : '×' + S.subjs.length + ' 个主体一起弹';
  }

  /* 删掉选中的主体；没选中返回 false */
  function removeSelectedSubject() {
    if (!selSubj()) return false;
    S.subjs.splice(S.sel.i, 1);
    S.sel = null;
    refreshSubjName();
    syncSizeSliders();
    updateHUD();
    say('删掉一个，还剩 ' + S.subjs.length + ' 个主体。');
    return true;
  }

  /* 主体均分排开：只摆位置，不动各自大小 */
  function spreadSubjects() {
    var n = S.subjs.length;
    for (var i = 0; i < n; i++) {
      var r = S.subjs[i].rect;
      r.x = BASE_W * (i + 1) / (n + 1) - r.w / 2;
    }
  }

  function loadImageFile(file, layer) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { say('这不是图片：' + file.name); return; }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var maxSide = 1600, sw = img.width, sh = img.height, out = img, lbl = file.name;
      if (Math.max(sw, sh) > maxSide) {
        var k = maxSide / Math.max(sw, sh);
        var cv = document.createElement('canvas');
        cv.width = Math.round(sw * k); cv.height = Math.round(sh * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        out = cv;
        lbl = file.name + '（缩到' + cv.width + '×' + cv.height + '）';
      }
      if (layer === 'bg') setBg(out, lbl);
      else { addSubject(out, lbl); startMusic(); }   /* 上传主体自动放酒 */
    };
    img.onerror = function () { URL.revokeObjectURL(url); say('图片读不出来：' + file.name); };
    img.src = url;
  }

  $('fBg').addEventListener('change', function () { loadImageFile(this.files[0], 'bg'); this.value = ''; });
  $('fSubj').addEventListener('change', function () {   /* 可一次多选，每个都加成一个主体 */
    for (var i = 0; i < this.files.length; i++) loadImageFile(this.files[i], 'subj');
    this.value = '';
  });
  $('btnPickBg').addEventListener('click', function () { $('fBg').click(); });
  $('btnPickSubj').addEventListener('click', function () { $('fSubj').click(); });

  /* 拖文件进窗口 / Ctrl+V 粘贴 */
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    var files = e.dataTransfer.files;
    if (!files || !files.length) return;
    for (var i = 0; i < files.length; i++) {
      /* 第一张没背景就当背景，其余全当主体 */
      if (i === 0 && !S.bgImg) loadImageFile(files[i], 'bg');
      else loadImageFile(files[i], 'subj');
    }
  });
  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') === 0) {
        loadImageFile(items[i].getAsFile(), S.bgImg ? 'subj' : 'bg');
        break;
      }
    }
  });

  /* ---- 背景音乐：朋友的酒（载示例/传主体自动起，状态栏按钮随时开关） ---- */
  var audio = new Audio('audio/朋友的酒.ogg');
  audio.loop = true;
  var btnAudio = $('btnAudio');
  function syncAudioBtn() { btnAudio.textContent = audio.paused ? '▶ 播放' : '⏸ 暂停'; }
  function startMusic() {                       /* 已经在放就不打断；被浏览器拦了就留给按钮 */
    if (!audio.paused) return;
    var p = audio.play();
    if (p && p.catch) p.catch(function () {});
  }
  btnAudio.addEventListener('click', function () {
    if (audio.paused) {
      var p = audio.play();
      if (p && p.catch) p.catch(function () { say('浏览器拦了自动播放，再点一下。'); });
    } else {
      audio.pause();
    }
  });
  audio.addEventListener('play', syncAudioBtn);
  audio.addEventListener('pause', syncAudioBtn);
  syncAudioBtn();

  /* ---- 内置示例：背景 xp.webp + 主体 bang.webp（同目录真文件，自绘样例已删） ---- */
  function loadURL(layer, url, label, done) {
    var img = new Image();
    img.onload = function () {
      if (layer === 'bg') setBg(img, label);
      else { addSubject(img, label); startMusic(); }   /* 载示例主体也自动放酒 */
      if (done) done();
    };
    img.onerror = function () { say('图读不出来：' + label); if (done) done(); };
    img.src = url;
  }

  $('btnSample').addEventListener('click', function () {
    S.subjs = [];                     /* 示例给一套干净的：清掉旧主体再装 */
    refreshSubjName();
    var left = 2;
    var done = function () { if (--left <= 0) say('示例已就位，直接导出试试。'); };
    loadURL('bg', 'img/xp.webp', '示例背景', done);
    loadURL('subj', 'img/bang.webp', '示例主体', done);
  });

  $('btnClear').addEventListener('click', function () {
    S.bgImg = null; S.bgRect = null; S.subjs = [];
    S.sel = null;
    nameBg.textContent = '未选择'; nameSubj.textContent = '未选择';
    syncSizeSliders(); updateHUD();
    say('清干净了。');
  });

  /* 面板删除按钮：删掉当前选中的主体 */
  $('btnDelSubj').addEventListener('click', function () {
    if (!removeSelectedSubject()) say('先在画布上点一个主体，再点删除。');
  });

  /* ---- 滑杆 ---- */
  function syncSizeSliders() {
    var sub = selSubj() || S.subjs[S.subjs.length - 1];   /* 主体滑杆跟着选中的走 */
    spSubjSize.value = sub ? Math.round(sub.rect.h / BASE_H * 100) : 50;
    spBgSize.value = S.bgRect ? Math.round(S.bgRect.h / BASE_H * 100) : 100;
    rdSubjSize.textContent = spSubjSize.value + '%';
    rdBgSize.textContent = spBgSize.value + '%';
  }
  function sizeFromSlider(layer, val) {
    var sub = selSubj() || S.subjs[S.subjs.length - 1];
    var r = layer === 'subj' ? (sub && sub.rect) : S.bgRect;
    if (!r) return;
    var img = layer === 'subj' ? sub.img : S.bgImg;
    var aspect = img.width / img.height;
    var nh = val / 100 * BASE_H, nw = nh * aspect;
    if (layer === 'subj') {
      var bottom = r.y + r.h, cx = r.x + r.w / 2;
      r.w = nw; r.h = nh; r.x = cx - nw / 2; r.y = bottom - nh;
    } else {
      var mcx = r.x + r.w / 2, mcy = r.y + r.h / 2;
      r.w = nw; r.h = nh; r.x = mcx - nw / 2; r.y = mcy - nh / 2;
    }
    updateHUD();
  }
  spSubjSize.addEventListener('input', function () { rdSubjSize.textContent = this.value + '%'; sizeFromSlider('subj', +this.value); });
  spBgSize.addEventListener('input', function () { rdBgSize.textContent = this.value + '%'; sizeFromSlider('bg', +this.value); });

  spSpeed.addEventListener('input', function () {
    S.speed = +this.value;
    rdSpeed.textContent = S.speed.toFixed(1) + '×';
    rdHz.textContent = Math.round(BEAT_HZ * S.speed * 60) + ' BPM';
  });
  spAmp.addEventListener('input', function () {
    S.amp = +this.value / 100;
    rdAmp.textContent = this.value + '%';
  });

  $('spinChk').addEventListener('change', function () {
    S.spin = this.checked;
    say(this.checked ? '开转，3D 走起。' : '转停了，正面朝你。');
  });
  spSpin.addEventListener('input', function () {
    S.spinRate = +this.value;
    rdSpin.textContent = S.spinRate.toFixed(1) + '转/秒';
  });
  spThick.addEventListener('input', function () {
    S.thick = +this.value;
    rdThick.textContent = this.value + 'px';
  });

  function setPlaying(v) {
    S.playing = v;
    btnPause.textContent = v ? '暂停' : '继续摇';
    say(v ? '在摇，很通透。' : '停着。');
  }
  btnPause.addEventListener('click', function () { setPlaying(!S.playing); });

  $('btnReset').addEventListener('click', function () {
    for (var i = 0; i < S.subjs.length; i++) S.subjs[i].rect = defaultRect(S.subjs[i].img.width, S.subjs[i].img.height, 'subj');
    spreadSubjects();
    if (S.bgImg) S.bgRect = defaultRect(S.bgImg.width, S.bgImg.height, 'bg');
    S.speed = 1; S.amp = 0.5;
    spSpeed.value = 1; rdSpeed.textContent = '1.0×'; rdHz.textContent = '130 BPM';
    spAmp.value = 50; rdAmp.textContent = '50%';
    S.spin = false; S.spinRate = 0.5; S.thick = 0;
    $('spinChk').checked = false;
    spSpin.value = 0.5; rdSpin.textContent = '0.5转/秒';
    spThick.value = 0; rdThick.textContent = '0px';
    syncSizeSliders(); updateHUD();
    say('复位了。');
  });

  /* ---- 背景模式 ---- */
  Array.prototype.forEach.call(document.querySelectorAll('input[name=bgMode]'), function (r) {
    r.addEventListener('change', function () {
      S.bgMode = this.value;
      document.body.classList.toggle('transparent-preview', S.bgMode === 'none');
    });
  });
  $('bgColorPick').addEventListener('input', function () { S.bgColor = this.value; });
  $('ditherChk').addEventListener('change', function () { S.dither = this.checked; });
  $('shadowChk').addEventListener('change', function () { S.shadow = this.checked; });

  /* ---- 导出比例 ---- */
  var ratioCustomRow = $('ratioCustomRow');
  function ratioChecked() { return document.querySelector('input[name=expRatio]:checked'); }
  function readRatio() {
    var r = ratioChecked();
    if (!r) return BASE_W / BASE_H;
    if (r.value === 'custom') {
      var a = clamp(parseInt($('expRatioW').value, 10) || 4, 1, 99);
      var b = clamp(parseInt($('expRatioH').value, 10) || 5, 1, 99);
      return a / b;
    }
    return parseFloat(r.value);
  }
  function syncRatio() {
    var r = ratioChecked();
    ratioCustomRow.hidden = !r || r.value !== 'custom';
    S.ratio = readRatio();
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[name=expRatio]'), function (r) {
    r.addEventListener('change', syncRatio);
  });
  $('expRatioW').addEventListener('input', syncRatio);
  $('expRatioH').addEventListener('input', syncRatio);

  /* ---- 关于 ---- */
  $('miAbout').addEventListener('click', function () { dlgAbout.hidden = false; });
  $('dlgOk').addEventListener('click', function () { dlgAbout.hidden = true; });
  dlgAbout.addEventListener('click', function (e) {   /* 点遮罩空白处也关闭，点内容区不关 */
    if (e.target === dlgAbout) dlgAbout.hidden = true;
  });

  /* ---- 导出 GIF ---- */
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function setProgress(frac, label) {
    progressFill.style.width = Math.round(frac * 100) + '%';
    if (label) say(label);
  }

  function exportGIF() {
    if (!S.subjs.length) { say('先放一张主体图。'); return; }
    var w = parseInt(document.querySelector('input[name=expSize]:checked').value, 10);
    var h = Math.max(2, Math.round(w / S.ratio / 2) * 2);
    var fps = parseInt($('expFps').value, 10);
    var transparent = S.bgMode === 'none';
    var f = BEAT_HZ * S.speed;
    var fpb = fps / f;
    var beats = clamp(Math.round(24 / fpb), 1, 6);
    var total = clamp(Math.round(beats * fpb), 8, 64);
    var delayCs = Math.max(2, Math.round(beats / f * 100 / total));

    /* 旋转循环对齐：在拍数允许范围内微调导出转速，让 GIF 恰好转整数圈，循环处不跳变。
       若怎么调偏差都 >15%（转速太慢转不满一圈），保持用户设置，不偷偷改速度。 */
    var expRate = null;
    if (S.spin && S.spinRate > 0) {
      var baseBeats = beats, best = null;
      for (var bb = baseBeats; bb <= 6; bb++) {
        if (Math.round((bb / f) * fpb) > 64) break;   /* 帧数上限 */
        var m = Math.round(S.spinRate * bb / f);
        if (m < 1) m = 1;
        var dev = Math.abs(m / (bb / f) - S.spinRate) / S.spinRate;
        if (!best || dev < best.dev) best = { dev: dev, m: m, bb: bb };
        if (dev < 0.02) break;
      }
      if (best && best.dev <= 0.15) {
        expRate = best.m / (best.bb / f);
        if (best.bb !== baseBeats) {
          beats = best.bb;
          total = clamp(Math.round(beats * fpb), 8, 64);
          delayCs = Math.max(2, Math.round(beats / f * 100 / total));
        }
      }
    }

    btnExport.disabled = true; btnPause.disabled = true;
    progressWrap.hidden = false;
    say('压帧 0/' + total + '…');

    var off = document.createElement('canvas');
    off.width = w; off.height = h;
    var octx = off.getContext('2d', { willReadFrequently: true });
    var frames = [];
    var i = 0;

    function nextFrame() {
      if (i >= total) { finish(); return; }
      var t = (i * beats / total) / f;
      drawScene(octx, w, h, t, true, expRate);
      frames.push(octx.getImageData(0, 0, w, h).data);
      i++;
      setProgress(i / total * 0.9, '压帧 ' + i + '/' + total + '…');
      setTimeout(nextFrame, 0);
    }

    function finish() {
      setTimeout(function () {
        setProgress(0.96, '配色中…');
        setTimeout(function () {
          var bytes;
          try {
            bytes = GIF.encodeGIF(frames, w, h, { transparent: transparent, delayCs: delayCs, dither: S.dither });
          } catch (err) {
            progressWrap.hidden = true;
            btnExport.disabled = false; btnPause.disabled = false;
            say('导出失败：' + err.message);
            return;
          }
          var blob = new Blob([bytes], { type: 'image/gif' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = '所有人保持Q弹-' + stamp() + '.gif';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 8000);
          progressWrap.hidden = true;
          btnExport.disabled = false; btnPause.disabled = false;
          setProgress(1, '导出完成：' + w + '×' + h + ' · ' + total + '帧 · ' +
            (blob.size / 1024).toFixed(0) + ' KB' + (transparent ? ' · 透明底' : '') + '，去刷屏吧。');
        }, 16);
      }, 16);
    }

    setTimeout(nextFrame, 16);
  }
  btnExport.addEventListener('click', exportGIF);

  /* 初始状态 */
  syncRatio();
  syncSizeSliders();
  updateHUD();
})();
