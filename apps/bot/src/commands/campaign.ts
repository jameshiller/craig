import { ChannelType, CommandContext, CommandOptionType, SlashCreator } from 'slash-create';

import GeneralCommand from '../slashCommand.js';
import { CampaignRecord, scribe, ScribeApiError } from '../modules/scribeClient.js';

/**
 * /campaign - link a voice channel, a text channel and a campaign together.
 *
 * This is a local patch on top of Craig: the registry itself lives in scribe
 * (NFS JSON + audit log), so Craig only needs to be able to talk to scribe's
 * internal API. Linking a campaign also arms Craig's auto-record on that voice
 * channel, so joining it starts a recording and the pipeline picks it up.
 */

const EMBED_COLOR = 0x8a5cf6;

function fmtChannels(camp: CampaignRecord): string {
  const voice = camp.voice_channel_id ? `<#${camp.voice_channel_id}>` : '*not linked*';
  const text = camp.text_channel_id ? `<#${camp.text_channel_id}>` : '*not linked*';
  return `**voice** ${voice}\n**text** ${text}`;
}

function campaignEmbed(camp: CampaignRecord) {
  const players = Object.entries(camp.players)
    .map(([id, p]) => {
      const who = p.role === 'gm' ? '**GM**' : p.character ? `as **${p.character}**` : '*no character yet*';
      const notes = p.notes ? ` - ${p.notes}` : '';
      return `<@${id}> (${p.player}) - ${who}${notes}`;
    })
    .join('\n');

  const bible = camp.bible?.session_count
    ? `**${camp.bible.session_count}** session(s), last \`${camp.bible.last_session}\`\n${camp.bible.brief}`
    : 'No sessions recorded yet.';

  return {
    title: `${camp.name} (${camp.slug})`,
    color: EMBED_COLOR,
    fields: [
      { name: 'System', value: camp.system || '*unspecified*', inline: true },
      { name: 'Setting', value: camp.setting || '*unspecified*', inline: true },
      { name: 'Channels', value: fmtChannels(camp), inline: false },
      { name: 'Players', value: players || '*none declared*', inline: false },
      { name: 'Glossary', value: camp.glossary.length ? camp.glossary.join(', ') : '*empty*', inline: false },
      { name: 'Bible', value: bible, inline: false }
    ],
    footer: { text: 'scribe' }
  };
}

function errorResponse(err: unknown) {
  if (err instanceof ScribeApiError) {
    const hint =
      err.status === 503
        ? '\nscribe API is down - check `docker compose ps` on the scribe host.'
        : '';
    return { content: `:warning: ${err.message}${hint}`, ephemeral: true };
  }
  throw err;
}

export default class Campaign extends GeneralCommand {
  constructor(creator: SlashCreator) {
    super(creator, {
      name: 'campaign',
      description: 'Link a Discord voice/text channel pair to a scribe campaign.',
      deferEphemeral: true,
      dmPermission: false,
      options: [
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'create',
          description: 'Create a campaign.',
          options: [
            { type: CommandOptionType.STRING, name: 'name', description: 'Campaign name', required: true, max_length: 100 },
            { type: CommandOptionType.STRING, name: 'system', description: 'e.g. Pathfinder 2e', max_length: 60 },
            { type: CommandOptionType.STRING, name: 'setting', description: 'e.g. Golarion', max_length: 60 },
            { type: CommandOptionType.STRING, name: 'context', description: 'One-line background for the summarizer', max_length: 500 }
          ]
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'link',
          description: 'Bind a voice channel and a text channel to a campaign.',
          options: [
            { type: CommandOptionType.STRING, name: 'campaign', description: 'Campaign slug (default: this channel\'s campaign)' },
            {
              type: CommandOptionType.CHANNEL,
              name: 'voice',
              description: 'Voice channel where sessions happen',
              channel_types: [ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE]
            },
            {
              type: CommandOptionType.CHANNEL,
              name: 'text',
              description: 'Text channel where recaps are posted',
              channel_types: [ChannelType.GUILD_TEXT]
            },
            {
              type: CommandOptionType.BOOLEAN,
              name: 'autorecord',
              description: 'Start recording the moment someone joins voice (default: false - manual /join)'
            }
          ]
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'unlink',
          description: 'Detach the channels from a campaign (data is kept).',
          options: [
            { type: CommandOptionType.STRING, name: 'campaign', description: 'Campaign slug (default: this channel\'s campaign)' }
          ]
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'show',
          description: 'Show a campaign overview.',
          options: [{ type: CommandOptionType.STRING, name: 'campaign', description: 'Campaign slug (default: this channel\'s campaign)' }]
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'list',
          description: 'List campaigns.'
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'rename',
          description: 'Rename a campaign (the slug, and therefore the wiki path, is kept).',
          options: [
            { type: CommandOptionType.STRING, name: 'campaign', description: 'Campaign slug', required: true },
            { type: CommandOptionType.STRING, name: 'name', description: 'New name', required: true, max_length: 100 }
          ]
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'delete',
          description: 'Archive a campaign (moved to _trash, never deleted).',
          options: [
            { type: CommandOptionType.STRING, name: 'campaign', description: 'Campaign slug', required: true },
            { type: CommandOptionType.BOOLEAN, name: 'confirm', description: 'Must be true', required: true }
          ]
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'glossary',
          description: 'Teach the summarizer a name it keeps getting wrong.',
          options: [
            { type: CommandOptionType.STRING, name: 'term', description: 'Correct spelling', required: true, max_length: 100 },
            { type: CommandOptionType.STRING, name: 'campaign', description: 'Campaign slug (default: this channel\'s campaign)' },
            { type: CommandOptionType.BOOLEAN, name: 'remove', description: 'Remove the term instead of adding it' }
          ]
        }
      ]
    });
  }

  /** Campaign whose voice or text channel is where this command was used. */
  async currentCampaign(ctx: CommandContext): Promise<CampaignRecord | null> {
    const { campaigns, default: fallback } = await scribe.listCampaigns();
    const here = campaigns.find((c) => c.voice_channel_id === ctx.channelID || c.text_channel_id === ctx.channelID);
    const slug = here?.slug ?? fallback;
    if (!slug) return null;
    return scribe.getCampaign(slug);
  }

  async resolve(ctx: CommandContext, slug?: string): Promise<CampaignRecord | null> {
    if (slug) return scribe.getCampaign(slug.trim().toLowerCase());
    return this.currentCampaign(ctx);
  }

  async run(ctx: CommandContext) {
    if (!ctx.guildID) return { content: 'This command only works in a server.', ephemeral: true };

    const isAdmin = !!ctx.member?.permissions.has('MANAGE_GUILD');
    const actor = ctx.user.id;
    const sub = ctx.subcommands[0];

    try {
      switch (sub) {
        case 'create': {
          if (!isAdmin) return { content: 'Only server managers can create campaigns.', ephemeral: true };
          const camp = await scribe.createCampaign({
            name: ctx.options.create.name as string,
            system: (ctx.options.create.system as string) ?? '',
            setting: (ctx.options.create.setting as string) ?? '',
            context: (ctx.options.create.context as string) ?? '',
            actor
          });
          return {
            content: `Created **${camp.name}**. Next: \`/campaign link\` in the voice channel, then \`/character set\` for each player.`,
            embeds: [campaignEmbed(camp)],
            ephemeral: true
          };
        }

        case 'link': {
          const camp = await this.resolve(ctx, ctx.options.link.campaign as string | undefined);
          if (!camp) return { content: 'No campaign to link. Create one first with `/campaign create`.', ephemeral: true };
          if (!isAdmin && !(camp.gm_ids ?? []).includes(actor))
            return { content: `Only a GM of **${camp.name}** or a server manager can link it.`, ephemeral: true };

          const voice = ctx.options.link.voice as string | undefined;
          const text = ctx.options.link.text as string | undefined;
          if (!voice && !text) return { content: 'Give me a `voice` channel, a `text` channel, or both.', ephemeral: true };

          const linked = await scribe.link(camp.slug, { voice, text, actor });

          // Recording is manual by default: tables usually want a pre-session warm-up
          // that should never reach the transcript. `autorecord: true` opts back in.
          const armAuto = (ctx.options.link.autorecord as boolean | undefined) ?? false;
          let autoNote = '';
          if (linked.voice) {
            const row = await this.db
              .selectFrom('AutoRecord')
              .selectAll()
              .where('guildId', '=', ctx.guildID!)
              .where('clientId', '=', this.client.bot.user.id)
              .where('channelId', '=', linked.voice)
              .executeTakeFirst();
            if (armAuto) {
              await this.autoRecord.upsert({
                guildId: ctx.guildID,
                channelId: linked.voice,
                userId: actor,
                postChannelId: null,
                minimum: 1,
                triggerUsers: [],
                triggerRoles: []
              });
              autoNote = `\nAuto-record is armed on <#${linked.voice}> - joining it starts a recording.`;
            } else {
              // Actively disarm, so a row left by Craig's own /autorecord cannot
              // start capturing the warm-up.
              if (row) await this.autoRecord.delete(row);
              autoNote = `\nRecording is manual - run \`/join\` in <#${linked.text ?? linked.voice}> when you want capture to start.`;
            }
          }

          return {
            content: `Linked **${camp.name}**.\n**voice** ${linked.voice ? `<#${linked.voice}>` : '*none*'}\n**text** ${
              linked.text ? `<#${linked.text}>` : '*none*'
            }${autoNote}`,
            ephemeral: true
          };
        }

        case 'unlink': {
          const camp = await this.resolve(ctx, ctx.options.unlink.campaign as string | undefined);
          if (!camp) return { content: 'No campaign found for this channel.', ephemeral: true };
          if (!isAdmin && !(camp.gm_ids ?? []).includes(actor))
            return { content: `Only a GM of **${camp.name}** or a server manager can unlink it.`, ephemeral: true };

          const previousVoice = camp.voice_channel_id;
          await scribe.link(camp.slug, { voice: '', text: '', actor });
          if (previousVoice) {
            const row = await this.db
              .selectFrom('AutoRecord')
              .selectAll()
              .where('guildId', '=', ctx.guildID!)
              .where('clientId', '=', this.client.bot.user.id)
              .where('channelId', '=', previousVoice)
              .executeTakeFirst();
            if (row) await this.autoRecord.delete(row);
          }
          return { content: `Unlinked **${camp.name}**. Recordings and wiki are untouched.`, ephemeral: true };
        }

        case 'show': {
          const camp = await this.resolve(ctx, ctx.options.show.campaign as string | undefined);
          if (!camp) return { content: 'No campaign found for this channel.', ephemeral: true };
          return { embeds: [campaignEmbed(camp)], ephemeral: true };
        }

        case 'list': {
          const { campaigns, default: fallback } = await scribe.listCampaigns();
          if (!campaigns.length) return { content: 'No campaigns yet. Start with `/campaign create`.', ephemeral: true };
          const lines = campaigns.map((c) => {
            const mark = c.slug === fallback ? ' (default)' : '';
            const voice = c.voice_channel_id ? `<#${c.voice_channel_id}>` : '*no voice*';
            const text = c.text_channel_id ? `<#${c.text_channel_id}>` : '*no text*';
            return `**${c.name}** \`${c.slug}\`${mark} - ${voice} -> ${text} - ${c.player_count} player(s), ${c.sessions} session(s)`;
          });
          return { embeds: [{ title: 'Campaigns', description: lines.join('\n'), color: EMBED_COLOR }], ephemeral: true };
        }

        case 'rename': {
          const slug = (ctx.options.rename.campaign as string).trim().toLowerCase();
          const existing = await scribe.getCampaign(slug);
          if (!isAdmin && !(existing.gm_ids ?? []).includes(actor))
            return { content: `Only a GM of **${existing.name}** or a server manager can rename it.`, ephemeral: true };
          const camp = await scribe.renameCampaign(slug, { name: ctx.options.rename.name as string, actor });
          return { content: `Renamed to **${camp.name}** (slug \`${camp.slug}\` unchanged).`, ephemeral: true };
        }

        case 'delete': {
          const slug = (ctx.options.delete.campaign as string).trim().toLowerCase();
          const existing = await scribe.getCampaign(slug);
          if (!isAdmin && !(existing.gm_ids ?? []).includes(actor))
            return { content: `Only a GM of **${existing.name}** or a server manager can archive it.`, ephemeral: true };
          if (!(ctx.options.delete.confirm as boolean))
            return { content: 'Set `confirm: true` to archive this campaign.', ephemeral: true };
          const res = await scribe.deleteCampaign(slug, actor);
          return {
            content: `Archived **${existing.name}**${res.trash ? ` to \`${res.trash}\`` : ''}. Nothing was deleted permanently.`,
            ephemeral: true
          };
        }

        case 'glossary': {
          const camp = await this.resolve(ctx, ctx.options.glossary.campaign as string | undefined);
          if (!camp) return { content: 'No campaign found for this channel.', ephemeral: true };
          if (!isAdmin && !(camp.gm_ids ?? []).includes(actor))
            return { content: `Only a GM of **${camp.name}** or a server manager can edit its glossary.`, ephemeral: true };
          const term = (ctx.options.glossary.term as string).trim();
          const remove = (ctx.options.glossary.remove as boolean | undefined) ?? false;
          const res = remove
            ? await scribe.removeGlossary(camp.slug, term, actor)
            : await scribe.addGlossary(camp.slug, term, actor);
          return {
            content: `${remove ? 'Removed' : 'Added'} \`${term}\` for **${camp.name}**. Glossary: ${
              res.glossary.join(', ') || '*empty*'
            }`,
            ephemeral: true
          };
        }

        default:
          return { content: 'Unknown subcommand.', ephemeral: true };
      }
    } catch (err) {
      return errorResponse(err);
    }
  }
}
