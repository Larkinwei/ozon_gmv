import { randomUUID } from "node:crypto";

import type { PublishDraftView, PublishSourceType, ResellSourceView } from "../../shared/contracts";
import type { AppDatabase } from "../db/database";

interface DraftRow {
  id: string;
  source_type: PublishSourceType;
  source_sku: string;
  title: string | null;
  source_snapshot_json: string;
  field_overrides_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function toView(row: DraftRow): PublishDraftView {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceSku: row.source_sku,
    title: row.title,
    sourceSnapshot: JSON.parse(row.source_snapshot_json) as ResellSourceView,
    fieldOverrides: JSON.parse(row.field_overrides_json) as Record<string, unknown>,
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
  };
}

/** Stores source snapshots and user overrides separately from publish tasks. */
export class PublishDraftsModule {
  public constructor(private readonly database: AppDatabase) {}

  /** Creates a new local draft without storing credentials or customer data. */
  public create(input: { sourceType: PublishSourceType; sourceSku: string; title?: string | null | undefined; sourceSnapshot: ResellSourceView; fieldOverrides?: Record<string, unknown> | undefined }): PublishDraftView {
    const id = randomUUID();
    const now = Date.now();
    this.database.prepare(`INSERT INTO publish_drafts
      (id, source_type, source_sku, title, source_snapshot_json, field_overrides_json, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.sourceType, input.sourceSku, input.title ?? (input.sourceSnapshot.productName || null),
        JSON.stringify(input.sourceSnapshot), JSON.stringify(input.fieldOverrides ?? {}), now, now);
    return this.get(id)!;
  }

  /** Reads a local draft by id. */
  public get(id: string): PublishDraftView | null {
    const row = this.database.prepare("SELECT * FROM publish_drafts WHERE id = ?").get(id) as DraftRow | undefined;
    return row ? toView(row) : null;
  }

  /** Lists local drafts for AI context selection without contacting a marketplace. */
  public list(): PublishDraftView[] {
    const rows = this.database.prepare("SELECT * FROM publish_drafts ORDER BY updated_at_ms DESC LIMIT 100").all() as DraftRow[];
    return rows.map(toView);
  }

  /** Updates only the editable snapshot and overrides supplied by the caller. */
  public update(id: string, input: { sourceType?: PublishSourceType | undefined; sourceSku?: string | undefined; title?: string | null | undefined; sourceSnapshot?: ResellSourceView | undefined; fieldOverrides?: Record<string, unknown> | undefined }): PublishDraftView | null {
    const current = this.database.prepare("SELECT * FROM publish_drafts WHERE id = ?").get(id) as DraftRow | undefined;
    if (!current) return null;
    const nextType = input.sourceType ?? current.source_type;
    const nextSku = input.sourceSku ?? current.source_sku;
    const nextTitle = input.title === undefined ? current.title : input.title;
    const nextSnapshot = input.sourceSnapshot ? JSON.stringify(input.sourceSnapshot) : current.source_snapshot_json;
    const nextOverrides = input.fieldOverrides ? JSON.stringify(input.fieldOverrides) : current.field_overrides_json;
    this.database.prepare(`UPDATE publish_drafts
      SET source_type = ?, source_sku = ?, title = ?, source_snapshot_json = ?, field_overrides_json = ?, updated_at_ms = ?
      WHERE id = ?`)
      .run(nextType, nextSku, nextTitle, nextSnapshot, nextOverrides, Date.now(), id);
    return this.get(id);
  }
}
