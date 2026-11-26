(function (root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('./reportPresentation') : root.ReportPresentation);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PortalAnalyticsCharts = api;
})(typeof window !== 'undefined' ? window : globalThis, function (presentation) {
    'use strict';

    const dayLabel = value => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });

    function shared(colors) {
        return {
            animation: colors.motion,
            animationDuration: 180,
            textStyle: { fontFamily: colors.font, color: colors.text, fontSize: 12 },
            aria: { enabled: true },
            tooltip: { confine: true, triggerOn: 'mousemove|click', renderMode: 'richText', backgroundColor: colors.surface,
                borderColor: colors.border, textStyle: { color: colors.text, fontSize: 12 }, shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0 }
        };
    }

    function trend(data, colors, style = 'line') {
        const ticks = colors.width < 400 ? 3 : 6;
        const bars = style === 'bar';
        const curve = style === 'curve';
        const metrics = [
            ['submitted', 'Submitted', colors.blue, 'circle'],
            ['ongoing', 'Ongoing', colors.ongoing, 'diamond'],
            ['resolved', 'Resolved', colors.resolved, 'rect']
        ];
        return {
            ...shared(colors),
            grid: { top: 16, left: 38, right: 18, bottom: 54 },
            legend: { data: metrics.map(([, name, , symbol]) => ({ name, icon: bars ? 'rect' : symbol })), bottom: 0,
                textStyle: { color: colors.muted, fontSize: 12 }, itemWidth: 12, itemHeight: 8 },
            tooltip: { ...shared(colors).tooltip, trigger: 'axis', formatter(parameters) {
                const date = parameters[0]?.axisValue;
                const day = data.daily.find(day => day.date === date);
                return day ? [date, ...metrics.map(([key, label]) => `${label}: ${day[key] ?? 'Unavailable'}`)].join('\n') : '';
            } },
            xAxis: { type: 'category', data: data.daily.map(day => day.date), boundaryGap: bars,
                axisLabel: { color: colors.muted, formatter: dayLabel, interval: Math.max(0, Math.ceil(data.daily.length / ticks) - 1), hideOverlap: true, showMaxLabel: true },
                axisLine: { lineStyle: { color: colors.border } }, axisTick: { show: false } },
            yAxis: { type: 'value', min: 0, minInterval: 1, splitNumber: 4, axisLabel: { color: colors.muted },
                splitLine: { lineStyle: { color: colors.border, type: 'solid', opacity: 0.65 } } },
            series: metrics.map(([key, name, color, symbol]) => ({
                name, data: data.daily.map(day => day[key] ?? null), itemStyle: { color },
                ...(bars ? { type: 'bar', barMaxWidth: 24 } : {
                    type: 'line', symbol: value => value > 0 ? symbol : 'none', symbolSize: 5, connectNulls: false,
                    smooth: curve ? 0.3 : false, smoothMonotone: 'x',
                    lineStyle: { width: 2, color, type: 'solid' }
                })
            }))
        };
    }

    function categories(data, colors, style = 'bar') {
        const pie = style === 'pie';
        const rows = pie ? data.categories.filter(category => category.count > 0) : data.categories;
        const entries = rows.map(category => ({
            name: category.label, value: category.count,
            itemStyle: { color: colors.category(presentation.categoryIconName(category.key)) }
        }));
        const options = {
            ...shared(colors),
            tooltip: { ...shared(colors).tooltip, trigger: 'item', transitionDuration: colors.motion ? 0.15 : 0, formatter(parameter) {
                const category = rows[parameter.dataIndex];
                if (!category) return '';
                return `${category.label}\n${category.count} ${category.count === 1 ? 'report' : 'reports'} (${Math.round(category.percentage * 10) / 10}%)\nAll period submissions: ${data.totals.submitted}`;
            } }
        };
        if (pie) return {
            ...options,
            animationDuration: 320,
            animationEasing: 'cubicOut',
            tooltip: { show: false },
            series: [{ name: 'Reports', type: 'pie', radius: ['65%', '91%'], data: entries,
                label: { show: false }, labelLine: { show: false }, animationType: 'scale', cursor: 'default',
                showEmptyCircle: true, emptyCircleStyle: { color: colors.border },
                itemStyle: { borderColor: colors.surface, borderWidth: 2, borderRadius: 3 },
                emphasis: { scale: colors.motion, scaleSize: 4 } }]
        };
        const rich = Object.fromEntries(entries.map(({ itemStyle: { color } }, index) => [`mark${index}`, { color, fontSize: 10, padding: [0, 4, 0, 0] }]));
        const right = Math.max(36, String(Math.max(...rows.map(category => category.count))).length * 8 + 10);
        const categoryAxis = { type: 'category', inverse: true, data: rows.map(category => category.label), axisLine: { show: false }, axisTick: { show: false } };
        return {
            ...options,
            grid: { top: 12, bottom: 12, left: colors.width < 400 ? 128 : 144, right },
            xAxis: { type: 'value', min: 0, minInterval: 1, show: false },
            yAxis: [
                { ...categoryAxis, axisLabel: { interval: 0, color: colors.text, width: colors.width < 400 ? 114 : 128, overflow: 'truncate', lineHeight: 16, fontSize: 12, rich,
                    formatter: (label, index) => `{mark${index}|●}${label}` } },
                { ...categoryAxis, position: 'right', axisLabel: { interval: 0, align: 'right', margin: right - 4, color: colors.text, fontSize: 12, fontWeight: 600,
                    formatter: (_label, index) => String(rows[index].count) } }
            ],
            series: [{ name: 'Reports', type: 'bar', data: entries, barWidth: 8, showBackground: true,
                backgroundStyle: { color: colors.track, borderRadius: 4 },
                itemStyle: { borderRadius: 4 } }]
        };
    }

    function barangays(rows, colors) {
        const metrics = [
            ['submitted', 'Submitted', colors.blue], ['ongoing', 'Ongoing', colors.ongoing],
            ['resolved', 'Resolved', colors.resolved]
        ];
        return {
            ...shared(colors),
            grid: { top: 8, bottom: 55, left: colors.width < 400 ? 109 : 155, right: 22 },
            legend: { bottom: 0, textStyle: { color: colors.text } },
            tooltip: { ...shared(colors).tooltip, trigger: 'axis' },
            xAxis: { type: 'value', min: 0, minInterval: 1, axisLabel: { color: colors.muted },
                splitLine: { lineStyle: { color: colors.border } } },
            yAxis: { type: 'category', inverse: true, data: rows.map(row => row.name),
                axisLabel: { interval: 0, width: colors.width < 400 ? 95 : 140, overflow: 'truncate', color: colors.text } },
            series: metrics.map(([key, name, color]) => ({ name, type: 'bar', barMaxWidth: 7,
                itemStyle: { color }, data: rows.map(row => row[key]) }))
        };
    }

    return { trend, categories, barangays };
});
