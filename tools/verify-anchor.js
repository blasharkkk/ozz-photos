// 滚轮锚点公式的几何自洽性验证（脱离像素比对，纯数学）。
// 合成里的采样映射：源矩形左上角 sx = c.x + c.w/2 - sw/2 + offX*W，sw = W*paperFit/base。
// 光标在画布归一化位置 px，它指向的源点 src = sx + px*sw。
// 锚点要求：缩放后同一个 src 仍落在同一 px。反解 off2 再和代码公式比对。
const W = 520, cw = 1200, ch = 800;
const base = Math.max(W / cw, (650) / ch);
const CX = cw / 2;

function verify(fit, next, px, off, sign) {
  const sw = W * fit / base;
  const sx = CX - sw / 2 + off * W;
  const src = sx + px * sw;                       // 光标处的源点
  // 缩放后：sw2 = W*next/base，要让 src 仍在 px → sx2 = src - px*sw2
  //         而 sx2 = CX - sw2/2 + off2*W  →  off2 = (src - CX + sw2/2)/W
  const sw2 = W * next / base;
  const offExact = (src - CX + sw2 / 2) / W;
  const offCode = off + sign * (fit - next) * (px - 0.5) / base;   // 代码里的公式
  // 验算：用 offCode 时 src 落在画布何处
  const swA = W * next / base;
  const sxA = CX - swA / 2 + offCode * W;
  const pxA = (src - sxA) / swA;
  return { offExact, offCode, pxA, err: Math.abs(pxA - px) };
}

console.log('锚点公式验证（W=%d cw=%d base=%s）', W, cw, base.toFixed(4));
for (const sign of [1, -1]) {
  console.log(sign > 0 ? '\n公式符号 = +（当前实现）:' : '\n公式符号 = −（对照）:');
  let worst = 0;
  for (const px of [0.15, 0.28, 0.5, 0.72, 0.85]) {
    const r = verify(1, 1.47, px, 0, sign);
    worst = Math.max(worst, r.err);
    console.log(`  光标 px=${px.toFixed(2)} → 缩放后落在 ${r.pxA.toFixed(5)}（误差 ${r.err.toExponential(1)}）`);
  }
  console.log(`  最大误差 = ${worst.toExponential(2)}  => ${worst < 1e-9 ? '✔ 锚点精确' : '✘ 锚点有偏差'}`);
}

// 拖动符号验证：paperOffX 增大时，画面上照片内容往哪移？
// 画面位置 px = (src - sx)/sw，sx 随 offX 增大而增大 → px 减小 → 内容相对左移。
// 所以「跟着鼠标走」要求 mouse 向右(+) 时 offX 减小 → offX = ox - dx/W（负号）。
console.log('\n拖动符号推论：offX 增大 → 源矩形右移 → 画面内容左移 → 跟随鼠标需用负号。当前实现为负号 ✔');
