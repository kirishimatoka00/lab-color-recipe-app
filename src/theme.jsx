import React from 'react';

/**
 * 主題：預設暗色。
 * 'dark' class 掛在 <html> 上，Tailwind 的 dark: 變體與 index.css 的
 * CSS 變數都吃這一個開關，SVG 圖表與 3D 視圖也共用同一組變數。
 */
const KEY = 'recipe_theme';
const ThemeContext = React.createContext({ dark: true, toggle: () => {} });

export const useTheme = () => React.useContext(ThemeContext);

export function ThemeProvider({ children }) {
    const [dark, setDark] = React.useState(() => {
        try {
            const saved = window.localStorage.getItem(KEY);
            if (saved === 'light') return false;
            if (saved === 'dark') return true;
        } catch { /* 無痕模式讀不到就用預設 */ }
        return true;
    });

    React.useEffect(() => {
        document.documentElement.classList.toggle('dark', dark);
        try { window.localStorage.setItem(KEY, dark ? 'dark' : 'light'); } catch { /* 忽略 */ }
    }, [dark]);

    const value = React.useMemo(() => ({ dark, toggle: () => setDark((d) => !d) }), [dark]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** 圖表用的顏色，直接讀 CSS 變數，與樣式表同一份定義 */
export function usePlotColors() {
    const { dark } = useTheme();
    return React.useMemo(() => {
        // 伺服器端渲染與測試環境沒有 getComputedStyle，退回靜態值
        const css = typeof window !== 'undefined' && typeof getComputedStyle === 'function'
            ? getComputedStyle(document.documentElement) : null;
        const get = (name, fallback) =>
            ((css && css.getPropertyValue(name)) || fallback).trim();
        return {
            face: get('--plot-face', '#fafafa'),
            frame: get('--plot-frame', '#e2e8f0'),
            grid: get('--plot-grid', '#eef2f7'),
            axis: get('--plot-axis', '#cbd5e1'),
            label: get('--plot-label', '#94a3b8'),
            ink: get('--plot-ink', '#0f172a'),
            dark,
        };
    }, [dark]);
}
