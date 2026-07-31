#!/usr/bin/env tsx
/**
 * One-off migration: copies active/paused v1 cron tasks from
 * store/messages.db (scheduled_tasks) into the v2 session's inbound.db as
 * kind='task' messages_in rows. `once` tasks with a past run-at are skipped.
 *
 * Dry-run by default. Pass --apply to write.
 */
import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import path from 'path';

const V1_DB = 'store/messages.db';
const V2_DB = 'data/v2.db';
const TZ = 'Africa/Johannesburg'; // v1 tasks were authored in SAST

const APPLY = process.argv.includes('--apply');

// v1 group_folder -> v2 (channel_type, platform_id) mapping.
// Extend this if you have other v1 groups worth migrating.
const GROUP_MAP: Record<string, { channelType: string; platformId: string }> = {
  telegram_main: { channelType: 'telegram', platformId: 'telegram:1524040717' },
};

interface V1Task {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'once';
  schedule_value: string;
  status: string;
  script: string | null;
}

function nextEvenSeq(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(seq) AS max_seq FROM messages_in').get() as {
    max_seq: number | null;
  };
  const current = row.max_seq ?? 0;
  const next = current + 1;
  return next % 2 === 0 ? next : next + 1;
}

function main() {
  const v1 = new Database(V1_DB, { readonly: true });
  const v2 = new Database(V2_DB, { readonly: true });

  // Find the single DM session
  const session = v2
    .prepare(
      `SELECT s.id AS session_id, s.agent_group_id, mg.channel_type, mg.platform_id
         FROM sessions s
         JOIN messaging_groups mg ON mg.id = s.messaging_group_id`,
    )
    .get() as { session_id: string; agent_group_id: string; channel_type: string; platform_id: string } | undefined;

  if (!session) throw new Error('No v2 session found');
  console.log(`Target session: ${session.session_id} (agent_group=${session.agent_group_id})`);
  console.log(`Target destination: ${session.channel_type} / ${session.platform_id}`);

  const inboundDbPath = path.resolve(
    'data/v2-sessions',
    session.agent_group_id,
    session.session_id,
    'inbound.db',
  );
  console.log(`Inbound DB: ${inboundDbPath}`);

  const tasks = v1
    .prepare(
      `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, script
         FROM scheduled_tasks
         WHERE status IN ('active','paused')`,
    )
    .all() as V1Task[];

  const now = new Date();
  const toMigrate: Array<{
    task: V1Task;
    processAfter: string;
    recurrence: string | null;
    targetStatus: 'pending' | 'paused';
  }> = [];

  for (const t of tasks) {
    const mapped = GROUP_MAP[t.group_folder];
    if (!mapped) {
      console.log(`  SKIP ${t.id}: group ${t.group_folder} not in GROUP_MAP`);
      continue;
    }

    if (t.schedule_type === 'cron') {
      try {
        const next = CronExpressionParser.parse(t.schedule_value, { tz: TZ, currentDate: now })
          .next()
          .toDate()
          .toISOString();
        toMigrate.push({
          task: t,
          processAfter: next,
          recurrence: t.schedule_value,
          targetStatus: t.status === 'paused' ? 'paused' : 'pending',
        });
      } catch (err) {
        console.log(`  SKIP ${t.id}: cron parse error — ${(err as Error).message}`);
      }
    } else {
      const when = new Date(t.schedule_value);
      if (when.getTime() <= now.getTime()) {
        console.log(`  SKIP ${t.id}: one-off in the past (${t.schedule_value})`);
        continue;
      }
      toMigrate.push({
        task: t,
        processAfter: when.toISOString(),
        recurrence: null,
        targetStatus: t.status === 'paused' ? 'paused' : 'pending',
      });
    }
  }

  console.log(`\nWould migrate ${toMigrate.length} / ${tasks.length} task(s):\n`);
  for (const m of toMigrate) {
    const head = m.task.prompt.replace(/\s+/g, ' ').slice(0, 70);
    console.log(
      `  ${m.task.id} [${m.targetStatus}] next=${m.processAfter} recur=${m.recurrence ?? '-'}`,
    );
    console.log(`    ${head}${m.task.prompt.length > 70 ? '…' : ''}`);
  }

  v1.close();
  v2.close();

  if (!APPLY) {
    console.log(`\n(dry run — re-run with --apply to write)`);
    return;
  }

  const inDb = new Database(inboundDbPath);
  const insert = inDb.prepare(
    `INSERT INTO messages_in
        (id, seq, timestamp, status, tries, process_after, recurrence,
         kind, platform_id, channel_type, thread_id, content, series_id)
      VALUES
        (@id, @seq, datetime('now'), @status, 0, @processAfter, @recurrence,
         'task', @platformId, @channelType, NULL, @content, @id)`,
  );

  const tx = inDb.transaction(() => {
    for (const m of toMigrate) {
      const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      insert.run({
        id: newId,
        seq: nextEvenSeq(inDb),
        status: m.targetStatus,
        processAfter: m.processAfter,
        recurrence: m.recurrence,
        platformId: session.platform_id,
        channelType: session.channel_type,
        content: JSON.stringify({ prompt: m.task.prompt, script: m.task.script ?? null }),
      });
      console.log(`  + ${newId} (from ${m.task.id})`);
    }
  });
  tx();
  inDb.close();
  console.log(`\nDone. ${toMigrate.length} task(s) written to inbound.db`);
}

main();
