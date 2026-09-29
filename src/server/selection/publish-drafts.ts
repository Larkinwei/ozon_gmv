import { randomUUID } from "node:crypto";

import type { PublishDraftStage, PublishDraftView, PublishSourceType, PublishVariantDraft, ResellSourceView, ResellStatus } from "../../shared/contracts";
import type { AppDatabase } from "../db/database";

interface DraftRow {
  id: string;
  source_type: PublishSourceType;
  source_sku: string;
  title: string | null;
  source_snapshot_json: string;
  field_overrides_json: string;
  variants_json: string;
  workflow_stage: PublishDraftStage;
  created_at_ms: number;
  updated_at_ms: number;
}

function toView(row: DraftRow): PublishDraftView {
  return {
    id: row.id,
    sourceType: row.source_type,
    workflowStage: row.workflow_stage,
    sourceSku: row.source_sku,
    title: row.title,
    sourceSnapshot: JSON.parse(row.source_snapshot_json) as ResellSourceView,
    fieldOverrides: JSON.parse(row.field_overrides_json) as Record<string, unknown>,
    variants: JSON.parse(row.variants_json || "[]") as PublishVariantDraft[],
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
  };
}

/** Stores source snapshots and user overrides separately from publish tasks. */
export class PublishDraftsModule {
  public constructor(private readonly database: AppDatabase) {}

  /** Creates a new local draft without storing credentials or customer data. */
  public create(input: { sourceType: PublishSourceType; sourceSku: string; title?: string | null | undefined; sourceSnapshot: ResellSourceView; fieldOverrides?: Record<string, unknown> | undefined; variants?: PublishVariantDraft[] | undefined; workflowStage?: PublishDraftStage | undefined }): PublishDraftView {
    const id = randomUUID();
    const now = Date.now();
    this.database.prepare(`INSERT INTO publish_drafts
      (id, source_type, source_sku, title, source_snapshot_json, field_overrides_json, workflow_stage, created_at_ms, updated_at_ms, variants_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.sourceType, input.sourceSku, input.title ?? (input.sourceSnapshot.productName || null),
        JSON.stringify(input.sourceSnapshot), JSON.stringify(input.fieldOverrides ?? {}), input.workflowStage ?? "collected", now, now, JSON.stringify(input.variants ?? []));
    return this.get(id)!;
  }

  /** Reads a local draft by id. */
  public get(id: string): PublishDraftView | null {
    const row = this.database.prepare("SELECT * FROM publish_drafts WHERE id = ?").get(id) as DraftRow | undefined;
    return row ? this.withTaskStatuses(toView(row)) : null;
  }

  /** Lists local drafts for AI context selection without contacting a marketplace. */
  public list(stage?: PublishDraftStage): PublishDraftView[] {
    const rows = stage
      ? this.database.prepare("SELECT * FROM publish_drafts WHERE workflow_stage = ? ORDER BY updated_at_ms DESC LIMIT 200").all(stage) as DraftRow[]
      : this.database.prepare("SELECT * FROM publish_drafts ORDER BY updated_at_ms DESC LIMIT 200").all() as DraftRow[];
    return rows.map((row) => this.withTaskStatuses(toView(row)));
  }

  /** Deletes a local collection or processing draft. */
  public delete(id: string): boolean {
    return this.database.prepare("DELETE FROM publish_drafts WHERE id = ?").run(id).changes > 0;
  }

  /** Updates only the editable snapshot and overrides supplied by the caller. */
  public update(id: string, input: { sourceType?: PublishSourceType | undefined; sourceSku?: string | undefined; title?: string | null | undefined; sourceSnapshot?: ResellSourceView | undefined; fieldOverrides?: Record<string, unknown> | undefined; variants?: PublishVariantDraft[] | undefined; workflowStage?: PublishDraftStage | undefined }): PublishDraftView | null {
    const current = this.database.prepare("SELECT * FROM publish_drafts WHERE id = ?").get(id) as DraftRow | undefined;
    if (!current) return null;
    const nextType = input.sourceType ?? current.source_type;
    const nextSku = input.sourceSku ?? current.source_sku;
    const nextTitle = input.title === undefined ? current.title : input.title;
    const nextSnapshot = input.sourceSnapshot ? JSON.stringify(input.sourceSnapshot) : current.source_snapshot_json;
    const nextOverrides = input.fieldOverrides ? JSON.stringify(input.fieldOverrides) : current.field_overrides_json;
    const nextVariants = input.variants ? JSON.stringify(input.variants.map(({ task: _task, ...variant }) => variant)) : current.variants_json;
    const nextStage = input.workflowStage ?? current.workflow_stage;
    this.database.prepare(`UPDATE publish_drafts
      SET source_type = ?, source_sku = ?, title = ?, source_snapshot_json = ?, field_overrides_json = ?, workflow_stage = ?, updated_at_ms = ?, variants_json = ?
      WHERE id = ?`)
      .run(nextType, nextSku, nextTitle, nextSnapshot, nextOverrides, nextStage, Date.now(), nextVariants, id);
    return this.get(id);
  }

  /** Adds the latest task state for every variant without duplicating task data in JSON. */
  private withTaskStatuses(draft: PublishDraftView): PublishDraftView {
    if (draft.variants.length === 0) return draft;
    const rows = this.database.prepare(`SELECT publish_variant_id, id, status, product_id, last_error
      FROM resell_tasks WHERE publish_draft_id = ? AND publish_variant_id IS NOT NULL
      ORDER BY created_at_ms DESC`).all(draft.id) as Array<{
        publish_variant_id: string; id: string; status: ResellStatus; product_id: string | null; last_error: string | null;
      }>;
    const taskByVariant = new Map<string, typeof rows[number]>();
    rows.forEach((row) => { if (!taskByVariant.has(row.publish_variant_id)) taskByVariant.set(row.publish_variant_id, row); });
    return {
      ...draft,
      variants: draft.variants.map((variant) => {
        const task = taskByVariant.get(variant.id);
        return { ...variant, task: task ? { id: task.id, status: task.status, productId: task.product_id, lastError: task.last_error } : null };
      }),
    };
  }
}
