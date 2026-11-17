import { CommandContext, CommandOptionType, SlashCreator } from 'slash-create';

import GeneralCommand from '../slashCommand.js';
import { CampaignRecord, scribe, ScribeApiError } from '../modules/scribeClient.js';

/**
 * /character - declare which Discord player is which character.
 *
 * Players may claim their own character; GMs and server managers can set anyone's.
 * The summarizer reads this mapping, so recaps say "Wren" instead of "the player".
 */

function errorResponse(err: unknown) {
  if (err instanceof ScribeApiError) return { content: `:warning: ${err.message}`, ephemeral: true };
  throw err;
}

export default class Character extends GeneralCommand {
  constructor(creator: SlashCreator) {
    super(creator, {
      name: 'character',
      description: 'Declare which character each player is playing.',
      deferEphemeral: true,
      dmPermission: false,
      options: [
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'set',
          description: 'Set a player\'s character.',
          options: [
            { type: CommandOptionType.USER, name: 'user', description: 'The player', required: true },
            {
              type: CommandOptionType.STRING,
              name: 'character',
              description: 'Character name (not needed when gm:true)',
              max_length: 100
            },
            { type: CommandOptionType.STRING, name: 'campaign', description: 'Campaign slug (default: this channel\'s campaign)' },
            { type: CommandOptionType.STRING, name: 'class', description: 'Class / role, e.g. "alchemist"', max_length: 60 },
            { type: CommandOptionType.STRING, name: 'notes', description: 'Anything else worth remembering', max_length: 200 },
            { type: CommandOptionType.BOOLEAN, name: 'gm', description: 'Mark this user as a GM (no character needed)' }
          ]
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'remove',
          description: 'Remove a player from the campaign.',
          options: [
            { type: CommandOptionType.USER, name: 'user', description: 'The player', required: true },
            { type: CommandOptionType.STRING, name: 'campaign', description: 'Campaign slug (default: this channel\'s campaign)' }
          ]
        },
        {
          type: CommandOptionType.SUB_COMMAND,
          name: 'list',
          description: 'List players and characters.',
          options: [{ type: CommandOptionType.STRING, name: 'campaign', description: 'Campaign slug (default: this channel\'s campaign)' }]
        }
      ]
    });
  }

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

  private roster(camp: CampaignRecord): string {
    const rows = Object.entries(camp.players).map(([id, p]) => {
      const who = p.role === 'gm' ? '**GM**' : p.character ? `as **${p.character}**` : '*no character yet*';
      const klass = p.notes ? ` - ${p.notes}` : '';
      return `<@${id}> (${p.player}) - ${who}${klass}`;
    });
    return rows.join('\n') || '*nobody declared yet*';
  }

  async run(ctx: CommandContext) {
    if (!ctx.guildID) return { content: 'This command only works in a server.', ephemeral: true };
    const isAdmin = !!ctx.member?.permissions.has('MANAGE_GUILD');
    const actor = ctx.user.id;

    try {
      switch (ctx.subcommands[0]) {
        case 'set': {
          const camp = await this.resolve(ctx, ctx.options.set.campaign as string | undefined);
          if (!camp) return { content: 'No campaign found. Create one with `/campaign create` first.', ephemeral: true };

          const target = ctx.options.set.user as string;
          const isSelf = target === actor;
          const can = isAdmin || (camp.gm_ids ?? []).includes(actor) || isSelf;
          if (!can)
            return {
              content: `You can only set your own character in **${camp.name}** - ask a GM for anyone else.`,
              ephemeral: true
            };

          const role = (ctx.options.set.gm as boolean | undefined) ? 'gm' : 'player';
          if (role === 'gm' && !isAdmin && !(camp.gm_ids ?? []).includes(actor))
            return { content: 'Only a server manager or an existing GM can promote a GM.', ephemeral: true };

          // A GM is a row without a character, so only a player needs one.
          const character = ((ctx.options.set.character as string | undefined) ?? '').trim();
          if (role === 'player' && !character)
            return {
              content: 'Give me a `character`, or set `gm: true` to mark this user as a GM.',
              ephemeral: true
            };

          const displayName =
            ctx.users.find((u) => u.id === target)?.username ?? this.client.bot.users.get(target)?.username ?? 'player';

          const saved = await scribe.setPlayer(camp.slug, target, {
            player: displayName,
            character: role === 'gm' ? null : character,
            role,
            // `class` is the short label, `notes` the free text; the registry has one field
            notes: [(ctx.options.set.class as string | undefined) ?? '', (ctx.options.set.notes as string | undefined) ?? '']
              .map((s) => s.trim())
              .filter(Boolean)
              .join(' - '),
            actor
          });

          return {
            content:
              role === 'gm'
                ? `<@${target}> is now a **GM** of **${camp.name}**.`
                : `<@${target}> plays **${saved.character}** in **${camp.name}**.`,
            ephemeral: true
          };
        }

        case 'remove': {
          const camp = await this.resolve(ctx, ctx.options.remove.campaign as string | undefined);
          if (!camp) return { content: 'No campaign found for this channel.', ephemeral: true };
          if (!isAdmin && !(camp.gm_ids ?? []).includes(actor) && (ctx.options.remove.user as string) !== actor)
            return { content: `Only a GM of **${camp.name}** can remove another player.`, ephemeral: true };

          const target = ctx.options.remove.user as string;
          await scribe.removePlayer(camp.slug, target, actor);
          return { content: `Removed <@${target}> from **${camp.name}**.`, ephemeral: true };
        }

        case 'list': {
          const camp = await this.resolve(ctx, ctx.options.list.campaign as string | undefined);
          if (!camp) return { content: 'No campaign found for this channel.', ephemeral: true };
          return {
            embeds: [
              { title: `${camp.name} - players`, description: this.roster(camp), color: 0x8a5cf6, footer: { text: 'scribe' } }
            ],
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
