import { Host, Menu, RNHostView } from '@expo/ui/swift-ui';
import { accessibilityLabel, buttonStyle, menuIndicator, menuStyle } from '@expo/ui/swift-ui/modifiers';
import type { MaterialDesignIconsIconName } from '@react-native-vector-icons/material-design-icons';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { RailIcon } from './camera-status';

/**
 * A native menu behind one of the camera rail's icons, drawn like the rail's other icons.
 * `onPrimaryAction` makes a tap do that instead, and a long press open the menu.
 */
export function RailMenu({
  icon,
  color,
  text,
  label,
  onPrimaryAction,
  children,
}: {
  icon: MaterialDesignIconsIconName;
  color?: string;
  text?: string;
  /** For VoiceOver. */
  label: string;
  onPrimaryAction?: () => void;
  /** The menu's `Button`s, `Toggle`s and `Section`s, from @expo/ui/swift-ui. */
  children: ReactNode;
}) {
  return (
    <Host matchContents colorScheme="dark">
      <Menu
        label={
          <RNHostView matchContents>
            {/* Lets the tap through to the menu. */}
            <View style={styles.label}>
              <RailIcon icon={icon} color={color} text={text} />
            </View>
          </RNHostView>
        }
        onPrimaryAction={onPrimaryAction}
        modifiers={[menuStyle('button'), buttonStyle('plain'), menuIndicator('hidden'), accessibilityLabel(label)]}>
        {children}
      </Menu>
    </Host>
  );
}

const styles = StyleSheet.create({
  label: {
    pointerEvents: 'none',
  },
});
