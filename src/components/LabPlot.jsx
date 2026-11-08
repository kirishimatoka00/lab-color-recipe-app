import React from 'react';
import { labToHex } from '../color/colorUtils.js';
import { projectAB, sliceAtL, sliceAtHue, hull2D } from '../color/gamutUtils.js';

/**
 * Lab 平面圖（SVG）。
 *
 * 兩種視角：
 *   ab  — a*-b* 平面，看色相與彩度。可選整體投影或指定 L 的截面。
 *   lc  — Chroma-L* 剖面，沿目標色的色相切一刀，看明度與彩度的可達範圍。
 *
 * 用 SVG 而不是 WebGL：配方工作要的是精確讀數與快速反應，
 * 而且手機上不吃 GPU。
 */

const PAD = 34;

function useBounds(pts, mode) {
    return React.useMemo(() => {
        if (mode === 'lc') {
            let maxC = 10, minL = 0, maxL = 100;
            for (const p of pts) maxC = Math.max(maxC, Math.hypot(p.a, p.b));
            return { x0: 0, x1: Math.ceil((maxC * 1.15) / 10) * 10, y0: minL, y1: maxL };
        }
        let m = 10;
        for (const p of pts) m = Math.max(m, Math.abs(p.a), Math.abs(p.b));
        const r = Math.ceil((m * 1.15) / 10) * 10;
        return { x0: -r, x1: r, y0: -r, y1: r };
    }, [pts, mode]);
}

export default function LabPlot({
    mode = 'ab',
    gamutPoints = [],
    sliceL = null,
    target = null,
    predicted = null,
    corrections = null,
    extras = [],
    size = 320,
    onPick = null,
}) {
    const all = React.useMemo(() => {
        const a = [...gamutPoints];
        for (const p of [target, predicted, ...extras.map((e) => e.lab)]) if (p) a.push(p);
        return a;
    }, [gamutPoints, target, predicted, extras]);

    const b = useBounds(all, mode);
    const W = size, H = size;
    const sx = (v) => PAD + ((v - b.x0) / (b.x1 - b.x0)) * (W - PAD * 2);
    const sy = (v) => H - PAD - ((v - b.y0) / (b.y1 - b.y0)) * (H - PAD * 2);

    const toXY = (p) => (mode === 'lc'
        ? [sx(Math.hypot(p.a, p.b)), sy(p.l)]
        : [sx(p.a), sy(p.b)]);

    // 色域輪廓
    const hull = React.useMemo(() => {
        if (gamutPoints.length < 3) return null;
        if (mode === 'lc') {
            const ref = target || predicted;
            if (!ref) return null;
            return sliceAtHue(gamutPoints, Math.atan2(ref.b, ref.a));
        }
        return sliceL == null ? projectAB(gamutPoints) : sliceAtL(gamutPoints, sliceL);
    }, [gamutPoints, mode, sliceL, target, predicted]);

    const hullPath = hull && hull.length >= 3
        ? hull.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ') + ' Z'
        : null;

    const ticks = React.useMemo(() => {
        const step = (b.x1 - b.x0) <= 40 ? 10 : (b.x1 - b.x0) <= 120 ? 20 : 40;
        const out = { x: [], y: [] };
        for (let v = Math.ceil(b.x0 / step) * step; v <= b.x1; v += step) out.x.push(v);
        const ystep = mode === 'lc' ? 20 : step;
        for (let v = Math.ceil(b.y0 / ystep) * ystep; v <= b.y1; v += ystep) out.y.push(v);
        return out;
    }, [b, mode]);

    const handleClick = (e) => {
        if (!onPick) return;
        const r = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const py = ((e.clientY - r.top) / r.height) * H;
        const vx = b.x0 + ((px - PAD) / (W - PAD * 2)) * (b.x1 - b.x0);
        const vy = b.y0 + ((H - PAD - py) / (H - PAD * 2)) * (b.y1 - b.y0);
        onPick(mode === 'lc' ? { chroma: vx, l: vy } : { a: vx, b: vy });
    };

    const corrColors = { C1: '#f97316', C2: '#06b6d4', C3: '#22c55e' };

    return (
        <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full select-none"
            onClick={handleClick}
            style={{ cursor: onPick ? 'crosshair' : 'default' }}
        >
            <rect x={PAD} y={PAD} width={W - PAD * 2} height={H - PAD * 2} fill="#fafafa" stroke="#e2e8f0" />

            {ticks.x.map((v) => (
                <g key={`x${v}`}>
                    <line x1={sx(v)} y1={PAD} x2={sx(v)} y2={H - PAD} stroke="#eef2f7" />
                    <text x={sx(v)} y={H - PAD + 12} textAnchor="middle" fontSize="8" fill="#94a3b8">{v}</text>
                </g>
            ))}
            {ticks.y.map((v) => (
                <g key={`y${v}`}>
                    <line x1={PAD} y1={sy(v)} x2={W - PAD} y2={sy(v)} stroke="#eef2f7" />
                    <text x={PAD - 5} y={sy(v) + 3} textAnchor="end" fontSize="8" fill="#94a3b8">{v}</text>
                </g>
            ))}

            {mode === 'ab' && (
                <>
                    <line x1={sx(0)} y1={PAD} x2={sx(0)} y2={H - PAD} stroke="#cbd5e1" />
                    <line x1={PAD} y1={sy(0)} x2={W - PAD} y2={sy(0)} stroke="#cbd5e1" />
                </>
            )}

            {hullPath && <path d={hullPath} fill="#3b82f6" fillOpacity="0.09" stroke="#3b82f6" strokeOpacity="0.5" strokeWidth="1" />}

            {/* 色域點雲：抽樣繪製，避免點太多拖慢 */}
            {gamutPoints.length > 0 && gamutPoints
                .filter((_, i) => i % Math.max(1, Math.ceil(gamutPoints.length / 900)) === 0)
                .map((p, i) => {
                    const [x, y] = toXY(p);
                    return <circle key={i} cx={x} cy={y} r="1.1" fill={labToHex(p.l, p.a, p.b)} opacity="0.5" />;
                })}

            {/* 修正點與連線 */}
            {corrections && ['C1', 'C2', 'C3'].map((k) => {
                const c = corrections[k];
                if (!c || !target) return null;
                const [x0, y0] = toXY(target);
                const [x1, y1] = toXY(c);
                return (
                    <g key={k}>
                        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={corrColors[k]} strokeWidth="1" strokeDasharray="3 2" />
                        <circle cx={x1} cy={y1} r="3.5" fill={corrColors[k]} stroke="#fff" strokeWidth="1" />
                        <text x={x1 + 6} y={y1 - 4} fontSize="8" fill={corrColors[k]} fontWeight="600">{k}</text>
                    </g>
                );
            })}

            {extras.map((e, i) => {
                if (!e.lab) return null;
                const [x, y] = toXY(e.lab);
                return (
                    <g key={`e${i}`}>
                        <circle cx={x} cy={y} r="3" fill={labToHex(e.lab.l, e.lab.a, e.lab.b)} stroke={e.color || '#64748b'} strokeWidth="1.5" />
                        {e.label && <text x={x + 6} y={y + 3} fontSize="8" fill="#64748b">{e.label}</text>}
                    </g>
                );
            })}

            {predicted && (() => {
                const [x, y] = toXY(predicted);
                return (
                    <g>
                        <circle cx={x} cy={y} r="5.5" fill={labToHex(predicted.l, predicted.a, predicted.b)} stroke="#0f172a" strokeWidth="1.5" />
                        <text x={x + 8} y={y + 3} fontSize="9" fontWeight="600" fill="#0f172a">預測</text>
                    </g>
                );
            })()}

            {target && (() => {
                const [x, y] = toXY(target);
                return (
                    <g>
                        <rect x={x - 5} y={y - 5} width="10" height="10"
                            fill={labToHex(target.l, target.a, target.b)} stroke="#dc2626" strokeWidth="1.8" />
                        <text x={x + 8} y={y - 6} fontSize="9" fontWeight="600" fill="#dc2626">目標</text>
                    </g>
                );
            })()}

            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#64748b">
                {mode === 'lc' ? 'Chroma C*' : 'a*'}
            </text>
            <text x={10} y={H / 2} textAnchor="middle" fontSize="9" fill="#64748b"
                transform={`rotate(-90 10 ${H / 2})`}>
                {mode === 'lc' ? 'L*' : 'b*'}
            </text>
        </svg>
    );
}
