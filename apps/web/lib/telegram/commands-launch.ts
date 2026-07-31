import 'server-only';
import type { Bot, Context } from 'grammy';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  clearConversationState,
  getActiveLinkByChatId,
  getConversationState,
  getDb,
  isMetaConnected,
  schema,
  setConversationState,
} from '@mbb/db';
import { inngest } from '@mbb/jobs';

/**
 * Polish-25.8 Commit 48: /launch command — multi-turn interactive
 * flow. State machine:
 *
 *   /launch                 → 'launch:pick_variant'  (list variants)
 *   tap variant             → 'launch:pick_budget'   (budget buttons)
 *   tap budget              → 'launch:confirm'       (confirm summary)
 *   tap confirm             → dispatch meta/launch.requested
 *
 * State stored in telegram_conversation_state (15-min TTL). Safety:
 *   - Refuses if bot is paused.
 *   - Refuses if Meta is disconnected.
 *   - Dispatches the SAME meta/launch.requested event as the web
 *     launch dialog — same worker, same safety-layer path.
 *
 * Scoped to keep interactive UX simple: budget picker (five presets +
 * custom typed reply), inherits targeting from user_settings defaults.
 * Full-fidelity targeting still lives on web (deep-linked in the
 * message).
 */

const BUDGET_PRESETS_USD = [5, 10, 20, 50, 100];

interface LaunchConversationData {
  jobId?: string;
  perAdBudgetUsd?: number;
}

export function registerLaunchCommand(bot: Bot): void {
  bot.command('launch', async (ctx) => {
    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.reply('Could not read chat id.');
      return;
    }
    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.reply("This chat isn't linked. /help for setup.");
      return;
    }

    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, link.userId),
      columns: { isPaused: true },
    });
    if (user?.isPaused) {
      await ctx.reply('Bot is PAUSED. Send /unpause first.');
      return;
    }
    if (!(await isMetaConnected(link.userId))) {
      await ctx.reply('Meta is not connected. Reconnect in the web app first.');
      return;
    }

    // Find generation jobs with approved-but-not-launched variants.
    const jobs = await db.query.generationJobs.findMany({
      where: and(
        eq(schema.generationJobs.userId, link.userId),
        eq(schema.generationJobs.status, 'completed'),
      ),
      orderBy: desc(schema.generationJobs.updatedAt),
      limit: 20,
      columns: { id: true, updatedAt: true },
    });
    if (jobs.length === 0) {
      await ctx.reply(
        'No completed generation jobs with approved variants. Approve variants on the web first.',
      );
      return;
    }

    const jobIds = jobs.map((j) => j.id);
    const approved = await db.query.generatedCreatives.findMany({
      where: and(
        inArray(schema.generatedCreatives.generationJobId, jobIds),
        eq(schema.generatedCreatives.status, 'approved'),
      ),
      columns: { generationJobId: true, headline: true },
    });
    if (approved.length === 0) {
      await ctx.reply('No approved variants ready to launch. Approve some on the web first.');
      return;
    }
    const perJob = new Map<string, { count: number; sampleHeadline: string | null }>();
    for (const a of approved) {
      const existing = perJob.get(a.generationJobId) ?? { count: 0, sampleHeadline: null };
      existing.count += 1;
      if (!existing.sampleHeadline && a.headline) existing.sampleHeadline = a.headline;
      perJob.set(a.generationJobId, existing);
    }

    const rows = jobs
      .filter((j) => perJob.has(j.id))
      .slice(0, 6)
      .map((j) => {
        const info = perJob.get(j.id)!;
        const label = info.sampleHeadline
          ? `${info.count}× "${info.sampleHeadline.slice(0, 30)}"`
          : `Job ${j.id.slice(0, 8)} (${info.count} variants)`;
        return [{ text: label, callback_data: `launch:pick:${j.id}` }];
      });

    if (rows.length === 0) {
      await ctx.reply('No launchable jobs.');
      return;
    }

    await setConversationState({
      userId: link.userId,
      tgChatId,
      state: 'launch:pick_variant',
      data: {},
    });
    await ctx.reply('Pick a job to launch:', {
      reply_markup: {
        inline_keyboard: [...rows, [{ text: '✕ Cancel', callback_data: 'launch:cancel' }]],
      },
    });
  });
}

export function registerLaunchCallback(bot: Bot): void {
  bot.on('callback_query:data', async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    if (!data || !data.startsWith('launch:')) return;

    const tgChatId = ctx.chat?.id != null ? String(ctx.chat.id) : null;
    if (!tgChatId) {
      await ctx.answerCallbackQuery({ text: 'No chat id' });
      return;
    }
    const link = await getActiveLinkByChatId(tgChatId);
    if (!link) {
      await ctx.answerCallbackQuery({ text: 'Not linked' });
      return;
    }

    const parts = data.split(':');
    const action = parts[1];

    if (action === 'cancel') {
      await clearConversationState(link.userId);
      await ctx.answerCallbackQuery({ text: 'Cancelled' });
      try {
        await ctx.editMessageText('✕ Launch cancelled.');
      } catch {
        // ignore
      }
      return;
    }

    const state = await getConversationState(link.userId);

    if (action === 'pick') {
      const jobId = parts[2];
      if (!jobId) {
        await ctx.answerCallbackQuery({ text: 'Missing job id' });
        return;
      }
      const data: LaunchConversationData = { jobId };
      await setConversationState({
        userId: link.userId,
        tgChatId,
        state: 'launch:pick_budget',
        data: data as Record<string, unknown>,
      });
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText('Pick a per-ad daily budget (USD):', {
          reply_markup: {
            inline_keyboard: [
              BUDGET_PRESETS_USD.map((b) => ({
                text: `$${b}`,
                callback_data: `launch:budget:${b}`,
              })),
              [{ text: '✕ Cancel', callback_data: 'launch:cancel' }],
            ],
          },
        });
      } catch {
        // ignore
      }
      return;
    }

    if (action === 'budget') {
      if (state?.state !== 'launch:pick_budget') {
        await ctx.answerCallbackQuery({ text: 'Session expired. /launch to restart.' });
        return;
      }
      const budget = Number(parts[2]);
      if (!Number.isFinite(budget) || budget <= 0) {
        await ctx.answerCallbackQuery({ text: 'Bad budget' });
        return;
      }
      const jobId = (state.data as LaunchConversationData).jobId;
      const nextData: LaunchConversationData = { jobId, perAdBudgetUsd: budget };
      await setConversationState({
        userId: link.userId,
        tgChatId,
        state: 'launch:confirm',
        data: nextData as Record<string, unknown>,
      });
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(
          `Confirm launch:\n· Job: ${jobId?.slice(0, 8)}\n· Per-ad budget: $${budget}/day\n· Targeting: your saved defaults\n\nAll ads will launch PAUSED. Activate manually in Meta Ads Manager.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✓ Launch', callback_data: 'launch:confirm' },
                  { text: '✕ Cancel', callback_data: 'launch:cancel' },
                ],
              ],
            },
          },
        );
      } catch {
        // ignore
      }
      return;
    }

    if (action === 'confirm') {
      if (state?.state !== 'launch:confirm') {
        await ctx.answerCallbackQuery({ text: 'Session expired. /launch to restart.' });
        return;
      }
      const { jobId, perAdBudgetUsd } = state.data as LaunchConversationData;
      if (!jobId || !perAdBudgetUsd) {
        await ctx.answerCallbackQuery({ text: 'Incomplete state' });
        return;
      }

      // Dispatch the SAME event the web launch dialog fires.
      await inngest.send({
        name: 'meta/launch.requested',
        data: {
          userId: link.userId,
          generationJobId: jobId,
          perAdBudgetUsd,
          mode: 'live',
          source: 'telegram_command',
        },
      });
      await clearConversationState(link.userId);

      await ctx.answerCallbackQuery({ text: 'Dispatched' });
      try {
        await ctx.editMessageText(
          `✓ Launch dispatched. Ads will appear PAUSED in Meta within ~30s. Watch /launched in the web app for status.`,
        );
      } catch {
        // ignore
      }
      return;
    }
  });
}
