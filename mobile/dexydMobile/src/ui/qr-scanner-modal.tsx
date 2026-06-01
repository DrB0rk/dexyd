import React, { useEffect, useMemo, useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing } from './theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  onScanned: (value: string) => void;
};

type ScannerModules = {
  CodeScanner: React.ComponentType<any>;
  useCameraPermission: () => {
    hasPermission: boolean;
    requestPermission: () => Promise<boolean>;
  };
};

function loadScannerModules(): ScannerModules | null {
  try {
    const camera = require('react-native-vision-camera') as {
      useCameraPermission: ScannerModules['useCameraPermission'];
    };
    const barcode = require('react-native-vision-camera-barcode-scanner') as {
      CodeScanner: ScannerModules['CodeScanner'];
    };

    if (!camera.useCameraPermission || !barcode.CodeScanner) {
      return null;
    }

    return {
      useCameraPermission: camera.useCameraPermission,
      CodeScanner: barcode.CodeScanner
    };
  } catch {
    return null;
  }
}

export function QrScannerModal({ visible, onClose, onScanned }: Props) {
  const scannerModules = useMemo(() => (visible ? loadScannerModules() : null), [visible]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <ScannerHeader onClose={onClose} />

        {scannerModules ? (
          <NativeQrScanner visible={visible} modules={scannerModules} onClose={onClose} onScanned={onScanned} />
        ) : (
          <View style={styles.centered}>
            <View style={styles.permissionCard}>
              <Text style={styles.permissionTitle}>Scanner unavailable</Text>
              <Text style={styles.info}>Close this screen and paste the pairing URI manually. The app can still pair without camera access.</Text>
            </View>
          </View>
        )}

        <View style={styles.hintBox}>
          <Text style={styles.hintTitle}>Tip</Text>
          <Text style={styles.hintText}>Open `npm run tui`, go to Pairing, generate a QR, then center it in the frame.</Text>
        </View>
      </View>
    </Modal>
  );
}

function ScannerHeader({ onClose }: { onClose: () => void }) {
  return (
    <View style={styles.topBar}>
      <View>
        <Text style={styles.eyebrow}>PAIR THIS PHONE</Text>
        <Text style={styles.title}>Scan bridge QR</Text>
      </View>
      <Pressable style={({ pressed }) => [styles.closeButton, pressed && styles.buttonPressed]} onPress={onClose}>
        <Text style={styles.closeText}>Close</Text>
      </Pressable>
    </View>
  );
}

function NativeQrScanner({
  visible,
  modules,
  onClose,
  onScanned
}: {
  visible: boolean;
  modules: ScannerModules;
  onClose: () => void;
  onScanned: (value: string) => void;
}) {
  const { hasPermission, requestPermission } = modules.useCameraPermission();
  const scanLockedRef = useRef(false);
  const CodeScanner = modules.CodeScanner;

  useEffect(() => {
    if (visible && !hasPermission) {
      requestPermission().catch(() => undefined);
    }
  }, [hasPermission, requestPermission, visible]);

  useEffect(() => {
    if (!visible) {
      scanLockedRef.current = false;
    }
  }, [visible]);

  if (!hasPermission) {
    return (
      <View style={styles.centered}>
        <View style={styles.permissionCard}>
          <Text style={styles.permissionTitle}>Camera access required</Text>
          <Text style={styles.info}>dexyd needs the camera only to read the local pairing QR code from your bridge TUI.</Text>
          <Pressable style={styles.actionButton} onPress={() => requestPermission().catch(() => undefined)}>
            <Text style={styles.actionText}>Grant camera access</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.scannerWrap}>
      <CodeScanner
        style={styles.scanner}
        isActive={visible}
        barcodeFormats={['qr-code']}
        onBarcodeScanned={(codes: Array<{ rawValue?: string; displayValue?: string }>) => {
          if (scanLockedRef.current) return;

          const first = codes[0];
          const rawValue = first?.rawValue ?? first?.displayValue;
          if (!rawValue) return;

          scanLockedRef.current = true;
          onScanned(rawValue);
          onClose();
        }}
        onError={() => undefined}
      />
      <View pointerEvents="none" style={styles.scanFrame}>
        <View style={styles.cornerTopLeft} />
        <View style={styles.cornerTopRight} />
        <View style={styles.cornerBottomLeft} />
        <View style={styles.cornerBottomRight} />
      </View>
    </View>
  );
}

const corner = {
  position: 'absolute' as const,
  width: 34,
  height: 34,
  borderColor: colors.cyan
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background
  },
  topBar: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    backgroundColor: colors.surface
  },
  eyebrow: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
    marginBottom: spacing.xs
  },
  title: {
    color: colors.text,
    fontWeight: '900',
    fontSize: 22
  },
  closeButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border
  },
  buttonPressed: {
    opacity: 0.82
  },
  closeText: {
    color: colors.text,
    fontWeight: '800'
  },
  scannerWrap: {
    flex: 1,
    margin: spacing.lg,
    borderRadius: radii.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: '#000'
  },
  scanner: {
    flex: 1
  },
  scanFrame: {
    position: 'absolute',
    left: '15%',
    right: '15%',
    top: '22%',
    bottom: '22%',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: 'rgba(108, 229, 255, 0.22)'
  },
  cornerTopLeft: {
    ...corner,
    top: -1,
    left: -1,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: radii.md
  },
  cornerTopRight: {
    ...corner,
    top: -1,
    right: -1,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: radii.md
  },
  cornerBottomLeft: {
    ...corner,
    bottom: -1,
    left: -1,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: radii.md
  },
  cornerBottomRight: {
    ...corner,
    bottom: -1,
    right: -1,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: radii.md
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl
  },
  permissionCard: {
    width: '100%',
    borderRadius: radii.xl,
    padding: spacing.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center'
  },
  permissionTitle: {
    color: colors.text,
    fontWeight: '900',
    fontSize: 20,
    marginBottom: spacing.sm
  },
  info: {
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: spacing.lg,
    lineHeight: 21
  },
  actionButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl
  },
  actionText: {
    color: colors.text,
    fontWeight: '900'
  },
  hintBox: {
    margin: spacing.lg,
    marginTop: 0,
    padding: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface
  },
  hintTitle: {
    color: colors.cyan,
    fontWeight: '900',
    marginBottom: spacing.xs
  },
  hintText: {
    color: colors.textMuted,
    lineHeight: 20
  }
});
