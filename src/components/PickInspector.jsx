import React from 'react';
import { Swatch, Button, fmt } from './ui.jsx';
import { cToDosage } from '../data/schema.js';
import { colorDifference } from '../color/colorUtils.js';

/**
 * 圖上點擊後顯示的資料卡。
 *
 * 點到色域取樣點時，重點不是那個點的 Lab 是多少，而是「這個顏色怎麼配出來」——
 * 取樣時就把配方一起記下來，所以這裡可以直接列出濃度，並讓使用者一鍵帶入。
 */
export default function PickInspector({ pick, solverCols, target, onApply, onClose }) {
    if (!pick) return null;
    const p = pick.nearest;

    return (
        <div className="rounded-md border border-base surface-2 p-2">
            <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-sub">
                    {p ? '色域取樣點' : '點選位置'}
                </span>
                <Button variant="ghost" onClick={onClose}>關閉</Button>
            </div>

            {!p ? (
                <p className="text-[11px] text-muted">
                    {pick.at.chroma != null
                        ? `C* ${fmt(pick.at.chroma, 1)} · L* ${fmt(pick.at.l, 1)}`
                        : `a* ${fmt(pick.at.a, 1)} · b* ${fmt(pick.at.b, 1)}`}
                    <span className="ml-1 text-faint">（附近沒有取樣點，可能在可達範圍外）</span>
                </p>
            ) : (
                <>
                    <div className="flex items-center gap-2">
                        <Swatch lab={p} size={34} />
                        <div className="font-mono text-[11px] text-sub">
                            L* {p.l.toFixed(2)} · a* {p.a.toFixed(2)} · b* {p.b.toFixed(2)}
                        </div>
                        {target && (
                            <div className="ml-auto text-right text-[11px]">
                                <div className="text-faint">與目標</div>
                                <div className="font-mono text-sub">
                                    ΔE₀₀ {colorDifference(p, target).dE00.toFixed(2)}
                                </div>
                            </div>
                        )}
                    </div>

                    {p.recipe && (
                        <>
                            <div className="mt-2 space-y-0.5">
                                {p.recipe.map((c, i) => (c > 1e-9 ? (
                                    <div key={solverCols[i]?.id || i} className="flex justify-between text-[11px]">
                                        <span className="text-sub">{solverCols[i]?.name}</span>
                                        <span className="font-mono text-muted">
                                            {fmt(c)}%
                                            <span className="ml-1 text-faint">
                                                （色母 {fmt(cToDosage(c, solverCols[i]?.colorant))}%）
                                            </span>
                                        </span>
                                    </div>
                                ) : null))}
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                                <Button onClick={() => onApply(p.recipe.slice())}>帶入配方</Button>
                                <span className="text-[10px] text-faint">
                                    顏料總量 {fmt(p.totalC)}%
                                </span>
                            </div>
                        </>
                    )}
                </>
            )}
        </div>
    );
}
