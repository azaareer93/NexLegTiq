import type { AdminUsage } from '@nexlegtiq/shared-contracts';
import { useFormat } from '@nexlegtiq/shared-ui';
import { Table, theme, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

const HEIGHT = 160;
const BAR = 10;
const GAP = 2;

/**
 * AI cost per day (one series, so no legend: the title names it). Thin bars with a rounded data end on the baseline, a
 * surface gap between bars, a tooltip per bar and the same numbers as a table (dataviz rules, D-183).
 */
export function CostChart({ days }: { readonly days: AdminUsage['aiCostByDay'] }) {
  const { t } = useTranslation();
  const format = useFormat();
  const { token } = theme.useToken();
  const max = Math.max(...days.map((d) => Number(d.costUsd)), 0);
  const usd = (v: string) => format.money(v, 'USD');
  if (days.length === 0) {
    return <Typography.Text type="secondary">{t('admin.usage.noCost')}</Typography.Text>;
  }
  const width = days.length * (BAR + GAP);
  return (
    <figure style={{ margin: 0 }} data-testid="usage-cost-chart">
      <svg
        role="img"
        aria-label={t('admin.usage.costChart', { max: usd(String(max)) })}
        viewBox={`0 0 ${width} ${HEIGHT + 1}`}
        style={{
          inlineSize: '100%',
          maxInlineSize: width * 3,
          blockSize: HEIGHT,
          display: 'block',
        }}
        preserveAspectRatio="none"
      >
        <line
          x1={0}
          x2={width}
          y1={HEIGHT}
          y2={HEIGHT}
          stroke={token.colorBorderSecondary}
          strokeWidth={1}
        />
        {days.map((d, i) => {
          const h = max > 0 ? Math.max(2, (Number(d.costUsd) / max) * (HEIGHT - 4)) : 2;
          return (
            <Tooltip
              key={d.date}
              title={`${format.date(d.date)} · ${usd(d.costUsd)} · ${d.operations}`}
            >
              <rect
                x={i * (BAR + GAP)}
                y={HEIGHT - h}
                width={BAR}
                height={h}
                rx={2}
                fill={token.colorPrimary}
                data-testid={`usage-bar-${d.date}`}
              >
                <title>{`${format.date(d.date)}: ${usd(d.costUsd)}`}</title>
              </rect>
            </Tooltip>
          );
        })}
      </svg>
      <figcaption>
        <Typography.Text type="secondary">
          {t('admin.usage.peak', { max: usd(String(max)) })}
        </Typography.Text>
      </figcaption>
      <details>
        <summary>{t('admin.usage.asTable')}</summary>
        <Table
          size="small"
          rowKey="date"
          pagination={false}
          dataSource={days}
          columns={[
            {
              key: 'date',
              title: t('admin.usage.columns.date'),
              render: (_, d) => format.date(d.date),
            },
            {
              key: 'cost',
              title: t('admin.usage.columns.cost'),
              align: 'end',
              render: (_, d) => usd(d.costUsd),
            },
            {
              key: 'ops',
              title: t('admin.usage.columns.operations'),
              align: 'end',
              render: (_, d) => format.number(d.operations),
            },
          ]}
        />
      </details>
    </figure>
  );
}
