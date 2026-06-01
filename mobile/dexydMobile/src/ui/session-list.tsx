import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { DexydSession } from '../types/dexyd';
import { colors, radii, spacing } from './theme';

type Props = {
  sessions: DexydSession[];
  onSetStatus: (sessionId: string, status: DexydSession['status']) => void;
};

const statusOptions: DexydSession['status'][] = ['running', 'idle', 'completed', 'cancelled'];

const statusTone: Record<DexydSession['status'], string> = {
  created: colors.warning,
  running: colors.cyan,
  idle: colors.textMuted,
  completed: colors.success,
  failed: colors.danger,
  cancelled: colors.warning
};

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function SessionList({ sessions, onSetStatus }: Props) {
  return (
    <FlatList
      data={sessions}
      keyExtractor={(item) => item.id}
      contentContainerStyle={sessions.length === 0 ? styles.emptyContainer : styles.listContent}
      renderItem={({ item }) => {
        const tone = statusTone[item.status] ?? colors.textMuted;
        return (
          <View style={styles.item}>
            <View style={styles.itemHeader}>
              <View style={[styles.statusDot, { backgroundColor: tone }]} />
              <Text style={[styles.status, { color: tone }]}>{item.status.toUpperCase()}</Text>
              <Text style={styles.id}>{shortId(item.id)}</Text>
            </View>

            <Text style={styles.path} numberOfLines={2}>
              {item.workspacePath}
            </Text>
            <Text style={styles.meta}>Profile {item.profile} · Updated {new Date(item.updatedAt).toLocaleString()}</Text>

            <View style={styles.actionsRow}>
              {statusOptions.map((status) => (
                <Pressable
                  key={status}
                  style={({ pressed }) => [styles.tag, pressed && styles.tagPressed]}
                  onPress={() => onSetStatus(item.id, status)}>
                  <Text style={styles.tagText}>{status}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      }}
      ListEmptyComponent={
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No sessions yet</Text>
          <Text style={styles.emptyText}>Create a session with a workspace path to begin monitoring work from your phone.</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: spacing.xl
  },
  emptyContainer: {
    flexGrow: 1
  },
  item: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    backgroundColor: colors.surfaceElevated
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill,
    marginRight: spacing.sm
  },
  status: {
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.8,
    marginRight: spacing.sm
  },
  id: {
    color: colors.textSubtle,
    fontSize: 12,
    marginLeft: 'auto'
  },
  path: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: spacing.xs
  },
  meta: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: spacing.md
  },
  emptyCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.xl,
    backgroundColor: colors.surface,
    padding: spacing.xl,
    alignItems: 'center'
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: spacing.sm
  },
  emptyText: {
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  },
  tag: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border
  },
  tagPressed: {
    backgroundColor: colors.borderStrong
  },
  tagText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '700'
  }
});
