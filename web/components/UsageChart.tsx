'use client';

interface UsageChartProps {
  data: Array<{ date: string; costUsd: number }>;
}

export function UsageChart({ data }: UsageChartProps) {
  if (data.length === 0) return null;

  const maxCost = Math.max(...data.map(d => d.costUsd), 0.01);
  const chartHeight = 160;
  const barGap = 2;
  const barWidth = Math.max(4, Math.min(32, (600 - data.length * barGap) / data.length));
  const chartWidth = data.length * (barWidth + barGap);

  return (
    <div className="usage-chart" style={{ margin: '1rem 0' }}>
      <svg width="100%" viewBox={`0 0 ${chartWidth + 60} ${chartHeight + 40}`} style={{ maxWidth: Math.max(chartWidth + 60, 300) }}>
        {/* Y-axis labels */}
        <text x="50" y="12" textAnchor="end" fontSize="10" fill="#666">${maxCost.toFixed(2)}</text>
        <text x="50" y={chartHeight / 2 + 6} textAnchor="end" fontSize="10" fill="#666">${(maxCost / 2).toFixed(2)}</text>
        <text x="50" y={chartHeight + 4} textAnchor="end" fontSize="10" fill="#666">$0</text>

        {/* Bars */}
        {data.map((d, i) => {
          const barHeight = (d.costUsd / maxCost) * chartHeight;
          const x = 60 + i * (barWidth + barGap);
          const y = chartHeight - barHeight;
          return (
            <g key={d.date}>
              <title>{`${d.date}: $${d.costUsd.toFixed(4)}`}</title>
              <rect x={x} y={y} width={barWidth} height={barHeight} fill="#3b82f6" rx="2" />
              {/* X-axis labels — show every Nth label to avoid overlap */}
              {(data.length <= 10 || i % Math.ceil(data.length / 10) === 0) && (
                <text x={x + barWidth / 2} y={chartHeight + 16} textAnchor="middle" fontSize="9" fill="#666">
                  {d.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}

        {/* Baseline */}
        <line x1="58" y1={chartHeight} x2={chartWidth + 60} y2={chartHeight} stroke="#ccc" strokeWidth="1" />
      </svg>
    </div>
  );
}
