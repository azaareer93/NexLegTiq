import type AntdIcon from '@ant-design/icons';
import { ConfigProvider } from 'antd';
import { useContext } from 'react';
import type { ComponentProps, ComponentType } from 'react';

type IconProps = Omit<ComponentProps<typeof AntdIcon>, 'ref'>;

export interface DirectionalIconProps extends IconProps {
  /** An icon that points somewhere (arrow, chevron, back, undo). Checkmarks, play buttons and logos never flip. */
  readonly icon: ComponentType<IconProps>;
}

/** Renders the icon mirrored in right-to-left layouts, so "back" and "next" point the right way in Arabic. */
export function DirectionalIcon({ icon: Icon, style, ...props }: DirectionalIconProps): React.JSX.Element {
  const { direction } = useContext(ConfigProvider.ConfigContext);
  return <Icon {...props} style={direction === 'rtl' ? { ...style, transform: 'scaleX(-1)' } : style} />;
}
