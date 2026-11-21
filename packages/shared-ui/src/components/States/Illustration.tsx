import { theme } from 'antd';

/** The pictures of the empty states (MVP-109): original line drawings, symmetric so they read the same in RTL and LTR. */
export type IllustrationKind = 'cases' | 'clients' | 'calendar' | 'documents' | 'start';

/** A small decorative drawing in the theme's colours; hidden from screen readers (the title says it all). */
export function Illustration({ kind }: { readonly kind: IllustrationKind }): React.JSX.Element {
  const { token } = theme.useToken();
  const line = token.colorPrimary;
  const fill = token.colorPrimaryBg;
  const soft = token.colorBorderSecondary;
  const stroke = { stroke: line, strokeWidth: 2, strokeLinecap: 'round', fill: 'none' } as const;
  return (
    <svg
      viewBox="0 0 120 80"
      width={120}
      height={80}
      aria-hidden="true"
      focusable="false"
      data-testid={`illustration-${kind}`}
    >
      <ellipse cx={60} cy={72} rx={44} ry={5} fill={soft} />
      {kind === 'cases' ? (
        <>
          <path d="M28 22h18l6 7h16l6-7h18v44H28z" {...stroke} fill={fill} />
          <path d="M44 46h32M44 54h32" {...stroke} />
        </>
      ) : null}
      {kind === 'clients' ? (
        <>
          <circle cx={60} cy={28} r={11} {...stroke} fill={fill} />
          <path d="M38 64c0-13 10-21 22-21s22 8 22 21z" {...stroke} fill={fill} />
        </>
      ) : null}
      {kind === 'calendar' ? (
        <>
          <rect x={30} y={18} width={60} height={48} rx={4} {...stroke} fill={fill} />
          <path d="M30 30h60M45 12v12M75 12v12" {...stroke} />
          <path d="M48 42h4M58 42h4M68 42h4M48 52h4M58 52h4M68 52h4" {...stroke} />
        </>
      ) : null}
      {kind === 'documents' ? (
        <>
          <rect x={40} y={12} width={40} height={54} rx={3} {...stroke} fill={fill} />
          <path d="M48 26h24M48 34h24M48 42h24M52 50h16" {...stroke} />
        </>
      ) : null}
      {kind === 'start' ? (
        <>
          <path d="M60 10c10 8 14 20 12 36H48c-2-16 2-28 12-36z" {...stroke} fill={fill} />
          <circle cx={60} cy={30} r={5} {...stroke} />
          <path d="M48 46l-8 12h12M72 46l8 12H68M56 52v10M64 52v10" {...stroke} />
        </>
      ) : null}
    </svg>
  );
}
