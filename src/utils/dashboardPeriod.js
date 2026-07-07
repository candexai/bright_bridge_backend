const PRESET_DAYS = {
    '1d': 1,
    '7d': 7,
    '15d': 15,
    '30d': 30,
    daily: 1,
    weekly: 7,
    monthly: 30,
};

function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function endOfDay(date) {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
}

function parseDateInput(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve dashboard date window from query params.
 * Supports presets (1d, 7d, 15d, 30d) and custom startDate/endDate (YYYY-MM-DD).
 */
function resolveDashboardPeriod(query = {}) {
    const period = String(query.period || '30d').trim().toLowerCase();
    const now = new Date();

    if (period === 'custom') {
        const start = parseDateInput(query.startDate);
        const end = parseDateInput(query.endDate);
        if (!start || !end) {
            return { error: 'startDate and endDate are required for custom period' };
        }
        const periodStart = startOfDay(start);
        const periodEnd = endOfDay(end);
        if (periodStart > periodEnd) {
            return { error: 'startDate must be on or before endDate' };
        }

        const daySpan = Math.floor((startOfDay(end) - startOfDay(start)) / (24 * 60 * 60 * 1000)) + 1;
        const bucketType = daySpan <= 1 ? 'hourly' : 'daily';

        return {
            period: 'custom',
            periodStart,
            periodEnd,
            chartBars: daySpan,
            bucketType,
            daySpan,
        };
    }

    const days = PRESET_DAYS[period] ?? PRESET_DAYS['30d'];
    const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const periodEnd = now;
    const bucketType = days <= 1 ? 'hourly' : 'daily';

    return {
        period,
        periodStart,
        periodEnd,
        chartBars: days,
        bucketType,
        daySpan: days,
    };
}

function isWithinPeriod(timestamp, periodStart, periodEnd) {
    const t = new Date(timestamp);
    if (Number.isNaN(t.getTime())) return false;
    return t >= periodStart && t <= periodEnd;
}

function buildDashboardChartData(calls, { periodStart, periodEnd, bucketType, chartBars, period }) {
    const chartData = [];
    const nowDate = new Date();

    if (bucketType === 'hourly') {
        const anchorEnd = period === 'custom' ? periodEnd : nowDate;
        for (let i = 23; i >= 0; i--) {
            const bucketEnd = new Date(anchorEnd.getTime() - i * 60 * 60 * 1000);
            const bucketStart = new Date(bucketEnd.getTime() - 60 * 60 * 1000);
            const bucketCalls = calls.filter((c) => {
                const t = new Date(c.timestamp);
                return t >= bucketStart && t < bucketEnd;
            });
            chartData.push({
                name: bucketEnd.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
                calls: bucketCalls.length,
            });
        }
        return chartData;
    }

    if (period === 'custom') {
        const start = startOfDay(periodStart);
        for (let i = 0; i < chartBars; i++) {
            const day = new Date(start);
            day.setDate(start.getDate() + i);
            const nextDay = new Date(day);
            nextDay.setDate(day.getDate() + 1);
            const dayCalls = calls.filter((c) => {
                const t = new Date(c.timestamp);
                return t >= day && t < nextDay;
            });
            chartData.push({
                name: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                calls: dayCalls.length,
            });
        }
        return chartData;
    }

    const todayAtMidnight = startOfDay(nowDate);
    for (let i = chartBars - 1; i >= 0; i--) {
        const day = new Date(todayAtMidnight);
        day.setDate(day.getDate() - i);
        const nextDay = new Date(day);
        nextDay.setDate(day.getDate() + 1);
        const dayCalls = calls.filter((c) => {
            const t = new Date(c.timestamp);
            return t >= day && t < nextDay;
        });
        chartData.push({
            name: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            calls: dayCalls.length,
        });
    }

    return chartData;
}

module.exports = {
    resolveDashboardPeriod,
    isWithinPeriod,
    buildDashboardChartData,
};
