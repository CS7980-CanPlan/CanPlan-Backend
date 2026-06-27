/**
 * Data migration: legacy → real-default-category + stable TaskStep keys + durable taskCount.
 *
 * Idempotent and SAFE TO RE-RUN. Defaults to DRY-RUN (reports only); pass `--apply` to
 * actually write. It performs these convergent migrations:
 *
 *   1. Default categories — make every UserProfile end with EXACTLY ONE valid default
 *      Category ("No Category", `isDefault: true`, its own UUID) that `defaultCategoryId`
 *      points at:
 *        - missing default            → create one + set the pointer,
 *        - missing/invalid pointer    → repair it to the surviving default,
 *        - duplicate defaults         → keep the lowest categoryId as THE default and
 *                                       DEMOTE the rest (set `isDefault:false`, rename to a
 *                                       deterministic "Recovered Category <short-id>",
 *                                       preserving color/sortOrder/taskCount/Task refs).
 *   2. NO_CATEGORY / dangling tasks — move every Task whose `categoryId` is the legacy
 *      "NO_CATEGORY" sentinel, missing, or points at a non-existent category to its owner's
 *      default category (updating `categoryId` + the denormalized `taskCategoryKey`).
 *   3. Legacy Task status — strip the removed `status` attribute from Task rows.
 *   4. Category taskCount — backfill each Category's durable `taskCount` to the actual number
 *      of Tasks filed under it (computed from the post-reparent task placement).
 *   5. Task step metadata — backfill `stepCount` / `stepVersion` / `nextStepOrder` on Tasks
 *      that lack them (from the task's real step rows), enabling concurrency-safe appends.
 *   6. TaskStep keys — rewrite order-based sort keys (STEP#001, …) to stable STEP#<stepId>
 *      keys, preserving every field (text, description, media ref, timestamps, order).
 *   7. Task order + owner counters — give every Task a per-owner `order` (assigned by
 *      createdAt order, after any order an owner's tasks already have) and backfill each
 *      profile's owner-level task counters (`taskCount` = the owner's live task count,
 *      `nextTaskOrder` = max assigned order + 1) so createTask/updateTaskOrder work on legacy
 *      data. Idempotent: tasks that already have an `order` and profiles that already have
 *      `nextTaskOrder` are left untouched.
 *
 * Enumerates rows via `entityTypeIndex` (no table Scan). Reports counts + per-row failures.
 *
 * ── Runbook / deployment sequence ──────────────────────────────────────────────────
 * The new code expects every Task to carry a real categoryId + step metadata, every profile
 * a valid defaultCategoryId, and every Category a `taskCount`. Old TaskStep rows stay
 * readable (the STEP# prefix is unchanged; reads sort by `order`); standalone `createTaskStep`
 * on a Task without step metadata is rejected until backfilled. Run as a MAINTENANCE migration:
 *   1. Deploy the new code.
 *   2. Dry-run:  npx ts-node scripts/migrate-default-categories.ts
 *   3. Apply:    npx ts-node scripts/migrate-default-categories.ts --apply
 *   4. Dry-run again to confirm zero pending changes (idempotency check).
 *
 * NOTE: deleteCategory relies on `taskCount`, so run this migration BEFORE relying on
 * category deletion against legacy data.
 *
 * Requires AWS credentials; set DYNAMODB_TABLE_NAME (e.g. CanPlanTasks-dev) and, if needed,
 * AWS_REGION (defaults to ca-central-1).
 */

import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  categorySk,
  DEFAULT_CATEGORY_COLOR,
  DEFAULT_CATEGORY_NAME,
  ENTITY,
  ENTITY_TYPE_INDEX,
  PROFILE_SK,
  stepSk,
  taskCategoryKey,
  taskPk,
  userPk,
} from '../src/shared/keys';

/** Legacy sentinel category id (removed from the codebase; referenced here for migration). */
const LEGACY_NO_CATEGORY = 'NO_CATEGORY';

interface Row {
  PK: string;
  SK: string;
  [k: string]: unknown;
}

export interface MigrationReport {
  profilesScanned: number;
  categoriesScanned: number;
  defaultsCreated: number;
  defaultsRepaired: number;
  /** Profiles requiring one or more default-flag demotions. */
  duplicateDefaults: number;
  /** Extra default categories demoted to normal categories (one kept per profile). */
  duplicatesRepaired: number;
  /** Concrete duplicate/default-flag repair actions, for audit/reporting. */
  duplicateDefaultRepairs: Array<{
    ownerId: string;
    keptCategoryId: string;
    demotedCategoryId: string;
    newName: string;
  }>;
  tasksScanned: number;
  tasksReparented: number;
  statusStripped: number;
  taskCountsBackfilled: number;
  /** Tasks given missing step metadata (stepCount/stepVersion/nextStepOrder). */
  stepMetaBackfilled: number;
  /** Tasks given a missing per-owner `order` (assigned by createdAt order). */
  taskOrdersBackfilled: number;
  /** Profiles given missing owner-level task counters (taskCount/nextTaskOrder). */
  profileTaskCountersBackfilled: number;
  stepsScanned: number;
  stepsRekeyed: number;
  failures: string[];
}

function emptyReport(): MigrationReport {
  return {
    profilesScanned: 0,
    categoriesScanned: 0,
    defaultsCreated: 0,
    defaultsRepaired: 0,
    duplicateDefaults: 0,
    duplicatesRepaired: 0,
    duplicateDefaultRepairs: [],
    tasksScanned: 0,
    tasksReparented: 0,
    statusStripped: 0,
    taskCountsBackfilled: 0,
    stepMetaBackfilled: 0,
    taskOrdersBackfilled: 0,
    profileTaskCountersBackfilled: 0,
    stepsScanned: 0,
    stepsRekeyed: 0,
    failures: [],
  };
}

const countKey = (ownerId: string, categoryId: string): string => `${ownerId}#${categoryId}`;

/**
 * Run the migration against a (real or mocked) document client. Returns a structured report;
 * never throws for per-row issues (those are collected in `report.failures`).
 */
export async function runMigration(opts: {
  client: DynamoDBDocumentClient;
  table: string;
  apply: boolean;
}): Promise<MigrationReport> {
  const { client, table, apply } = opts;
  const report = emptyReport();
  const log = (msg: string): void => console.log(msg);

  async function* byEntityType(entityType: string): AsyncGenerator<Row> {
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: ENTITY_TYPE_INDEX,
          KeyConditionExpression: 'entityType = :t',
          ExpressionAttributeValues: { ':t': entityType },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of (page.Items as Row[]) ?? []) yield item;
      startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
  }

  // ── 1. Load every Category, grouped by owner + indexed by (owner, categoryId) ──────────
  const categoriesByOwner = new Map<string, Row[]>();
  const categoryIndex = new Map<string, Row>();
  for await (const cat of byEntityType(ENTITY.CATEGORY)) {
    report.categoriesScanned++;
    const ownerId = cat.ownerId as string | undefined;
    const categoryId = cat.categoryId as string | undefined;
    if (!ownerId || !categoryId) {
      report.failures.push(`category ${cat.PK}/${cat.SK} missing ownerId/categoryId`);
      continue;
    }
    (categoriesByOwner.get(ownerId) ?? categoriesByOwner.set(ownerId, []).get(ownerId)!).push(cat);
    categoryIndex.set(countKey(ownerId, categoryId), cat);
  }

  // ── 2. Resolve each profile to EXACTLY ONE valid default category ───────────────────────
  const defaultByOwner = new Map<string, string>();
  const defaultsToCreate = new Map<string, string>(); // ownerId → new default categoryId
  const pointerRepairs: Array<{ userId: string; defaultCategoryId: string }> = [];
  const duplicateDemotions: Array<{ ownerId: string; categoryId: string; newName: string }> = [];
  // Profiles + their current owner-level task counters (for the taskCount/nextTaskOrder backfill).
  const profileRows: Array<{ userId: string; hasTaskCounter: boolean }> = [];

  for await (const profile of byEntityType(ENTITY.USER_PROFILE)) {
    report.profilesScanned++;
    const userId = profile.userId as string | undefined;
    if (!userId) {
      report.failures.push(`profile ${profile.PK}/${profile.SK} has no userId`);
      continue;
    }
    // nextTaskOrder is the authoritative "already migrated" marker (taskCount alone could be 0).
    profileRows.push({ userId, hasTaskCounter: typeof profile.nextTaskOrder === 'number' });
    const cats = categoriesByOwner.get(userId) ?? [];
    // Deterministic order so the surviving default is reproducible (lowest categoryId).
    const canonicalDefaults = cats
      .filter((c) => c.isDefault === true && c.name === DEFAULT_CATEGORY_NAME)
      .sort((a, b) =>
        (a.categoryId as string) < (b.categoryId as string)
          ? -1
          : (a.categoryId as string) > (b.categoryId as string)
            ? 1
            : 0,
      );
    const existingChosen = canonicalDefaults[0]?.categoryId as string | undefined;
    // Allocate a planned id before recording demotions so the report can identify the exact
    // survivor even when this profile needs a newly created canonical default.
    const chosen = existingChosen ?? randomUUID();

    // Exactly one category may retain the default flag. This covers both duplicate canonical
    // defaults and legacy `isDefault: true` rows whose name is not the exact canonical
    // "No Category" spelling. The latter cannot remain valid at runtime, so it is demoted
    // (and a new canonical default is created below when needed).
    const flaggedDefaults = cats
      .filter((c) => c.isDefault === true)
      .sort((a, b) =>
        (a.categoryId as string) < (b.categoryId as string)
          ? -1
          : (a.categoryId as string) > (b.categoryId as string)
            ? 1
            : 0,
      );
    if (flaggedDefaults.some((c) => c.categoryId !== chosen)) {
      report.duplicateDefaults++;
      for (const extra of flaggedDefaults) {
        const extraId = extra.categoryId as string;
        if (extraId === existingChosen) continue;
        const newName = `Recovered Category ${extraId.slice(0, 8)}`;
        duplicateDemotions.push({ ownerId: userId, categoryId: extraId, newName });
        report.duplicatesRepaired++;
        report.duplicateDefaultRepairs.push({
          ownerId: userId,
          keptCategoryId: chosen,
          demotedCategoryId: extraId,
          newName,
        });
        log(`${apply ? 'DEMOTE' : 'would demote'} extra default ${extraId} (owner ${userId}) → "${newName}"`);
      }
    }

    const ptr = profile.defaultCategoryId as string | undefined;
    if (existingChosen) {
      defaultByOwner.set(userId, chosen);
      // Repair the pointer unless it already targets the surviving default (covers a missing,
      // invalid, or now-demoted-extra pointer).
      if (ptr !== chosen) {
        pointerRepairs.push({ userId, defaultCategoryId: chosen });
        report.defaultsRepaired++;
        log(`${apply ? 'REPAIR' : 'would repair'} profile ${userId} default pointer → ${chosen}`);
      }
    } else {
      // No valid default category at all → create one.
      defaultByOwner.set(userId, chosen);
      defaultsToCreate.set(userId, chosen);
      report.defaultsCreated++;
      log(`${apply ? 'CREATE' : 'would create'} default category for profile ${userId} → ${chosen}`);
    }
  }

  // ── 3. Plan task reparenting / status strip + tally final category counts ───────────────
  const counts = new Map<string, number>();
  const taskUpdates: Array<{
    taskId: string;
    sk: string;
    ownerId: string;
    removeStatus: boolean;
    newCategoryId?: string;
  }> = [];
  // Every task seen, plus whether it already has step metadata (for the backfill pass).
  const taskRows: Array<{ taskId: string; sk: string; hasStepMeta: boolean }> = [];
  // Per-owner task placement, for the `order` + owner-counter backfill.
  const ownerTasks = new Map<
    string,
    Array<{ taskId: string; sk: string; createdAt: string; order?: number }>
  >();

  for await (const task of byEntityType(ENTITY.TASK)) {
    report.tasksScanned++;
    const taskId = task.taskId as string | undefined;
    const ownerId = task.ownerId as string | undefined;
    if (!taskId || !ownerId) {
      report.failures.push(`task ${task.PK}/${task.SK} missing taskId/ownerId`);
      continue;
    }
    taskRows.push({
      taskId,
      sk: task.SK,
      hasStepMeta:
        typeof task.stepVersion === 'number' &&
        typeof task.stepCount === 'number' &&
        typeof task.nextStepOrder === 'number',
    });
    (ownerTasks.get(ownerId) ?? ownerTasks.set(ownerId, []).get(ownerId)!).push({
      taskId,
      sk: task.SK,
      createdAt: (task.createdAt as string | undefined) ?? '',
      order: typeof task.order === 'number' ? task.order : undefined,
    });
    const hasStatus = task.status !== undefined;
    const categoryId = (task.categoryId as string | undefined)?.trim();
    const categoryExists = !!categoryId && categoryIndex.has(countKey(ownerId, categoryId));
    const needsReparent = !categoryId || categoryId === LEGACY_NO_CATEGORY || !categoryExists;

    let finalCategoryId: string;
    if (needsReparent) {
      const def = defaultByOwner.get(ownerId);
      if (!def) {
        report.failures.push(`task ${taskId}: owner ${ownerId} has no profile/default category`);
        continue;
      }
      finalCategoryId = def;
      report.tasksReparented++;
    } else {
      finalCategoryId = categoryId!;
    }
    counts.set(countKey(ownerId, finalCategoryId), (counts.get(countKey(ownerId, finalCategoryId)) ?? 0) + 1);
    if (hasStatus) report.statusStripped++;
    if (hasStatus || needsReparent) {
      taskUpdates.push({
        taskId,
        sk: task.SK,
        ownerId,
        removeStatus: hasStatus,
        newCategoryId: needsReparent ? finalCategoryId : undefined,
      });
      log(
        `${apply ? 'UPDATE' : 'would update'} task ${taskId}` +
          `${hasStatus ? ' [strip status]' : ''}${needsReparent ? ' [reparent → default]' : ''}`,
      );
    }
  }

  // ── 4. Plan taskCount backfill for existing categories (created defaults are set on create) ─
  const countUpdates: Array<{ ownerId: string; categoryId: string; desired: number }> = [];
  for (const [key, cat] of categoryIndex) {
    const desired = counts.get(key) ?? 0;
    if (cat.taskCount !== desired) {
      countUpdates.push({ ownerId: cat.ownerId as string, categoryId: cat.categoryId as string, desired });
      report.taskCountsBackfilled++;
      log(
        `${apply ? 'BACKFILL' : 'would backfill'} taskCount for category ${cat.categoryId} ` +
          `(owner ${cat.ownerId}): ${cat.taskCount ?? '∅'} → ${desired}`,
      );
    }
  }

  // ── 5. Plan TaskStep rekeys + tally each task's step count / max order ──────────────────
  const stepRekeys: Array<{ pk: string; oldSk: string; item: Row }> = [];
  const stepTally = new Map<string, { count: number; maxOrder: number }>();
  for await (const step of byEntityType(ENTITY.TASK_STEP)) {
    report.stepsScanned++;
    const stepId = step.stepId as string | undefined;
    if (!stepId) {
      report.failures.push(`step ${step.PK}/${step.SK} has no stepId`);
      continue;
    }
    const taskId = (step.taskId as string | undefined) ?? step.PK.slice('TASK#'.length);
    const order = typeof step.order === 'number' ? step.order : 0;
    const t = stepTally.get(taskId) ?? { count: 0, maxOrder: 0 };
    stepTally.set(taskId, { count: t.count + 1, maxOrder: Math.max(t.maxOrder, order) });

    const desiredSk = stepSk(stepId);
    if (step.SK !== desiredSk) {
      report.stepsRekeyed++;
      stepRekeys.push({ pk: step.PK, oldSk: step.SK, item: { ...step, SK: desiredSk } });
      log(`${apply ? 'REKEY' : 'would rekey'} step ${stepId}: ${step.SK} → ${desiredSk}`);
    }
  }

  // ── 6. Plan step-metadata backfill for tasks that lack it ───────────────────────────────
  const stepMetaBackfills: Array<{
    taskId: string;
    sk: string;
    stepCount: number;
    nextStepOrder: number;
  }> = [];
  for (const t of taskRows) {
    if (t.hasStepMeta) continue;
    const tally = stepTally.get(t.taskId);
    const stepCount = tally?.count ?? 0;
    const nextStepOrder = (tally?.maxOrder ?? 0) + 1;
    stepMetaBackfills.push({ taskId: t.taskId, sk: t.sk, stepCount, nextStepOrder });
    report.stepMetaBackfilled++;
    log(
      `${apply ? 'BACKFILL' : 'would backfill'} step metadata for task ${t.taskId}: ` +
        `stepCount=${stepCount}, nextStepOrder=${nextStepOrder}, stepVersion=1`,
    );
  }

  // ── 7. Plan per-owner task `order` + owner-level task-counter backfill ───────────────────
  const orderBackfills: Array<{ taskId: string; sk: string; order: number }> = [];
  const ownerNextOrder = new Map<string, number>(); // ownerId → nextTaskOrder after backfill
  const ownerTaskCount = new Map<string, number>(); // ownerId → live task count
  for (const [ownerId, tasks] of ownerTasks) {
    ownerTaskCount.set(ownerId, tasks.length);
    // Assign new orders AFTER the highest order any of this owner's tasks already have, so a
    // partial prior run never collides; createdAt (taskId tiebreak) makes it deterministic.
    let maxOrder = 0;
    for (const t of tasks) if (typeof t.order === 'number') maxOrder = Math.max(maxOrder, t.order);
    const lacking = tasks
      .filter((t) => typeof t.order !== 'number')
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.taskId < b.taskId ? -1 : 1,
      );
    let next = maxOrder + 1;
    for (const t of lacking) {
      orderBackfills.push({ taskId: t.taskId, sk: t.sk, order: next });
      report.taskOrdersBackfilled++;
      log(`${apply ? 'BACKFILL' : 'would backfill'} order for task ${t.taskId} (owner ${ownerId}) → ${next}`);
      next++;
    }
    ownerNextOrder.set(ownerId, next); // = maxOrder + lacking.length + 1
  }

  // Profiles missing owner-level counters → set taskCount + nextTaskOrder (an owner with no
  // tasks gets 0 / 1). Idempotent: only profiles without nextTaskOrder are touched.
  const profileCounterBackfills: Array<{ userId: string; taskCount: number; nextTaskOrder: number }> = [];
  for (const p of profileRows) {
    if (p.hasTaskCounter) continue;
    const taskCount = ownerTaskCount.get(p.userId) ?? 0;
    const nextTaskOrder = ownerNextOrder.get(p.userId) ?? 1;
    profileCounterBackfills.push({ userId: p.userId, taskCount, nextTaskOrder });
    report.profileTaskCountersBackfilled++;
    log(
      `${apply ? 'BACKFILL' : 'would backfill'} owner counters for profile ${p.userId}: ` +
        `taskCount=${taskCount}, nextTaskOrder=${nextTaskOrder}`,
    );
  }

  if (apply) {
    await applyDefaultCreates();
    await applyDuplicateDemotions();
    await applyPointerRepairs();
    await applyTaskUpdates();
    await applyCountBackfills();
    await applyStepMetadataBackfills();
    await applyTaskOrderBackfills();
    await applyProfileCounterBackfills();
    await applyStepRekeys();
  }

  printSummary();
  return report;

  // ── apply helpers ───────────────────────────────────────────────────────────────────────
  async function applyDefaultCreates(): Promise<void> {
    const now = new Date().toISOString();
    for (const [ownerId, newId] of defaultsToCreate) {
      const desired = counts.get(countKey(ownerId, newId)) ?? 0;
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table,
                  Item: {
                    PK: userPk(ownerId),
                    SK: categorySk(newId),
                    entityType: ENTITY.CATEGORY,
                    categoryId: newId,
                    ownerId,
                    name: DEFAULT_CATEGORY_NAME,
                    color: DEFAULT_CATEGORY_COLOR,
                    isDefault: true,
                    taskCount: desired,
                    createdAt: now,
                    updatedAt: now,
                  },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Update: {
                  TableName: table,
                  Key: { PK: userPk(ownerId), SK: PROFILE_SK },
                  UpdateExpression: 'SET defaultCategoryId = :id, updatedAt = :now',
                  ConditionExpression: 'attribute_exists(PK)',
                  ExpressionAttributeValues: { ':id': newId, ':now': now },
                },
              },
            ],
          }),
        );
      } catch (err) {
        report.failures.push(`profile ${ownerId}: default-category create failed: ${String(err)}`);
      }
    }
  }

  async function applyDuplicateDemotions(): Promise<void> {
    const now = new Date().toISOString();
    for (const { ownerId, categoryId, newName } of duplicateDemotions) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: userPk(ownerId), SK: categorySk(categoryId) },
            // Flip isDefault + rename only; color/sortOrder/taskCount/Task refs are preserved.
            UpdateExpression: 'SET isDefault = :false, #name = :name, updatedAt = :now',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeNames: { '#name': 'name' },
            ExpressionAttributeValues: { ':false': false, ':name': newName, ':now': now },
          }),
        );
      } catch (err) {
        report.failures.push(`category ${categoryId}: duplicate-default demotion failed: ${String(err)}`);
      }
    }
  }

  async function applyPointerRepairs(): Promise<void> {
    const now = new Date().toISOString();
    for (const { userId, defaultCategoryId } of pointerRepairs) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: userPk(userId), SK: PROFILE_SK },
            UpdateExpression: 'SET defaultCategoryId = :id, updatedAt = :now',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':id': defaultCategoryId, ':now': now },
          }),
        );
      } catch (err) {
        report.failures.push(`profile ${userId}: default-pointer repair failed: ${String(err)}`);
      }
    }
  }

  async function applyTaskUpdates(): Promise<void> {
    for (const upd of taskUpdates) {
      const setParts: string[] = ['updatedAt = :now'];
      const removeParts: string[] = [];
      const values: Record<string, unknown> = { ':now': new Date().toISOString() };
      if (upd.removeStatus) removeParts.push('#status');
      if (upd.newCategoryId) {
        setParts.push('categoryId = :cat', 'taskCategoryKey = :key');
        values[':cat'] = upd.newCategoryId;
        values[':key'] = taskCategoryKey(upd.ownerId, upd.newCategoryId);
      }
      let expr = `SET ${setParts.join(', ')}`;
      if (removeParts.length) expr += ` REMOVE ${removeParts.join(', ')}`;
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: taskPk(upd.taskId), SK: upd.sk },
            UpdateExpression: expr,
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeNames: upd.removeStatus ? { '#status': 'status' } : undefined,
            ExpressionAttributeValues: values,
          }),
        );
      } catch (err) {
        report.failures.push(`task ${upd.taskId}: update failed: ${String(err)}`);
      }
    }
  }

  async function applyCountBackfills(): Promise<void> {
    for (const { ownerId, categoryId, desired } of countUpdates) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: userPk(ownerId), SK: categorySk(categoryId) },
            UpdateExpression: 'SET taskCount = :c, updatedAt = :now',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':c': desired, ':now': new Date().toISOString() },
          }),
        );
      } catch (err) {
        report.failures.push(`category ${categoryId}: taskCount backfill failed: ${String(err)}`);
      }
    }
  }

  async function applyStepMetadataBackfills(): Promise<void> {
    const now = new Date().toISOString();
    for (const { taskId, sk, stepCount, nextStepOrder } of stepMetaBackfills) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: taskPk(taskId), SK: sk },
            UpdateExpression:
              'SET stepCount = :c, nextStepOrder = :o, stepVersion = :v, updatedAt = :now',
            // Idempotent: only set when still absent (a concurrent run / re-run is a no-op).
            ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(stepVersion)',
            ExpressionAttributeValues: { ':c': stepCount, ':o': nextStepOrder, ':v': 1, ':now': now },
          }),
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') continue; // already set
        report.failures.push(`task ${taskId}: step-metadata backfill failed: ${String(err)}`);
      }
    }
  }

  async function applyTaskOrderBackfills(): Promise<void> {
    const now = new Date().toISOString();
    for (const { taskId, sk, order } of orderBackfills) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: taskPk(taskId), SK: sk },
            UpdateExpression: 'SET #order = :order, updatedAt = :now',
            // Idempotent: only set when still absent (a concurrent run / re-run is a no-op).
            ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#order)',
            ExpressionAttributeNames: { '#order': 'order' },
            ExpressionAttributeValues: { ':order': order, ':now': now },
          }),
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') continue; // already set
        report.failures.push(`task ${taskId}: order backfill failed: ${String(err)}`);
      }
    }
  }

  async function applyProfileCounterBackfills(): Promise<void> {
    const now = new Date().toISOString();
    for (const { userId, taskCount, nextTaskOrder } of profileCounterBackfills) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { PK: userPk(userId), SK: PROFILE_SK },
            UpdateExpression: 'SET taskCount = :c, nextTaskOrder = :n, updatedAt = :now',
            // Idempotent: only set when still absent (a concurrent run / re-run is a no-op).
            ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(nextTaskOrder)',
            ExpressionAttributeValues: { ':c': taskCount, ':n': nextTaskOrder, ':now': now },
          }),
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') continue; // already set
        report.failures.push(`profile ${userId}: owner-counter backfill failed: ${String(err)}`);
      }
    }
  }

  async function applyStepRekeys(): Promise<void> {
    for (const { pk, oldSk, item } of stepRekeys) {
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: table, Item: item } },
              { Delete: { TableName: table, Key: { PK: pk, SK: oldSk } } },
            ],
          }),
        );
      } catch (err) {
        report.failures.push(`step ${item.stepId as string}: rekey failed: ${String(err)}`);
      }
    }
  }

  function printSummary(): void {
    log('\n── Summary ──────────────────────────────────────────────');
    log(`Profiles scanned:        ${report.profilesScanned}`);
    log(`Categories scanned:      ${report.categoriesScanned}`);
    log(`Default categories:      ${report.defaultsCreated} ${apply ? 'created' : 'to create'}`);
    log(`Default pointers repaired:${report.defaultsRepaired} ${apply ? 'repaired' : 'to repair'}`);
    log(`Profiles w/ duplicates:  ${report.duplicateDefaults}`);
    log(`Extra defaults demoted:  ${report.duplicatesRepaired} ${apply ? 'demoted' : 'to demote'}`);
    log(`Tasks scanned:           ${report.tasksScanned}`);
    log(`Tasks reparented:        ${report.tasksReparented} ${apply ? 'moved' : 'to move'}`);
    log(`Legacy status stripped:  ${report.statusStripped} ${apply ? 'stripped' : 'to strip'}`);
    log(`taskCount backfilled:    ${report.taskCountsBackfilled} ${apply ? 'updated' : 'to update'}`);
    log(`Step metadata backfilled:${report.stepMetaBackfilled} ${apply ? 'set' : 'to set'}`);
    log(`Task orders backfilled:  ${report.taskOrdersBackfilled} ${apply ? 'set' : 'to set'}`);
    log(`Profile counters set:    ${report.profileTaskCountersBackfilled} ${apply ? 'set' : 'to set'}`);
    log(`Steps scanned:           ${report.stepsScanned}`);
    log(`Steps rekeyed:           ${report.stepsRekeyed} ${apply ? 'rekeyed' : 'to rekey'}`);
    log(`Failures:                ${report.failures.length}`);
    for (const f of report.failures) log(`  - ${f}`);
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────────────────
/* istanbul ignore next -- CLI wiring; the migration logic is unit-tested via runMigration */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const table = process.env.DYNAMODB_TABLE_NAME ?? 'CanPlanTasks-dev';
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  console.log(`Migration target table: ${table}`);
  console.log(apply ? 'MODE: APPLY (writing changes)' : 'MODE: DRY-RUN (no writes; pass --apply to write)');
  console.log('');
  const report = await runMigration({ client, table, apply });
  if (report.failures.length) process.exitCode = 1;
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
