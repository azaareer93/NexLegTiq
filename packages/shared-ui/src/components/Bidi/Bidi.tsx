import type { ReactNode } from 'react';

interface BidiProps {
  readonly children: ReactNode;
}

/**
 * Left-to-right content inside right-to-left text: file numbers, phone numbers, emails, URLs, amounts, ids
 * (frontend.md). It keeps its own order and never reorders the surrounding Arabic.
 */
export function Ltr({ children }: BidiProps): React.JSX.Element {
  return (
    <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>
      {children}
    </span>
  );
}

/** Content of unknown direction (a name that may be Arabic or Latin): isolated, its direction taken from its own text. */
export function Bdi({ children }: BidiProps): React.JSX.Element {
  return <bdi>{children}</bdi>;
}
