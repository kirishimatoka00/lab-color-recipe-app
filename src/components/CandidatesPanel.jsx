import React from 'react';
import { Card, Button, Select, Swatch, DeltaEBadge, Empty, fmt } from './ui.jsx';
import { findCandidates } from '../color/candidates.js';
import { cToDosage, COLORANT_ROLE } from '../data/schema.js';

/**
 * 多組候選配方並列比較。
 *
 * 重點不是找出 ΔE 最小的那組，而是讓「少一支色料」與「色差小一點」
 * 這個取捨看得見。成分數少的排在前面同分的位置。
 */
export default function CandidatesPanel({ target, solverCols, compiled, maxTotalC, threshold, onApply }) {
    const [list, setList] = React.useState(null);
    const [maxComponents, setMaxComponents] = React.useState(3);
    const [required, setRequired] = React.useState([]);
    const [busy, setBusy] = React.useState(false);

    // 白通常是必備的，預設勾起來省一步
    React.useEffect(() => {
        const white = solverCols.find((c) => c.colorant?.role === COLORANT_ROLE.WHITE);
        if (white && !required.length) setRequired([white.id]);
    }, [solverCols]);

    const run = () => {
        setBusy(true);
        setTimeout(() => {
            try {
                setList(findCandidates({
                    target, colorants: solverCols, substrate: compiled.substrate,
                    maxComponents, limit: 6, maxTotalC, required,
                }));
            } finally { setBusy(false); }
        }, 10);
    };

    if (solverCols.length < 2) return null;

    return (
        <Card
            title="候選配方比較"
            right={
                <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-500">最多成分</span>
                    <Select value={maxComponents} className="w-16 py-1 text-[11px]"
                        onChange={(e) => setMaxComponents(Number(e.target.value))}>
                        {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                    </Select>
                    <Button variant="primary" onClick={run} disabled={busy}>
                        {busy ? '計算中…' : '列出候選'}
                    </Button>
                </div>
            }
        >
            <div className="mb-2 flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-slate-500">必須包含：</span>
                {solverCols.map((c) => {
                    const on = required.includes(c.id);
                    return (
                        <button key={c.id}
                            onClick={() => setRequired((r) => (on ? r.filter((x) => x !== c.id) : [...r, c.id]))}
                            className={`rounded-full border px-2 py-0.5 text-[11px] ${
                                on ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500'}`}>
                            {c.name}
                        </button>
                    );
                })}
                {required.length === 0 && <span className="text-[11px] text-slate-400">（無）</span>}
            </div>

            {!list ? (
                <Empty>按「列出候選」比較不同色料組合的結果。</Empty>
            ) : list.length === 0 ? (
                <Empty>在目前的限制下找不到可行組合。試著放寬成分數或總量上限。</Empty>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-400">
                                <th className="py-1">配方</th>
                                <th className="py-1 text-center">成分數</th>
                                <th className="py-1 text-right">顏料總量</th>
                                <th className="py-1 text-right">色差</th>
                                <th className="py-1 text-center">可行</th>
                                <th className="py-1" />
                            </tr>
                        </thead>
                        <tbody>
                            {list.map((cand, i) => (
                                <tr key={cand.ids.join('|')}
                                    className={`border-b border-slate-100 last:border-0 ${i === 0 ? 'bg-blue-50/40' : ''}`}>
                                    <td className="py-2">
                                        <div className="mb-1 flex items-center gap-1.5">
                                            <Swatch lab={cand.lab} size={18} />
                                            {i === 0 && <span className="rounded bg-blue-600 px-1 text-[9px] font-semibold text-white">最佳</span>}
                                        </div>
                                        <div className="space-y-0.5">
                                            {cand.ids.map((id) => {
                                                const idx = solverCols.findIndex((c) => c.id === id);
                                                const col = solverCols[idx];
                                                return (
                                                    <div key={id} className="flex justify-between gap-3 text-[11px]">
                                                        <span className="text-slate-600">{col.name}</span>
                                                        <span className="font-mono text-slate-500">
                                                            {fmt(cand.c[idx])}%
                                                            <span className="ml-1 text-slate-400">
                                                                （色母 {fmt(cToDosage(cand.c[idx], col.colorant))}%）
                                                            </span>
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </td>
                                    <td className="py-2 text-center font-mono text-slate-600">{cand.usedCount}</td>
                                    <td className="py-2 text-right font-mono text-slate-600">{fmt(cand.totalC)}%</td>
                                    <td className="py-2 text-right"><DeltaEBadge value={cand.dE00} threshold={threshold} /></td>
                                    <td className="py-2 text-center">
                                        {cand.feasible
                                            ? <span className="text-emerald-600">✓</span>
                                            : <span className="text-red-500" title={cand.violations.map((v) => v.name).join(', ')}>違規</span>}
                                    </td>
                                    <td className="py-2 text-right">
                                        <Button onClick={() => onApply(cand.c)}>套用</Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="mt-2 text-[11px] text-slate-500">
                        成分少一支，配料與庫存就少一份麻煩。色差差距在 0.5 以內時，通常值得選成分少的那組。
                    </p>
                </div>
            )}
        </Card>
    );
}
